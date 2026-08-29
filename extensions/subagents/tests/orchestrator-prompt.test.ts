/**
 * The orchestrator prompt and the one user file that shapes it.
 *
 * `orchestratorPrompt()` is module-private, so these tests drive it through the
 * only path that injects it — `before_agent_start` — with `PI_CODING_AGENT_DIR`
 * pointed at a fresh temp directory per test, the same isolation
 * `tests/wiring.test.ts` uses to vary settings. The bundled `orchestrator.md` is
 * read from the tree rather than restated here, so these assertions cannot
 * drift when the guidance text is edited.
 *
 * Composition: `~/.pi/agent/orchestrator.md`, when non-empty, is
 * **prepended** to the bundled prompt — user identity first, framework
 * mechanics always after, joined by a single blank line.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import subagents from "../index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundled = readFileSync(join(here, "..", "orchestrator.md"), "utf-8").trim();

/**
 * Install an extension with the agent directory pointed at a fresh scratch dir
 * holding these files, and hand back the guidance it injects, turn by turn.
 *
 * `loadSettings` runs at factory time and `orchestratorPrompt` at handler time,
 * so the agent directory must be swapped *before* `subagents(pi)` — which is
 * also why each test gets its own harness rather than reusing one.
 */
function withAgentFiles(files: Record<string, string> = {}) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "subagent-orchestrator-"));
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(dir, name), text);
	}
	process.env.PI_CODING_AGENT_DIR = dir;
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
	};
	subagents(pi);
	return {
		dir,
		/** The guidance this turn, after asserting the injection shape it rode in on. */
		async guidance(): Promise<string> {
			const result = await handlers.get("before_agent_start")!({ systemPrompt: "SP" }, { hasUI: false });
			// `SP\n\n<guidance>` is the contract: the prompt is appended, never spliced.
			assert.ok(
				typeof result?.systemPrompt === "string" && result.systemPrompt.startsWith("SP\n\n"),
				`expected guidance appended to the system prompt, got ${JSON.stringify(result)}`,
			);
			return result.systemPrompt.slice("SP\n\n".length);
		},
		restore() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		},
	};
}

test("with no user file the bundled prompt is injected verbatim", async () => {
	const h = withAgentFiles();
	try {
		assert.equal(await h.guidance(), bundled);
	} finally {
		h.restore();
	}
});

test("a non-empty user file is prepended to the bundled prompt", async () => {
	const h = withAgentFiles({ "orchestrator.md": "you are patchbay; brief lanes with collisions" });
	try {
		assert.equal(await h.guidance(), `you are patchbay; brief lanes with collisions\n\n${bundled}`);
	} finally {
		h.restore();
	}
});

test("an absent or whitespace-only user file contributes nothing", async () => {
	const h = withAgentFiles({ "orchestrator.md": " \n\t\n" });
	try {
		assert.equal(await h.guidance(), bundled);
	} finally {
		h.restore();
	}
});

test("the pieces are joined by exactly one blank line, however the file ends", async () => {
	// The user file carries trailing whitespace, so a naive concat would double
	// the separator; the join must trim each piece first.
	const h = withAgentFiles({ "orchestrator.md": "identity\n\n  \n" });
	try {
		const guidance = await h.guidance();
		assert.equal(guidance, `identity\n\n${bundled}`);
		assert.ok(!guidance.includes("\n\n\n"), "a doubled separator between pieces");
	} finally {
		h.restore();
	}
});

test("the user file is re-read on each turn, so edits apply without a reload", async () => {
	const h = withAgentFiles({ "orchestrator.md": "first identity" });
	try {
		assert.equal(await h.guidance(), `first identity\n\n${bundled}`);
		writeFileSync(join(h.dir, "orchestrator.md"), "second identity");
		assert.equal(await h.guidance(), `second identity\n\n${bundled}`);
	} finally {
		h.restore();
	}
});

test("the bundled prompt still teaches model choice", async () => {
	// Only the section heading is pinned: the wording may be refined, but the
	// model-choice guidance must not be deleted by accident. This test is
	// independent of the harness above — it reads the file directly via
	// `bundled` — so it survives changes to that harness.
	assert.ok(
		bundled.includes("## Matching the model to the work"),
		"orchestrator.md lost its model-choice section",
	);
});

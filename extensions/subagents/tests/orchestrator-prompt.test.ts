/**
 * The orchestrator prompt and the three user files that shape it.
 *
 * `orchestratorPrompt()` is module-private, so these tests drive it through the
 * only path that injects it — `before_agent_start` — with `PI_CODING_AGENT_DIR`
 * pointed at a fresh temp directory per test, the same isolation
 * `tests/wiring.test.ts` uses to vary settings. The bundled `orchestrator.md` is
 * read from the tree rather than restated here, so these assertions cannot
 * drift when the guidance text is edited.
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

test("with no user files the bundled prompt is injected verbatim", async () => {
	const h = withAgentFiles();
	try {
		assert.equal(await h.guidance(), bundled);
	} finally {
		h.restore();
	}
});

test("a non-empty wholesale copy replaces the bundled prompt", async () => {
	const h = withAgentFiles({ "subagents-orchestrator.md": "custom guidance" });
	try {
		assert.equal(await h.guidance(), "custom guidance");
	} finally {
		h.restore();
	}
});

test("a head overlay is prepended to the bundled prompt", async () => {
	const h = withAgentFiles({ "subagents-orchestrator-head.md": "HEAD" });
	try {
		assert.equal(await h.guidance(), `HEAD\n\n${bundled}`);
	} finally {
		h.restore();
	}
});

test("a tail overlay is appended to the bundled prompt", async () => {
	const h = withAgentFiles({ "subagents-orchestrator-tail.md": "TAIL" });
	try {
		assert.equal(await h.guidance(), `${bundled}\n\nTAIL`);
	} finally {
		h.restore();
	}
});

test("head and tail compose around a wholesale copy, joined by blank lines", async () => {
	// Synthetic base text, so the composition — and only the composition — is
	// what is under test here: one blank line between pieces, never two.
	const h = withAgentFiles({
		"subagents-orchestrator-head.md": "HEAD",
		"subagents-orchestrator.md": "BASE",
		"subagents-orchestrator-tail.md": "TAIL",
	});
	try {
		const guidance = await h.guidance();
		assert.equal(guidance, "HEAD\n\nBASE\n\nTAIL");
		assert.ok(!guidance.includes("\n\n\n"), "a doubled separator between pieces");
	} finally {
		h.restore();
	}
});

test("absent or whitespace-only overlay files contribute nothing", async () => {
	// The overlays are whitespace-only, and the wholesale copy is too — so all
	// three fall away and the result is exactly the bundled prompt.
	const h = withAgentFiles({
		"subagents-orchestrator-head.md": " \n\t\n",
		"subagents-orchestrator.md": "\n  \n",
		"subagents-orchestrator-tail.md": "  ",
	});
	try {
		assert.equal(await h.guidance(), bundled);
	} finally {
		h.restore();
	}
});

test("every file is re-read on each turn, so edits apply without a reload", async () => {
	const h = withAgentFiles({ "subagents-orchestrator-tail.md": "first tail" });
	try {
		assert.equal(await h.guidance(), `${bundled}\n\nfirst tail`);
		writeFileSync(join(h.dir, "subagents-orchestrator-tail.md"), "second tail");
		assert.equal(await h.guidance(), `${bundled}\n\nsecond tail`);
	} finally {
		h.restore();
	}
});

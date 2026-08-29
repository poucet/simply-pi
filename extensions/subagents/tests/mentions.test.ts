/**
 * Whole-line `@path` mention expansion (mentions.ts).
 *
 * Unit tests drive `expandMentions` against a scratch tree, plus two wiring
 * tests at the bottom: one through persona discovery (personas.ts) and one
 * through the orchestrator prompt injection (index.ts), both with the agent
 * directory pointed at a fresh temp dir so the user's real `~/.pi/agent` is
 * never read. The semantics that matter most are pinned here: whole-line-only
 * grammar, resolution against the mentioning file's directory, and fail-silent
 * includes of absent targets.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import subagents from "../index.ts";
import { expandMentions, resolveMentionPath } from "../mentions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundled = readFileSync(join(here, "..", "orchestrator.md"), "utf-8").trim();

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "subagents-mentions-"));
}

/** Expand the text of a freshly written file, resolving its mentions from its own directory. */
function expandFile(dir: string, name: string, text: string) {
	const file = join(dir, name);
	writeFileSync(file, text);
	return expandMentions(text, dir, file);
}

// --- grammar ---------------------------------------------------------------

test("a whole-line mention is replaced by the target's content", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "part.md"), "INCLUDED");
		const { text } = expandFile(dir, "main.md", "before\n@part.md\nafter");
		assert.equal(text, "before\nINCLUDED\nafter");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an inline mention stays literal text", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "part.md"), "INCLUDED");
		const { text } = expandFile(
			dir,
			"main.md",
			"see @part.md mid-sentence\nsecond@part.md too\n  @part.md indented",
		);
		// None of these is a whole line that is only the mention, so none expand.
		assert.equal(text, "see @part.md mid-sentence\nsecond@part.md too\n  @part.md indented");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a bare @ is not a mention", () => {
	const dir = scratch();
	try {
		const { text, skipped } = expandFile(dir, "main.md", "reply @ them\n@");
		assert.equal(text, "reply @ them\n@");
		assert.equal(skipped.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- resolution ------------------------------------------------------------

test("relative paths resolve against the mentioning file's directory", () => {
	const dir = scratch();
	try {
		const nested = join(dir, "shared");
		mkdirSync(nested);
		writeFileSync(join(nested, "part.md"), "SHARED");
		// The mention lives in shared/main.md, so bare @part.md finds shared/part.md.
		const { text } = expandFile(nested, "main.md", "@part.md");
		assert.equal(text, "SHARED");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("absolute paths resolve as-is", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "part.md"), "ABSOLUTE");
		const { text } = expandFile(dir, "main.md", `@${join(dir, "part.md")}`);
		assert.equal(text, "ABSOLUTE");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("~/ paths expand to home", () => {
	const dir = scratch();
	const home = join(dir, "home");
	mkdirSync(join(home, "agents"), { recursive: true });
	const previous = process.env.HOME;
	try {
		process.env.HOME = home;
		// The resolution helper, directly.
		assert.equal(resolveMentionPath("~", "/anywhere"), home);
		assert.equal(resolveMentionPath("~/agents/shared.md", "/anywhere"), join(home, "agents", "shared.md"));
		// And end to end: a mention of ~/... pulls in a file under the fake home.
		writeFileSync(join(home, "agents", "shared.md"), "FROM HOME");
		const { text } = expandFile(dir, "main.md", "@~/agents/shared.md");
		assert.equal(text, "FROM HOME");
	} finally {
		process.env.HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- the load-bearing semantic: absent targets fail silent -----------------

test("a missing target contributes nothing and leaves no blank line behind", () => {
	const dir = scratch();
	try {
		const { text, skipped } = expandFile(dir, "main.md", "a\n@nope.md\nb");
		assert.equal(text, "a\nb");
		assert.ok(!text.includes("nope"), "the failed mention must not appear in the result");
		assert.equal(skipped.length, 1);
		assert.equal(skipped[0], join(dir, "nope.md"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an emptied mention slot closes up instead of accordioning blank lines", () => {
	const dir = scratch();
	try {
		const { text } = expandFile(dir, "main.md", "a\n\n@nope.md\n\nb");
		assert.equal(text, "a\n\nb");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a whole file of only missing mentions expands to empty text", () => {
	const dir = scratch();
	try {
		const { text } = expandFile(dir, "main.md", "@nope.md");
		assert.equal(text, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- recursion, cycles, dedup, depth ----------------------------------------

test("mentions inside an included file expand too, against its own directory", () => {
	const dir = scratch();
	try {
		const nested = join(dir, "nested");
		mkdirSync(nested);
		// mid.md lives in nested/, so its @leaf.md must resolve to nested/leaf.md —
		// not the top-level leaf.md, proving resolution follows the includer.
		writeFileSync(join(dir, "leaf.md"), "WRONG LEAF");
		writeFileSync(join(nested, "leaf.md"), "NESTED LEAF");
		writeFileSync(join(nested, "mid.md"), "@leaf.md\nMID");
		const { text } = expandFile(dir, "main.md", "@nested/mid.md");
		assert.equal(text, "NESTED LEAF\nMID");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cycle terminates with each file contributing once", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "a.md"), "@b.md\nA");
		writeFileSync(join(dir, "b.md"), "@a.md\nB");
		const file = join(dir, "a.md");
		const { text } = expandMentions("@b.md\nA", dir, file);
		assert.equal(text, "B\nA");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a file mentioned from two places contributes once per prompt", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "a.md"), "@b.md\n@c.md\nA");
		writeFileSync(join(dir, "b.md"), "@c.md\nB");
		writeFileSync(join(dir, "c.md"), "C");
		const file = join(dir, "a.md");
		const { text } = expandMentions("@b.md\n@c.md\nA", dir, file);
		// c.md arrives via b.md, so a.md's own @c.md is the deduped one: C once.
		assert.equal(text, "C\nB\nA");
		assert.equal(text.match(/C/g)?.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a chain deeper than the cap is cut", () => {
	const dir = scratch();
	try {
		// f0 @s f1 @s f2 ... f8. Five levels of inclusion past the root land
		// (f1..f5); f6 is the first beyond the cap and is skipped, loudly enough
		// to be discoverable in `skipped`.
		for (let i = 0; i <= 8; i++) {
			writeFileSync(join(dir, `f${i}.md`), i === 8 ? "F8" : `@f${i + 1}.md\nF${i}`);
		}
		const file = join(dir, "f0.md");
		const { text, skipped } = expandMentions("@f1.md\nF0", dir, file);
		assert.ok(text.includes("F5"), "the fifth level of inclusion is still in");
		assert.ok(!text.includes("F6"), "the sixth level is cut");
		assert.ok(skipped.includes(join(dir, "f6.md")), "the cut is discoverable in skipped");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- symlinks and unreadable targets ----------------------------------------

test("a symlinked target is followed", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "real.md"), "REAL");
		symlinkSync(join(dir, "real.md"), join(dir, "alias.md"));
		const { text } = expandFile(dir, "main.md", "@alias.md");
		assert.equal(text, "REAL");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a file and a symlink to it are one include, not two", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "real.md"), "REAL");
		symlinkSync(join(dir, "real.md"), join(dir, "alias.md"));
		const { text } = expandFile(dir, "main.md", "@real.md\n@alias.md");
		assert.equal(text, "REAL");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an exists-but-unreadable target is skipped and recorded", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "locked.md"), "LOCKED");
		chmodSync(join(dir, "locked.md"), 0o000);
		const { text, skipped } = expandFile(dir, "main.md", "a\n@locked.md\nb");
		assert.equal(text, "a\nb");
		assert.ok(skipped.includes(join(dir, "locked.md")), "the unreadable skip is discoverable");
	} finally {
		// Make it removable again before tearing down the tree.
		chmodSync(join(dir, "locked.md"), 0o644);
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- wiring: personas -------------------------------------------------------

import { discoverPersonas } from "../personas.ts";

function personaDir(): string {
	const dir = scratch();
	mkdirSync(join(dir, "agents"), { recursive: true });
	return dir;
}

function withAgentDir(dir: string) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	};
}

test("persona bodies are mention-expanded at load time, against the persona file's directory", () => {
	const dir = personaDir();
	try {
		mkdirSync(join(dir, "agents", "shared"));
		writeFileSync(
			join(dir, "agents", "shared", "role-body.md"),
			"You review the change in your working directory.",
		);
		writeFileSync(
			join(dir, "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: reviews\n---\n@shared/role-body.md\nBe strict.",
		);
		const restore = withAgentDir(dir);
		try {
			const personas = discoverPersonas("/nowhere", false);
			const reviewer = personas.find((p) => p.name === "reviewer");
			assert.ok(reviewer, "persona discovered");
			assert.equal(
				reviewer!.systemPrompt,
				"You review the change in your working directory.\nBe strict.",
			);
		} finally {
			restore();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a persona mention of an optional per-repo hook fails silent", () => {
	const dir = personaDir();
	try {
		writeFileSync(
			join(dir, "agents", "generic.md"),
			"---\nname: generic\n---\nGeneric role guidance.\n@.pi/PROJECT.md\nEnds here.",
		);
		const restore = withAgentDir(dir);
		try {
			const [generic] = discoverPersonas("/nowhere", false);
			assert.ok(generic, "persona discovered");
			// The optional hook does not exist, so it contributes nothing — not
			// an error, not a blank line.
			assert.equal(generic.systemPrompt, "Generic role guidance.\nEnds here.");
		} finally {
			restore();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- wiring: orchestrator prompt --------------------------------------------

/**
 * Drive `orchestratorPrompt()` the only way it can be driven — through
 * `before_agent_start` — with `PI_CODING_AGENT_DIR` pointed at a scratch dir,
 * the same harness `tests/orchestrator-prompt.test.ts` uses. `subagents(pi)`
 * runs at handler-registration time, after the env is swapped.
 */
function withAgentFiles(files: Record<string, string> = {}) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "subagents-mentions-orch-"));
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
			assert.ok(
				typeof result?.systemPrompt === "string" && result.systemPrompt.startsWith("SP\n\n"),
				`expected guidance appended to the system prompt, got ${JSON.stringify(result)}`,
			);
			return result.systemPrompt.slice("SP\n\n".length);
		},
		restore() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a user orchestrator file expands its mentions against the agent dir", async () => {
	const h = withAgentFiles({
		// The shared material lives beside the user file, in the agent dir.
		"shared-identity.md": "IDENTITY OVERLAY",
		"orchestrator.md": "@shared-identity.md",
	});
	try {
		const guidance = await h.guidance();
		assert.ok(guidance.includes("IDENTITY OVERLAY"), "user file expanded its mention");
		assert.ok(guidance.includes(bundled), "the bundled base rode along");
		assert.ok(
			guidance === `IDENTITY OVERLAY\n\n${bundled}`,
			`expected the expanded user file prepended to the bundled prompt, got:\n${guidance}`,
		);
	} finally {
		h.restore();
	}
});

test("a user orchestrator file's mention of an optional file fails silent", async () => {
	const h = withAgentFiles({
		"orchestrator.md": "IDENTITY\n@optional-hook.md",
	});
	try {
		const guidance = await h.guidance();
		assert.equal(guidance, `IDENTITY\n\n${bundled}`);
	} finally {
		h.restore();
	}
});

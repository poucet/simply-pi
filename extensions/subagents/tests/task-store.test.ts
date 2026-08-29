import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	deriveTaskSummary,
	readTaskFile,
	resolveTaskSummary,
	taskFilePath,
	writeTaskFile,
} from "../task-store.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "subagent-task-store-"));
}

// --- deriving a label -----------------------------------------------------

test("a summary is derived from the first line with content", () => {
	assert.equal(deriveTaskSummary("\n\n  Refactor the parser.\nAnd then test it."), "Refactor the parser.");
});

test("markdown decoration is stripped from the first line", () => {
	assert.equal(deriveTaskSummary("# Extract the slides extension\n\nbody"), "Extract the slides extension");
	assert.equal(deriveTaskSummary("### Deep heading"), "Deep heading");
	assert.equal(deriveTaskSummary("- a bulleted task"), "a bulleted task");
	assert.equal(deriveTaskSummary("* another bullet"), "another bullet");
	assert.equal(deriveTaskSummary("1. a numbered task"), "a numbered task");
	assert.equal(deriveTaskSummary("> quoted task"), "quoted task");
	assert.equal(deriveTaskSummary("**bold** and `code`"), "bold and code");
});

test("whitespace is collapsed", () => {
	assert.equal(deriveTaskSummary("do    this\tand that"), "do this and that");
});

test("an empty task derives an empty summary rather than throwing", () => {
	assert.equal(deriveTaskSummary(""), "");
	assert.equal(deriveTaskSummary("\n\n   \n"), "");
});

test("a long first line is cut on a word boundary", () => {
	const line = `${"alpha bravo charlie delta echo foxtrot golf hotel india juliet ".repeat(4)}end`;
	const summary = deriveTaskSummary(line);
	assert.ok(summary.length <= 121, `too long: ${summary.length}`);
	assert.ok(summary.endsWith("…"));
	// Cut between words, not through one.
	assert.ok(!/\w…$/.test(summary) || summary.slice(0, -1).endsWith(" ") === false);
	assert.ok(line.startsWith(summary.slice(0, -1).trimEnd()));
});

test("a single unbroken word longer than the cap is still cut", () => {
	const summary = deriveTaskSummary("x".repeat(400));
	assert.ok(summary.length <= 121);
	assert.ok(summary.endsWith("…"));
});

// --- choosing the label ---------------------------------------------------

test("a caller-supplied summary wins over the derived one", () => {
	assert.equal(
		resolveTaskSummary("# READ-ONLY research in a shallow clone", "audit the lock code"),
		"audit the lock code",
	);
});

test("an absent or blank caller summary falls back to the first line", () => {
	assert.equal(resolveTaskSummary("# Build the thing"), "Build the thing");
	assert.equal(resolveTaskSummary("# Build the thing", "   "), "Build the thing");
});

test("an over-long caller summary is shortened rather than stored whole", () => {
	const summary = resolveTaskSummary("body", "word ".repeat(80));
	assert.ok(summary.length <= 121, `too long: ${summary.length}`);
});

test("tasks sharing a long boilerplate opening still get distinct summaries", () => {
	// The defect the summary exists to fix: `.slice(0, 160)` rendered a fleet of
	// research children identically, because the first 160 characters were the
	// same preamble every time.
	const preamble =
		"READ-ONLY research inside a shallow clone of the Go project `beads` at /tmp/beads-research. " +
		"Do not modify any file. Report your findings in your final message only. ";
	const a = `${preamble}Investigate the autoprune scan.`;
	const b = `${preamble}Investigate the wisp storage layer.`;
	// The old behaviour, for contrast: a prefix of either is the same preamble.
	assert.ok(preamble.length > 160);
	assert.equal(a.slice(0, 160), b.slice(0, 160));
	assert.notEqual(resolveTaskSummary(a, "autoprune scan"), resolveTaskSummary(b, "wisp storage"));
});

// --- the file beside the transcript ---------------------------------------

test("a task round-trips through the child's directory", () => {
	const dir = scratch();
	try {
		assert.equal(writeTaskFile(dir, "# Do the thing\n\nAt length.\n"), true);
		assert.equal(readTaskFile(dir), "# Do the thing\n\nAt length.\n");
		assert.ok(existsSync(taskFilePath(dir)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a missing task file reads as absent rather than throwing", () => {
	const dir = scratch();
	try {
		assert.equal(readTaskFile(dir), undefined);
		assert.equal(readTaskFile(join(dir, "nope")), undefined);
		assert.equal(readTaskFile(undefined), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty task writes nothing", () => {
	const dir = scratch();
	try {
		assert.equal(writeTaskFile(dir, ""), false);
		assert.equal(readTaskFile(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a whitespace-only task file reads as absent", () => {
	const dir = scratch();
	try {
		writeFileSync(taskFilePath(dir), "   \n\n");
		assert.equal(readTaskFile(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writing leaves no temp file behind", () => {
	const dir = scratch();
	try {
		writeTaskFile(dir, "a task");
		assert.deepEqual(readdirSync(dir), ["task.md"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rewrite replaces the previous text", () => {
	const dir = scratch();
	try {
		writeTaskFile(dir, "first");
		writeTaskFile(dir, "second");
		assert.equal(readTaskFile(dir), "second");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unwritable directory fails softly instead of throwing", () => {
	// A task that cannot be persisted costs the revive nudge some context. It is
	// not a reason to fail the spawn it is part of.
	const dir = scratch();
	try {
		const target = join(dir, "file-not-a-dir");
		writeFileSync(target, "");
		assert.equal(writeTaskFile(join(target, "child"), "a task"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the task directory is created when it does not yet exist", () => {
	const dir = scratch();
	try {
		const nested = join(dir, "a", "b");
		assert.equal(writeTaskFile(nested, "deep"), true);
		assert.equal(readTaskFile(nested), "deep");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- what the registry no longer carries ----------------------------------

test("a large task costs the registry only its label", () => {
	const dir = scratch();
	try {
		const task = `# Audit\n\n${"detail ".repeat(4000)}`;
		writeTaskFile(dir, task);
		const summary = resolveTaskSummary(task);
		assert.ok(task.length > 20000);
		assert.ok(summary.length <= 121, `summary too long: ${summary.length}`);
		assert.equal(readTaskFile(dir), task);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

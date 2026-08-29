import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_NOTE_CHARS, appendNote, readNotes } from "../notes.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "subagent-notes-"));
}

test("readNotes returns empty for a missing file", () => {
	const dir = scratch();
	try {
		assert.equal(readNotes(join(dir, "nope.md")), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appendNote creates the file and its directory", () => {
	const dir = scratch();
	const path = join(dir, "deep", "SHARED_NOTES.md");
	try {
		appendNote(path, "parent", "first decision");
		const content = readNotes(path);
		assert.match(content, /## parent — /);
		assert.match(content, /first decision/);
		assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appendNote appends instead of rewriting (S11)", () => {
	const dir = scratch();
	const path = join(dir, "SHARED_NOTES.md");
	try {
		appendNote(path, "parent", "one");
		// Simulate a sibling process writing between our read and our write.
		writeFileSync(path, `${readNotes(path)}\n## sibling — now\n\nfrom another process\n`);
		appendNote(path, "parent", "two");
		const content = readNotes(path);
		assert.match(content, /from another process/);
		assert.match(content, /one/);
		assert.match(content, /two/);
		assert.ok(content.indexOf("one") < content.indexOf("from another process"));
		assert.ok(content.indexOf("from another process") < content.indexOf("two"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appendNote rejects empty text and truncates long text", () => {
	const dir = scratch();
	const path = join(dir, "SHARED_NOTES.md");
	try {
		assert.throws(() => appendNote(path, "parent", "   "), /requires text/);
		const section = appendNote(path, "parent", "x".repeat(MAX_NOTE_CHARS + 500));
		assert.equal(section.split("x").length - 1, MAX_NOTE_CHARS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

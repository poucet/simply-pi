/**
 * Identity: uuids, not names, and a session fact rather than an env var.
 *
 * Three questions used to be answered by `PI_SUBAGENT_NAME` alone: "am I a
 * subagent", "which subagent am I", and "should I register a UI". They have
 * different lifetimes and different truth sources, and conflating them broke as
 * soon as nesting was allowed — a display name is chosen by the spawning model
 * and is unique only inside one parent, so two parents can each have a
 * `reviewer`.
 *
 * The split: `PI_SUBAGENT=1` is a boot flag with no identity in it, because the
 * UI guard has to run before a session exists. Everything else is read off the
 * session, where it survives a resume and a revive.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ANSWERS_ENV,
	NOTES_ENV,
	PARENT_SESSION_ENV,
	SUBAGENT_BOOT_ENV,
	SUBAGENT_LABEL_ENV,
	isSubagentBoot,
	readSessionHeader,
	sessionIdentity,
} from "../identity.ts";

function ctxWith(header: any, sessionId?: string, sessionFile?: string) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getHeader: () => header,
		},
	};
}

// --- the boot flag --------------------------------------------------------

test("the boot flag is one bit, and it is the only pre-session signal", () => {
	assert.equal(isSubagentBoot({}), false);
	assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: "1" }), true);
	assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: "yes" }), true);
});

test("an explicitly falsy flag means no", () => {
	// Otherwise `PI_SUBAGENT=0` left in a shell profile would silently disable
	// every subagent UI in every session.
	for (const value of ["", "0", "false", "False"]) {
		assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: value }), false, value);
	}
});

test("the legacy name variable still boots as a child", () => {
	// A child launched by a parent that predates the boot flag must not suddenly
	// start painting into the terminal.
	assert.equal(isSubagentBoot({ [SUBAGENT_LABEL_ENV]: "worker" }), true);
});

test("no identity is derivable from the boot environment", () => {
	// The parent uuid and the notes/answers paths are plumbing, not identity, and
	// none of them makes a process a subagent by itself.
	assert.equal(isSubagentBoot({ [PARENT_SESSION_ENV]: "parent-uuid" }), false);
	assert.equal(isSubagentBoot({ [NOTES_ENV]: "/n" }), false);
	assert.equal(isSubagentBoot({ [ANSWERS_ENV]: "/a" }), false);
});

// --- identity from the session -------------------------------------------

test("a root session knows its uuid and has no parent", () => {
	const identity = sessionIdentity(
		ctxWith({ type: "session", id: "root-uuid", cwd: "/w" }, "root-uuid", "/s/root.jsonl"),
		{},
	);
	assert.equal(identity.sessionId, "root-uuid");
	assert.equal(identity.sessionFile, "/s/root.jsonl");
	assert.equal(identity.isChild, false);
	assert.equal(identity.parentSessionFile, undefined);
});

test("being a child is a session fact, not an environment variable", () => {
	const identity = sessionIdentity(
		ctxWith(
			{ type: "session", id: "child-uuid", cwd: "/w", parentSession: "/s/parent.jsonl" },
			"child-uuid",
		),
		// Deliberately no env at all: a revived child resumes its own session file
		// in a process the original parent never configured, and the header is the
		// only thing that still knows the truth at that point.
		{},
	);
	assert.equal(identity.isChild, true);
	assert.equal(identity.sessionId, "child-uuid");
	assert.equal(identity.parentSessionFile, "/s/parent.jsonl");
});

test("the parent uuid comes from the spawn environment, the parent path from the header", () => {
	const identity = sessionIdentity(
		ctxWith(
			{ type: "session", id: "child-uuid", parentSession: "/s/parent.jsonl" },
			"child-uuid",
		),
		{ [PARENT_SESSION_ENV]: "parent-uuid" },
	);
	assert.equal(identity.parentSessionId, "parent-uuid");
	assert.equal(identity.parentSessionFile, "/s/parent.jsonl");
});

test("a header that predates the scheme still reads as a child from the env", () => {
	const identity = sessionIdentity(ctxWith({ type: "session", id: "c" }, "c"), {
		[PARENT_SESSION_ENV]: "parent-uuid",
	});
	assert.equal(identity.isChild, true);
});

test("identity never throws, whatever the context is", () => {
	// Called on every spawn and every lifecycle write, including during a
	// shutdown that has already torn the session down.
	for (const ctx of [
		undefined,
		{},
		{ sessionManager: undefined },
		{
			sessionManager: {
				getSessionId: () => {
					throw new Error("session is gone");
				},
				getHeader: () => {
					throw new Error("session is gone");
				},
			},
		},
	]) {
		const identity = sessionIdentity(ctx, {});
		assert.equal(identity.isChild, false);
		assert.equal(identity.sessionId, undefined);
	}
});

// --- reading a header back off disk ---------------------------------------

test("a seeded child session header yields its uuid and parent", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-identity-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "child-uuid",
			cwd: "/w",
			parentSession: "/s/parent.jsonl",
		})}\n${JSON.stringify({ type: "message", id: "e1" })}\n`,
	);
	const header = readSessionHeader(file);
	assert.equal(header?.id, "child-uuid");
	assert.equal(header?.parentSession, "/s/parent.jsonl");
});

test("only the first line is read, however large the transcript is", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-identity-"));
	const file = join(dir, "session.jsonl");
	const filler = `${JSON.stringify({ type: "message", text: "x".repeat(50_000) })}\n`;
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "u" })}\n${filler.repeat(20)}`);
	assert.equal(readSessionHeader(file)?.id, "u");
});

test("a missing, empty or non-session file yields nothing rather than throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-identity-"));
	assert.equal(readSessionHeader(join(dir, "absent.jsonl")), undefined);

	const empty = join(dir, "empty.jsonl");
	writeFileSync(empty, "");
	assert.equal(readSessionHeader(empty), undefined);

	const garbage = join(dir, "garbage.jsonl");
	writeFileSync(garbage, "{ truncated\n");
	assert.equal(readSessionHeader(garbage), undefined);

	const wrong = join(dir, "wrong.jsonl");
	writeFileSync(wrong, `${JSON.stringify({ type: "message", id: "e1" })}\n`);
	assert.equal(readSessionHeader(wrong), undefined);
});

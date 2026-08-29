/**
 * Reload survival.
 *
 * The bug these cover cost three separate batches of delegated work: pressing
 * `/reload` killed every child. The policy decision and the record round-trip
 * are pure, so both are checked here without a session or a child process.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HIBERNATE_ENTRY_TYPE,
	buildPayload,
	collectRecords,
	hasHibernateEntry,
	needsRevive,
	parseRecord,
	shutdownPolicy,
	toRecord,
} from "../hibernate.ts";
import { emptyUsage, type ManagedAgent } from "../types.ts";

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "reviewer-abc123",
		name: "reviewer",
		task: "review the diff",
		persona: "reviewer",
		cwd: "/tmp/worktree",
		contextMode: "forked",
		status: "running",
		model: "anthropic/claude-sonnet-4-5",
		startedAt: 1_000,
		usage: { ...emptyUsage(), turns: 3, cost: 0.25 },
		output: "so far so good",
		activity: [{ at: 1, text: "$ ls" }],
		sessionFile: "/tmp/sessions/p/reviewer-abc123/session.jsonl",
		sessionDir: "/tmp/sessions/p/reviewer-abc123",
		promptFile: "/tmp/sessions/p/reviewer-abc123/system-prompt.md",
		launch: { model: "anthropic/claude-sonnet-4-5", notesPath: "/tmp/sessions/p/SHARED_NOTES.md" },
		busy: true,
		...overrides,
	};
}

// --- policy ---------------------------------------------------------------

test("only quitting kills the children", () => {
	assert.equal(shutdownPolicy("quit"), "stop");
	for (const reason of ["reload", "new", "resume", "fork"]) {
		assert.equal(shutdownPolicy(reason), "hibernate", reason);
	}
});

test("an unknown or missing reason hibernates rather than killing", () => {
	assert.equal(shutdownPolicy(undefined), "hibernate");
	assert.equal(shutdownPolicy("something-new-in-pi"), "hibernate");
});

// --- serialization --------------------------------------------------------

test("a record round-trips through JSON unchanged", () => {
	const record = toRecord(agent());
	const back = parseRecord(JSON.parse(JSON.stringify(record)));
	assert.deepEqual(back, record);
});

test("the record keeps everything a revive needs", () => {
	const record = toRecord(agent());
	// These four are what `--session`, `--session-dir` and the child env are
	// built from; losing any of them means the child cannot be resumed.
	assert.equal(record.sessionFile, "/tmp/sessions/p/reviewer-abc123/session.jsonl");
	assert.equal(record.sessionDir, "/tmp/sessions/p/reviewer-abc123");
	assert.equal(record.cwd, "/tmp/worktree");
	assert.equal(record.launch.notesPath, "/tmp/sessions/p/SHARED_NOTES.md");
	assert.equal(record.usage.turns, 3);
});

test("the launch spec survives, including a tool allowlist", () => {
	const record = toRecord(
		agent({ launch: { model: "m", thinking: "medium", tools: ["read", "bash"], notesPath: "/n" } }),
	);
	const back = parseRecord(JSON.parse(JSON.stringify(record)))!;
	assert.deepEqual(back.launch, {
		model: "m",
		thinking: "medium",
		tools: ["read", "bash"],
		notesPath: "/n",
	});
});

test("parseRecord rejects records that cannot be revived or read", () => {
	assert.equal(parseRecord(undefined), undefined);
	assert.equal(parseRecord("nope"), undefined);
	assert.equal(parseRecord({ name: "x", sessionFile: "/f", sessionDir: "/d" }), undefined); // no id
	assert.equal(parseRecord({ id: "x", sessionFile: "/f", sessionDir: "/d" }), undefined); // no name
	assert.equal(parseRecord({ id: "x", name: "n", sessionDir: "/d" }), undefined); // no session file
});

test("parseRecord tolerates a record written by an older version", () => {
	const back = parseRecord({
		id: "a",
		name: "old",
		sessionFile: "/f",
		sessionDir: "/d",
		model: "legacy/model",
	})!;
	assert.equal(back.task, "");
	assert.equal(back.contextMode, "fresh");
	assert.equal(back.status, "hibernated");
	assert.deepEqual(back.usage, emptyUsage());
	// A record from before `launch` existed still knows which model to use.
	assert.equal(back.launch.model, "legacy/model");
});

test("a closed child is not written into the payload", () => {
	const payload = buildPayload([agent(), agent({ id: "gone", name: "gone", status: "closed" })]);
	assert.deepEqual(payload.agents.map((a) => a.name), ["reviewer"]);
	assert.equal(payload.version, 1);
});

// --- reading back ---------------------------------------------------------

const entry = (data: unknown) => ({ type: "custom", customType: HIBERNATE_ENTRY_TYPE, data });

test("collectRecords reads the newest entry and ignores earlier ones", () => {
	const records = collectRecords([
		entry(buildPayload([agent(), agent({ id: "b", name: "b" })])),
		{ type: "message", message: { role: "user" } },
		entry(buildPayload([agent({ id: "b", name: "b" })])),
	]);
	// The second reload had only one child left: closing one is not undone by
	// the older, larger entry.
	assert.deepEqual(records.map((r) => r.id), ["b"]);
});

test("collectRecords ignores unrelated custom entries and malformed payloads", () => {
	assert.deepEqual(collectRecords([]), []);
	assert.deepEqual(collectRecords([{ type: "custom", customType: "something-else", data: {} }]), []);
	assert.deepEqual(collectRecords([entry({ version: 1 })]), []);
	assert.deepEqual(collectRecords([entry({ agents: "not an array" })]), []);
});

test("collectRecords drops unusable records but keeps their siblings", () => {
	const good = toRecord(agent());
	const records = collectRecords([entry({ version: 1, at: 0, agents: [{ id: "broken" }, good] })]);
	assert.deepEqual(records.map((r) => r.id), [good.id]);
});

test("collectRecords deduplicates by agent id", () => {
	const good = toRecord(agent());
	const records = collectRecords([entry({ version: 1, at: 0, agents: [good, { ...good }] })]);
	assert.equal(records.length, 1);
});

test("hasHibernateEntry notices even an empty recorded set", () => {
	assert.equal(hasHibernateEntry([entry({ version: 1, at: 0, agents: [] })]), true);
	assert.equal(hasHibernateEntry([{ type: "message" }]), false);
});

// --- revive-vs-send decision ----------------------------------------------

test("needsRevive is about the process, not the label", () => {
	// Hibernated: no client at all.
	assert.equal(needsRevive({ status: "hibernated", client: undefined }), true);
	// Revived and running: sending must not spawn a second writer of one session.
	assert.equal(needsRevive({ status: "running", client: { running: true } }), false);
	// Alive but the process died underneath it: same treatment as hibernated.
	assert.equal(needsRevive({ status: "failed", client: { running: false } }), true);
	// Closed agents are gone; they are never brought back.
	assert.equal(needsRevive({ status: "closed", client: undefined }), false);
});

// --- session ownership ----------------------------------------------------

test("records belong to the session that wrote them", () => {
	const payload = buildPayload([agent()], "session-A");
	assert.equal(payload.sessionId, "session-A");
	// A reload: same session, so the children come back.
	assert.equal(collectRecords([entry(payload)], "session-A").length, 1);
	// A fork inherits the entries but must not claim children that another
	// session may still be running: two parents on one session file would
	// interleave two `pi` processes' writes.
	assert.deepEqual(collectRecords([entry(payload)], "session-B"), []);
});

test("a record without an owner is accepted by anyone", () => {
	// Written before `sessionId` existed; refusing it would silently drop the
	// children a reload was supposed to preserve.
	const payload = buildPayload([agent()]);
	assert.equal(payload.sessionId, undefined);
	assert.equal(collectRecords([entry(payload)], "session-A").length, 1);
});

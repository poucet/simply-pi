/**
 * Identity through the manager: uuids are the spine, names are labels.
 *
 * The tests that matter here are the ones about *ambiguity*. A display name is
 * chosen by the spawning model and reserved only inside one parent's manager, so
 * as soon as nesting exists two parents can each have a `reviewer`. Everything
 * that used to key on a name (mail, pending questions, hibernation records) has
 * to key on the session uuid instead, and a name may only ever be resolved
 * locally — inside the parent that coined it.
 *
 * The other half is the registry: it must be written on *every* lifecycle
 * transition, because the failure it exists to survive (`kill -9`) runs no
 * shutdown hook.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toRecord } from "../hibernate.ts";
import { SubagentManager } from "../manager.ts";
import { Registry } from "../registry.ts";
import { emptyUsage, type ManagedAgent } from "../types.ts";

function scratchRegistry(): Registry {
	return new Registry(join(mkdtempSync(join(tmpdir(), "subagent-mgr-reg-")), "registry.json"));
}

function manager(config: Record<string, unknown> = {}) {
	const mails: Array<{ name: string; kind: string }> = [];
	const m = new SubagentManager(
		{ onChange: () => {}, onMail: (name, kind) => mails.push({ name, kind }) },
		config as any,
	);
	return { m, mails };
}

/** A record pointing at a session file that really exists, so restore accepts it. */
function record(overrides: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-identity-mgr-"));
	const sessionFile = join(dir, "session.jsonl");
	const sessionId = String(overrides.sessionId ?? `uuid-${Math.random().toString(36).slice(2)}`);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: dir })}\n`,
	);
	return {
		id: "worker-1",
		sessionId,
		name: "worker",
		task: "do the thing",
		cwd: dir,
		contextMode: "forked",
		status: "running",
		sessionFile,
		sessionDir: dir,
		startedAt: 10,
		usage: { ...emptyUsage(), turns: 2 },
		output: "half done",
		launch: { notesPath: join(dir, "NOTES.md") },
		...overrides,
	} as any;
}

// --- uuid keying ----------------------------------------------------------

test("an agent is addressable by its session uuid", () => {
	const { m } = manager();
	const [agent] = m.restore([record({ sessionId: "uuid-1" })]);
	assert.equal(m.get("uuid-1")!.id, agent!.id);
	assert.equal(m.bySessionId("uuid-1")!.id, agent!.id);
});

test("a name resolves to a uuid, locally", () => {
	const { m } = manager();
	m.restore([record({ sessionId: "uuid-1", name: "reviewer" })]);
	assert.equal(m.resolveSessionId("reviewer"), "uuid-1");
	assert.equal(m.resolveSessionId("Reviewer"), "uuid-1");
	assert.equal(m.resolveSessionId("nobody"), undefined);
});

test("a uuid wins over a name that happens to collide with it", () => {
	// Pathological but cheap to make impossible: a child literally named after
	// another child's uuid must not shadow the real one.
	const { m } = manager();
	m.restore([
		record({ id: "a", sessionId: "uuid-1", name: "reviewer" }),
		record({ id: "b", sessionId: "uuid-2", name: "uuid-1" }),
	]);
	assert.equal(m.get("uuid-1")!.id, "a");
});

test("duplicate names across different parents are two distinct agents", () => {
	// The case that broke name keying: each parent reserves names only within
	// itself, so a tree can contain any number of `reviewer`s. They are told
	// apart by uuid, and each parent only ever resolves its own.
	const parentOne = manager();
	const parentTwo = manager();
	parentOne.m.restore([record({ id: "a", sessionId: "uuid-a", name: "reviewer" })]);
	parentTwo.m.restore([record({ id: "b", sessionId: "uuid-b", name: "reviewer" })]);

	assert.equal(parentOne.m.resolveSessionId("reviewer"), "uuid-a");
	assert.equal(parentTwo.m.resolveSessionId("reviewer"), "uuid-b");
	// Crucially, neither can reach the other's `reviewer` by name.
	assert.equal(parentOne.m.get("uuid-b"), undefined);
	assert.equal(parentTwo.m.get("uuid-a"), undefined);
});

test("mail is keyed by agent id, so same-named agents never cross-drain", () => {
	const parentOne = manager();
	const parentTwo = manager();
	const [one] = parentOne.m.restore([record({ id: "a", sessionId: "uuid-a", name: "reviewer" })]);
	const [two] = parentTwo.m.restore([record({ id: "b", sessionId: "uuid-b", name: "reviewer" })]);

	parentOne.m.mailbox.publish({
		kind: "final",
		agentId: one!.id,
		agentName: one!.name,
		content: "from parent one",
	});
	parentTwo.m.mailbox.publish({
		kind: "final",
		agentId: two!.id,
		agentName: two!.name,
		content: "from parent two",
	});

	assert.deepEqual(
		parentOne.m.mailbox.drain(one!.id).map((e) => e.content),
		["from parent one"],
	);
	// Draining one parent's `reviewer` left the other's alone.
	assert.equal(parentTwo.m.mailbox.size, 1);
});

test("a record round-trips its uuid and parentage", () => {
	const { m } = manager({ parentSessionId: "the-parent" });
	const [agent] = m.restore([record({ sessionId: "uuid-1", parentSessionId: "the-parent" })]);
	const round = toRecord(agent as ManagedAgent);
	assert.equal(round.sessionId, "uuid-1");
	assert.equal(round.parentSessionId, "the-parent");
	// And back again, unchanged.
	const second = manager();
	const [again] = second.m.restore([round as any]);
	assert.equal(again!.sessionId, "uuid-1");
	assert.equal(again!.parentSessionId, "the-parent");
});

test("a record with no uuid recovers it from the child's session header", () => {
	// Records written before the uuid spine existed still have a session file,
	// and that file has had an `id` in its header all along.
	const { m } = manager();
	const legacy = record({ sessionId: "uuid-in-header" });
	delete legacy.sessionId;
	const [agent] = m.restore([legacy]);
	assert.equal(agent!.sessionId, "uuid-in-header");
});

test("a restored agent inherits this parent's uuid when the record predates parentage", () => {
	const { m } = manager({ parentSessionId: "this-parent" });
	const legacy = record();
	delete legacy.parentSessionId;
	const [agent] = m.restore([legacy]);
	assert.equal(agent!.parentSessionId, "this-parent");
});

// --- the registry ---------------------------------------------------------

test("restoring writes the agent into the registry, keyed by uuid", () => {
	const registry = scratchRegistry();
	const { m } = manager({ registry, parentSessionId: "p" });
	m.restore([record({ sessionId: "uuid-1", name: "reviewer" })]);
	const [node] = registry.read().nodes;
	assert.equal(node!.sessionId, "uuid-1");
	assert.equal(node!.parentSessionId, "p");
	assert.equal(node!.name, "reviewer");
	// No process: a restore deliberately does not start one.
	assert.equal(node!.pid, undefined);
	assert.equal(node!.status, "hibernated");
});

test("every node records the directory its parent was working in", () => {
	// The only thing a *later, unrelated* pi can use to tell "these are the
	// children of the last run in this project" from "these belong to somewhere
	// else entirely": one registry file describes every tree on the machine, and a
	// child's own cwd is a worktree as often as not. Asserted against the real
	// manager rather than a test double, because a seam that overrode
	// `registryNode` would hide its removal.
	const registry = scratchRegistry();
	const { m } = manager({ registry, parentSessionId: "p", parentCwd: "/repo" });
	m.restore([record({ sessionId: "uuid-1" })]);
	assert.equal(registry.read().nodes[0]!.parentCwd, "/repo");

	// Adopting re-homes a node: whoever writes it is its parent now, so the next
	// cold start *in the adopting directory* finds it again.
	const adopted = scratchRegistry();
	const second = manager({ registry: adopted, parentSessionId: "q", parentCwd: "/elsewhere" });
	second.m.restore([record({ sessionId: "uuid-1" })]);
	assert.equal(adopted.read().nodes[0]!.parentCwd, "/elsewhere");
});

test("a manager with no parentCwd writes no parentCwd", () => {
	// Absent rather than guessed: `process.cwd()` here would scope a later
	// auto-restore to wherever the binary happened to be launched from.
	const registry = scratchRegistry();
	const { m } = manager({ registry });
	m.restore([record({ sessionId: "uuid-1" })]);
	assert.equal(registry.read().nodes[0]!.parentCwd, undefined);
});

test("a checkpoint writes every live agent", () => {
	const registry = scratchRegistry();
	const { m } = manager({ registry });
	m.restore([
		record({ id: "a", sessionId: "uuid-a", name: "one" }),
		record({ id: "b", sessionId: "uuid-b", name: "two" }),
	]);
	m.checkpoint();
	assert.deepEqual(registry.read().nodes.map((n) => n.sessionId).sort(), ["uuid-a", "uuid-b"]);
});

test("closing an agent removes it from the registry for good", async () => {
	const registry = scratchRegistry();
	const { m } = manager({ registry });
	m.restore([record({ sessionId: "uuid-1" })]);
	assert.equal(registry.read().nodes.length, 1);
	await m.close("uuid-1");
	assert.deepEqual(registry.read().nodes, []);
});

test("quitting persists the tree instead of discarding it", async () => {
	// `stopAll` is the quit path. It still stops the processes — nobody is coming
	// back for this pi — but the conversations are on disk and the next cold
	// start should be able to offer them back.
	const registry = scratchRegistry();
	const { m } = manager({ registry });
	m.restore([record({ sessionId: "uuid-1", name: "reviewer" })]);
	await m.stopAll(50);
	assert.deepEqual(m.list(), []);
	const [node] = registry.read().nodes;
	assert.equal(node!.sessionId, "uuid-1");
	assert.equal(node!.name, "reviewer");
});

test("a cold restore keeps the two fields auto-resume decides on", () => {
	// The bug this guards: `Registry.live()` rewrites `status` to `hibernated` for
	// every node whose pid is gone, so by the time a node is restored the only
	// surviving evidence that it was mid-task is `unfinishedStatus`. Dropping it
	// here made cold-start auto-resume a no-op — invisibly, because the *reload*
	// path carries the same information in a different field and worked fine.
	//
	// `resumeAttempts` is the other half: it lives on the node precisely so it
	// survives the restart it is counting, and resetting it here would give a
	// crash-looping child a fresh three attempts on every launch.
	const dir = mkdtempSync(join(tmpdir(), "subagent-cold-node-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "uuid-cold" })}\n`);
	const { m } = manager();
	const [agent] = m.restoreFromRegistry([
		{
			sessionId: "uuid-cold",
			name: "worker",
			// What a dead pid leaves behind: hibernated, but interrupted.
			status: "hibernated",
			unfinishedStatus: "running",
			resumeAttempts: 2,
			lastActiveAt: Date.now(),
			sessionFile,
			sessionDir: dir,
		},
	]);
	assert.equal(agent!.unfinishedStatus, "running");
	assert.equal(agent!.resumeAttempts, 2);
});

test("a manager without a registry simply does not persist", () => {
	// The registry is injected, so a headless embedder or a unit test can opt out
	// without the manager growing a second code path.
	const { m } = manager();
	assert.doesNotThrow(() => {
		m.restore([record()]);
		m.checkpoint();
	});
});

// --- the cold-start path --------------------------------------------------

test("registry nodes restore into agents, uuid first", () => {
	const registry = scratchRegistry();
	const source = manager({ registry, parentSessionId: "old-parent" });
	const dir = mkdtempSync(join(tmpdir(), "subagent-cold-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "uuid-1", cwd: dir })}\n`);
	source.m.restore([
		record({ sessionId: "uuid-1", name: "reviewer", sessionFile, sessionDir: dir, cwd: dir }),
	]);

	// A different process entirely: no session entries, no names, only the file.
	const cold = manager();
	const restored = cold.m.restoreFromRegistry(registry.read().nodes);
	assert.equal(restored.length, 1);
	assert.equal(restored[0]!.sessionId, "uuid-1");
	assert.equal(restored[0]!.name, "reviewer");
	assert.equal(restored[0]!.status, "hibernated");
	assert.equal(restored[0]!.client, undefined);
	// Reachable by uuid straight away, which is the only handle a cold start has.
	assert.equal(cold.m.get("uuid-1")!.sessionId, "uuid-1");
});

test("a cold start ignores nodes whose session file is gone", () => {
	const cold = manager();
	assert.deepEqual(
		cold.m.restoreFromRegistry([
			{ sessionId: "u", name: "n", status: "running", lastActiveAt: 1, sessionFile: "/gone", sessionDir: "/gone" },
			{ sessionId: "v", name: "m", status: "running", lastActiveAt: 1 },
		]),
		[],
	);
});

test("a cold start does not start any processes", () => {
	// Silently spawning children because you launched pi is not acceptable; the
	// decision belongs to `/agents restore`.
	const registry = scratchRegistry();
	const source = manager({ registry });
	source.m.restore([record({ sessionId: "uuid-1" })]);
	const cold = manager();
	for (const agent of cold.m.restoreFromRegistry(registry.read().nodes)) {
		assert.equal(agent.client, undefined);
	}
});

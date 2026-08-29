/**
 * The registry: the thing that makes a cold restart survivable.
 *
 * Session-entry hibernation covers every case where the *same* session is
 * reopened. It structurally cannot cover `kill pi` and start again, because a
 * cold start opens a new session and never reads the old one. The registry lives
 * outside sessions for exactly that case, which puts three properties on the
 * critical path and they are what this file tests:
 *
 *   1. **Atomicity.** The process that writes the registry is the one that might
 *      be killed mid-write, so a reader must see the whole old file or the whole
 *      new one.
 *   2. **Tolerance.** A corrupt or truncated file must read as empty, never
 *      throw: a bad registry that stopped pi from starting would be a strictly
 *      worse bug than the one it exists to fix.
 *   3. **Dead-pid detection.** After a crash every status in the file is frozen
 *      at the moment of the crash and every one of them lies about a live
 *      process. Liveness comes from the pid, not from the recorded status.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_AUTO_RESTORE_MAX_AGE_MINUTES,
	REGISTRY_VERSION,
	Registry,
	autoRestorable,
	childrenOf,
	describeRestorable,
	descendantsOf,
	emptyRegistry,
	isPidAlive,
	markDeadNodes,
	parseNode,
	parseRegistry,
	registryPath,
	restorableNodes,
	treeSpawnedIn,
	type RegistryNode,
} from "../registry.ts";

function scratch(): string {
	return join(mkdtempSync(join(tmpdir(), "subagent-registry-")), "registry.json");
}

function node(overrides: Partial<RegistryNode> & { sessionId: string }): RegistryNode {
	return { name: "worker", status: "running", lastActiveAt: 1000, ...overrides };
}

// --- keying ---------------------------------------------------------------

test("a node round-trips through the file, keyed by session uuid", () => {
	const registry = new Registry(scratch());
	registry.upsert(node({ sessionId: "uuid-1", name: "reviewer", task: "review" }));
	const read = registry.read();
	assert.equal(read.nodes.length, 1);
	assert.equal(read.nodes[0]!.sessionId, "uuid-1");
	assert.equal(read.nodes[0]!.name, "reviewer");
	assert.equal(read.version, REGISTRY_VERSION);
});

test("two agents sharing a display name are two nodes, not one", () => {
	// The whole point of the uuid spine: names are unique inside one parent, and
	// two parents can each have a `reviewer`.
	const registry = new Registry(scratch());
	registry.upsert(node({ sessionId: "uuid-a", parentSessionId: "parent-1", name: "reviewer" }));
	registry.upsert(node({ sessionId: "uuid-b", parentSessionId: "parent-2", name: "reviewer" }));
	const read = registry.read();
	assert.equal(read.nodes.length, 2);
	assert.deepEqual(
		read.nodes.map((n) => n.parentSessionId).sort(),
		["parent-1", "parent-2"],
	);
});

test("upsert merges rather than replaces, so a partial transition keeps the rest", () => {
	const registry = new Registry(scratch());
	registry.upsert(
		node({ sessionId: "u", taskSummary: "the original task", cwd: "/tmp/w", pid: 4242 }),
	);
	registry.upsert(node({ sessionId: "u", status: "completed", lastActiveAt: 2000 }));
	const [stored] = registry.read().nodes;
	assert.equal(stored!.status, "completed");
	assert.equal(stored!.taskSummary, "the original task");
	assert.equal(stored!.cwd, "/tmp/w");
});

test("an absent pid is a real transition, not a field nobody restated", () => {
	// Hibernating means "there is no process any more". If the merge preserved
	// the old pid, liveness would report a dead child as running.
	const registry = new Registry(scratch());
	registry.upsert(node({ sessionId: "u", pid: 4242 }));
	registry.upsert(node({ sessionId: "u", status: "hibernated", lastActiveAt: 2000 }));
	assert.equal(registry.read().nodes[0]!.pid, undefined);
});

test("removing a node removes its whole subtree", () => {
	const registry = new Registry(scratch());
	registry.upsert(node({ sessionId: "root" }));
	registry.upsert(node({ sessionId: "child", parentSessionId: "root" }));
	registry.upsert(node({ sessionId: "grandchild", parentSessionId: "child" }));
	registry.upsert(node({ sessionId: "unrelated" }));
	registry.remove("child");
	assert.deepEqual(
		registry.read().nodes.map((n) => n.sessionId).sort(),
		["root", "unrelated"],
	);
});

test("the root session id is recorded separately from the nodes", () => {
	const registry = new Registry(scratch());
	registry.setRoot("the-root");
	registry.upsert(node({ sessionId: "child", parentSessionId: "the-root" }));
	assert.equal(registry.read().rootSessionId, "the-root");
});

// --- atomicity ------------------------------------------------------------

test("a write leaves no temp file behind", () => {
	const path = scratch();
	const registry = new Registry(path);
	registry.upsert(node({ sessionId: "u" }));
	registry.upsert(node({ sessionId: "v" }));
	const files = readdirSync(join(path, "..")).filter((f) => f.endsWith(".tmp"));
	assert.deepEqual(files, [], "tmp+rename must clean up after itself");
});

test("a reader never sees a half-written file", () => {
	// Proven structurally rather than by racing: the target is only ever created
	// by `rename`, so at every instant it is either absent or a complete file.
	const path = scratch();
	const registry = new Registry(path);
	for (let i = 0; i < 25; i += 1) {
		registry.upsert(node({ sessionId: `u-${i}`, task: "x".repeat(4096) }));
		// A JSON.parse of the whole file is exactly what a concurrent reader does.
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		assert.equal(parsed.nodes.length, i + 1);
	}
});

test("the path is resolved lazily, so a redirected agent dir is honoured", () => {
	// The extension builds its Registry at load time, before a test or embedder
	// can move PI_CODING_AGENT_DIR. Capturing the path eagerly made the suite
	// write into the user's real ~/.pi.
	const previous = process.env.PI_CODING_AGENT_DIR;
	const registry = new Registry();
	try {
		const first = mkdtempSync(join(tmpdir(), "subagent-agentdir-a-"));
		process.env.PI_CODING_AGENT_DIR = first;
		assert.equal(registry.file, registryPath());
		assert.ok(registry.file.startsWith(first));

		const second = mkdtempSync(join(tmpdir(), "subagent-agentdir-b-"));
		process.env.PI_CODING_AGENT_DIR = second;
		assert.ok(registry.file.startsWith(second));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

// --- tolerance ------------------------------------------------------------

test("a corrupt registry reads as empty instead of throwing", () => {
	for (const contents of [
		"", // truncated to nothing
		"{", // killed mid-write
		'{"version":1,"nodes":', // killed later mid-write
		"not json at all",
		'{"version":1}', // no nodes array
		'{"version":1,"nodes":{}}', // nodes is not an array
		"[]", // somebody wrote the wrong shape
	]) {
		const path = scratch();
		writeFileSync(path, contents);
		const registry = new Registry(path);
		assert.deepEqual(registry.read().nodes, [], JSON.stringify(contents));
	}
});

test("a missing registry reads as empty", () => {
	assert.deepEqual(new Registry(join(tmpdir(), "definitely-not-there", "registry.json")).read().nodes, []);
});

test("a corrupt registry is replaced by the next write, not compounded", () => {
	const path = scratch();
	writeFileSync(path, "{ truncated");
	const registry = new Registry(path);
	registry.upsert(node({ sessionId: "u" }));
	assert.deepEqual(registry.read().nodes.map((n) => n.sessionId), ["u"]);
});

test("one bad node does not cost the others", () => {
	const file = parseRegistry(
		JSON.stringify({
			version: 1,
			nodes: [{ sessionId: "good", name: "a" }, null, 42, { name: "no session id" }, "x"],
		}),
	);
	assert.deepEqual(file.nodes.map((n) => n.sessionId), ["good"]);
});

test("duplicate session ids collapse to the first", () => {
	const file = parseRegistry(
		JSON.stringify({ version: 1, nodes: [{ sessionId: "u", name: "a" }, { sessionId: "u", name: "b" }] }),
	);
	assert.equal(file.nodes.length, 1);
	assert.equal(file.nodes[0]!.name, "a");
});

test("a node without a session uuid has no identity and is dropped", () => {
	assert.equal(parseNode({ name: "worker", status: "running" }), undefined);
	assert.equal(parseNode(undefined), undefined);
	assert.equal(parseNode("worker"), undefined);
});

test("a write to an unwritable path fails silently", () => {
	// The registry is an index of things that exist elsewhere; it must never be
	// able to break a spawn.
	const registry = new Registry("/proc/definitely/not/writable/registry.json");
	assert.doesNotThrow(() => registry.upsert(node({ sessionId: "u" })));
});

// --- liveness -------------------------------------------------------------

test("our own pid is alive and an absurd one is not", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(2 ** 30), false);
	assert.equal(isPidAlive(undefined), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(-1), false);
});

test("a pid owned by someone else counts as alive", () => {
	const alive = isPidAlive(1234, () => {
		const error: any = new Error("operation not permitted");
		error.code = "EPERM";
		throw error;
	});
	assert.equal(alive, true);
});

test("a dead pid hibernates the node whatever its recorded status says", () => {
	const dead = () => false;
	const nodes = markDeadNodes(
		[
			node({ sessionId: "a", status: "running", pid: 111 }),
			node({ sessionId: "b", status: "waiting", pid: 222 }),
			node({ sessionId: "c", status: "failed", pid: 333 }),
		],
		dead,
	);
	assert.deepEqual(nodes.map((n) => n.status), ["hibernated", "hibernated", "failed"]);
	// The pid is dropped too: a recycled pid must not later read as "alive".
	assert.deepEqual(nodes.map((n) => n.pid), [undefined, undefined, undefined]);
});

test("a live pid is left exactly as it was", () => {
	const nodes = markDeadNodes([node({ sessionId: "a", status: "running", pid: 111 })], () => true);
	assert.equal(nodes[0]!.status, "running");
	assert.equal(nodes[0]!.pid, 111);
});

test("a node with no pid at all is already hibernated", () => {
	const nodes = markDeadNodes([node({ sessionId: "a", status: "running" })]);
	assert.equal(nodes[0]!.status, "hibernated");
});

test("a closed node stays closed: it is gone, not asleep", () => {
	const nodes = markDeadNodes([node({ sessionId: "a", status: "closed" })], () => false);
	assert.equal(nodes[0]!.status, "closed");
});

test("live() reconciles pids without rewriting the file", () => {
	const path = scratch();
	const registry = new Registry(path);
	registry.upsert(node({ sessionId: "u", status: "running", pid: 2 ** 30 }));
	assert.equal(registry.live().nodes[0]!.status, "hibernated");
	// The file itself is untouched: reconciliation is a read-time view, so two
	// processes reading concurrently cannot fight over it.
	assert.equal(registry.read().nodes[0]!.status, "running");
});

// --- restorability --------------------------------------------------------

test("only nodes whose session file still exists are restorable", () => {
	const nodes = [
		node({ sessionId: "a", sessionFile: "/present" }),
		node({ sessionId: "b", sessionFile: "/gone" }),
		node({ sessionId: "c" }), // never had one
		node({ sessionId: "d", sessionFile: "/present", status: "closed" }),
	];
	const found = restorableNodes(nodes, undefined, (p) => p === "/present");
	assert.deepEqual(found.map((n) => n.sessionId), ["a"]);
});

test("restorable nodes can be scoped to one parent", () => {
	const nodes = [
		node({ sessionId: "a", parentSessionId: "p1", sessionFile: "/f" }),
		node({ sessionId: "b", parentSessionId: "p2", sessionFile: "/f" }),
	];
	assert.deepEqual(
		restorableNodes(nodes, "p1", () => true).map((n) => n.sessionId),
		["a"],
	);
});

// --- the tree -------------------------------------------------------------

test("parentage is a field, so depth costs nothing", () => {
	const nodes = [
		node({ sessionId: "root" }),
		node({ sessionId: "kid", parentSessionId: "root" }),
		node({ sessionId: "grandkid", parentSessionId: "kid" }),
		node({ sessionId: "greatgrandkid", parentSessionId: "grandkid" }),
	];
	assert.deepEqual(childrenOf(nodes, "root").map((n) => n.sessionId), ["kid"]);
	assert.deepEqual(
		descendantsOf(nodes, "root").map((n) => n.sessionId),
		["kid", "grandkid", "greatgrandkid"],
	);
});

test("a cyclic registry terminates instead of hanging startup", () => {
	// A corrupt file can perfectly well claim A is B's parent and B is A's.
	const nodes = [
		node({ sessionId: "a", parentSessionId: "b" }),
		node({ sessionId: "b", parentSessionId: "a" }),
	];
	assert.deepEqual(descendantsOf(nodes, "a").map((n) => n.sessionId), ["b"]);
});

test("the restorable summary names each agent and says nothing when empty", () => {
	assert.match(describeRestorable([]), /No subagents/);
	const text = describeRestorable([
		node({
			sessionId: "abcdef01-2345",
			name: "reviewer",
			taskSummary: "review the diff",
			cwd: "/w",
		}),
	]);
	assert.match(text, /reviewer/);
	assert.match(text, /abcdef01/);
	assert.match(text, /review the diff/);
});

test("an empty registry is a valid registry", () => {
	const empty = emptyRegistry("root");
	assert.deepEqual(empty.nodes, []);
	assert.equal(empty.rootSessionId, "root");
});

// --- scoping: whose children are these? -----------------------------------

test("a node belongs to the directory its parent was working in", () => {
	// Not its own `cwd`: under the worktree flow a child deliberately works
	// somewhere else, and matching on that would disown every delegated worktree.
	const nodes = [
		node({ sessionId: "mine", parentCwd: "/repo", cwd: "/worktrees/a" }),
		node({ sessionId: "theirs", parentCwd: "/other-repo", cwd: "/other-repo" }),
	];
	assert.deepEqual(
		treeSpawnedIn(nodes, "/repo").map((n) => n.sessionId),
		["mine"],
	);
	assert.deepEqual(treeSpawnedIn(nodes, "/somewhere-else"), []);
	// No directory to compare against is not "everything": it is nothing.
	assert.deepEqual(treeSpawnedIn(nodes, undefined), []);
});

test("a node written before parentCwd existed falls back to its own cwd", () => {
	// Conservative on purpose: the expensive mistake is adopting somebody else's
	// agents, so an unknown parent only qualifies when the child is demonstrably
	// here.
	const nodes = [
		node({ sessionId: "legacy-here", cwd: "/repo" }),
		node({ sessionId: "legacy-elsewhere", cwd: "/other-repo" }),
	];
	assert.deepEqual(
		treeSpawnedIn(nodes, "/repo").map((n) => n.sessionId),
		["legacy-here"],
	);
});

test("descendants come along with their seed", () => {
	// A grandchild's `parentCwd` is its own parent's worktree, so matching it
	// directly would strand exactly the deepest agents.
	const nodes = [
		node({ sessionId: "child", parentCwd: "/repo", cwd: "/worktrees/a" }),
		node({ sessionId: "grandchild", parentSessionId: "child", parentCwd: "/worktrees/a", cwd: "/worktrees/b" }),
		node({ sessionId: "stranger", parentCwd: "/other-repo", cwd: "/other-repo" }),
	];
	assert.deepEqual(
		treeSpawnedIn(nodes, "/repo")
			.map((n) => n.sessionId)
			.sort(),
		["child", "grandchild"],
	);
});

test("a cyclic tree does not make scoping hang either", () => {
	const nodes = [
		node({ sessionId: "a", parentSessionId: "b", parentCwd: "/repo" }),
		node({ sessionId: "b", parentSessionId: "a", parentCwd: "/repo" }),
	];
	assert.equal(treeSpawnedIn(nodes, "/repo").length, 2);
});

test("auto-restore is bounded by age as well as by directory", () => {
	const now = 10_000_000_000;
	const nodes = [
		node({ sessionId: "fresh", parentCwd: "/repo", lastActiveAt: now - 60_000 }),
		node({ sessionId: "stale", parentCwd: "/repo", lastActiveAt: now - 3 * 24 * 60 * 60_000 }),
	];
	assert.deepEqual(
		autoRestorable(nodes, {
			cwd: "/repo",
			now,
			maxAgeMinutes: DEFAULT_AUTO_RESTORE_MAX_AGE_MINUTES,
		}).map((n) => n.sessionId),
		["fresh"],
	);
	// `0` is the documented escape hatch for anyone who wants everything back.
	assert.equal(autoRestorable(nodes, { cwd: "/repo", now, maxAgeMinutes: 0 }).length, 2);
	// The directory bound still applies whatever the age says.
	assert.deepEqual(autoRestorable(nodes, { cwd: "/elsewhere", now, maxAgeMinutes: 0 }), []);
});

test("parentCwd survives a round-trip through the file", () => {
	// It is read back by a *different* pi process, which is the only reason it is
	// on disk at all.
	const registry = new Registry(scratch());
	registry.upsert(node({ sessionId: "uuid-1", parentCwd: "/repo", cwd: "/worktrees/a" }));
	assert.equal(registry.read().nodes[0]!.parentCwd, "/repo");
	// A node from an older version simply has none, which `treeSpawnedIn` handles.
	assert.equal(parseNode({ sessionId: "uuid-2" })!.parentCwd, undefined);
});

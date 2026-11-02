import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_MAX_OPEN_AGENTS,
	LIMITS,
	MAX_OPEN_AGENTS_CEILING,
	describeToolCall,
	normalizeName,
	parseMaxOpenAgents,
} from "../manager.ts";

// --- normalizeName --------------------------------------------------------

test("normalizeName accepts ordinary names", () => {
	const used = new Set<string>();
	assert.equal(normalizeName("reviewer", used), "reviewer");
	assert.equal(normalizeName("  api.v2-worker_1 ", used), "api.v2-worker_1");
});

test("normalizeName rejects empty and whitespace-only names", () => {
	const used = new Set<string>();
	assert.throws(() => normalizeName("", used), /name is required/);
	assert.throws(() => normalizeName("   ", used), /name is required/);
});

test("normalizeName rejects names with shell/path characters", () => {
	const used = new Set<string>();
	for (const bad of ["../escape", "a/b", "a;b", "-leading", "naïve"]) {
		assert.throws(() => normalizeName(bad, used), /invalid subagent name/);
	}
});

test("normalizeName never recycles a name, case-insensitively", () => {
	const used = new Set(["reviewer"]);
	assert.throws(() => normalizeName("Reviewer", used), /already used/);
});

test("normalizeName truncates to the name limit", () => {
	const name = normalizeName("n".repeat(LIMITS.maxNameChars + 20), new Set());
	assert.equal(name.length, LIMITS.maxNameChars);
});

// --- describeToolCall -----------------------------------------------------

test("describeToolCall renders bash as its first command line", () => {
	assert.equal(describeToolCall("bash", { command: "ls -la\ncd /tmp" }), "$ ls -la");
});

test("describeToolCall truncates long bash commands", () => {
	const line = describeToolCall("bash", { command: "x".repeat(200) });
	assert.equal(line.length, 82); // "$ " + 80
});

test("describeToolCall prefers a recognisable argument", () => {
	assert.equal(describeToolCall("read", { path: "src/index.ts" }), "read src/index.ts");
	assert.equal(describeToolCall("grep", { pattern: "TODO", path: "src" }), "grep src");
	assert.equal(describeToolCall("report_to_parent", { summary: "found it" }), "report_to_parent found it");
});

test("describeToolCall falls back to the tool name", () => {
	assert.equal(describeToolCall("list", undefined), "list");
	assert.equal(describeToolCall("list", "not an object"), "list");
	assert.equal(describeToolCall("list", { count: 3 }), "list");
});

// --- hibernate / restore / stall ------------------------------------------

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentManager } from "../manager.ts";
import { toRecord } from "../hibernate.ts";
import { emptyUsage } from "../types.ts";

/** A hibernated record pointing at a session file that really exists on disk. */
function record(overrides: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-restore-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	return {
		id: "worker-1",
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

function manager() {
	const changes: number[] = [];
	const stalls: Array<{ name: string; silentForMs: number }> = [];
	const m = new SubagentManager(
		{
			onChange: () => changes.push(Date.now()),
			onMail: () => {},
			onStall: (agent, silentForMs) => stalls.push({ name: agent.name, silentForMs }),
		},
		{ stallSeconds: 120 },
	);
	return { m, changes, stalls };
}

test("restore brings an agent back without a process", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	assert.equal(agent!.status, "hibernated");
	assert.equal(agent!.client, undefined);
	assert.equal(agent!.busy, false);
	// The facts the human cares about survive the reload.
	assert.equal(agent!.usage.turns, 2);
	assert.equal(agent!.output, "half done");
	assert.equal(m.get("worker")!.id, "worker-1");
});

test("restore keeps a failed agent labelled failed", () => {
	const { m } = manager();
	const [agent] = m.restore([record({ status: "failed", error: "it broke" })]);
	assert.equal(agent!.status, "failed");
	assert.equal(agent!.error, "it broke");
});

test("restore skips records whose session file is gone", () => {
	const { m } = manager();
	assert.deepEqual(m.restore([record({ sessionFile: "/nonexistent/session.jsonl" })]), []);
	assert.deepEqual(m.list(), []);
});

test("restore is idempotent and never duplicates an agent", () => {
	const { m } = manager();
	const r = record();
	m.restore([r]);
	assert.deepEqual(m.restore([r]), []);
	assert.equal(m.list().length, 1);
});

test("a restored name stays reserved across the reload", () => {
	const { m } = manager();
	m.restore([record()]);
	assert.throws(() => normalizeName("worker", new Set(["worker"])), /already used/);
	// And through the manager's own bookkeeping: spawning "worker" again must
	// not silently point old references at a different agent.
	assert.equal(m.get("Worker")!.name, "worker");
});

test("hibernated agents do not hold a process slot", () => {
	const { m } = manager();
	for (let i = 0; i < m.maxOpenAgents; i += 1) {
		m.restore([record({ id: `w${i}`, name: `w${i}` })]);
	}
	assert.equal(m.list().length, m.maxOpenAgents);
	assert.equal(m.openCount, 0);
});

test("hibernateAll returns records for the live set and keeps the agents", async () => {
	const { m } = manager();
	m.restore([record()]);
	const records = await m.hibernateAll();
	assert.deepEqual(records.map((r) => r.name), ["worker"]);
	assert.equal(m.list().length, 1);
	assert.equal(m.get("worker")!.status, "hibernated");
});

test("a record survives hibernate → restore → hibernate unchanged", async () => {
	const { m } = manager();
	m.restore([record()]);
	const first = await m.hibernateAll();
	const { m: reloaded } = manager();
	reloaded.restore(first);
	const second = await reloaded.hibernateAll();
	// endedAt/status aside, the identity and the resume paths must be stable.
	assert.deepEqual(
		second.map((r) => [r.id, r.sessionFile, r.launch.notesPath, r.usage.turns]),
		first.map((r) => [r.id, r.sessionFile, r.launch.notesPath, r.usage.turns]),
	);
});

test("closing a hibernated agent works without a process", async () => {
	const { m } = manager();
	m.restore([record()]);
	await m.close("worker");
	assert.deepEqual(m.list(), []);
});

test("sweepStalls marks a silent busy child once and recovers it", () => {
	const { m, stalls } = manager();
	const [agent] = m.restore([record()]);
	// Pretend it was revived and prompted three minutes ago.
	agent!.status = "running";
	agent!.busy = true;
	agent!.lastEventAt = Date.now() - 180_000;

	m.sweepStalls();
	assert.equal(agent!.status, "stalled");
	assert.equal(stalls.length, 1);
	assert.ok(stalls[0]!.silentForMs >= 180_000);

	// A second sweep must not nag.
	m.sweepStalls();
	assert.equal(stalls.length, 1);

	// Events resume: back to running, and a later stall notifies again.
	agent!.lastEventAt = Date.now();
	m.sweepStalls();
	assert.equal(agent!.status, "running");
	agent!.lastEventAt = Date.now() - 180_000;
	m.sweepStalls();
	assert.equal(stalls.length, 2);
});

test("sweepStalls leaves settled and hibernated agents alone", () => {
	const { m, stalls } = manager();
	const [agent] = m.restore([record()]);
	agent!.lastEventAt = Date.now() - 999_999;
	m.sweepStalls();
	assert.equal(agent!.status, "hibernated");
	assert.equal(stalls.length, 0);
});

test("silentFor reports the gap, or nothing when the child never spoke", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	assert.equal(m.silentFor(agent!), undefined);
	agent!.lastEventAt = 5_000;
	assert.equal(m.silentFor(agent!, 8_000), 3_000);
});

test("a hibernated agent's snapshot carries its state to the tool output", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	agent!.lastEventAt = Date.now() - 4_000;
	const [snap] = m.snapshots();
	assert.equal(snap!.status, "hibernated");
	assert.ok((snap!.silentForMs ?? 0) >= 4_000);
});

test("toRecord round-trips a restored agent", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	const again = toRecord(agent!);
	assert.equal(again.sessionFile, agent!.sessionFile);
	assert.equal(again.launch.notesPath, agent!.launch.notesPath);
});

// --- auto-reap and the idle sweep -----------------------------------------

import { existsSync, mkdirSync } from "node:fs";
import { selectReapVictim } from "../reap.ts";

/** A restored agent forced into a given finished state, with real files on disk. */
function finished(m: SubagentManager, id: string, status: string, lastActive: number) {
	const [agent] = m.restore([record({ id, name: id })]);
	agent!.status = status as any;
	agent!.endedAt = lastActive;
	agent!.lastEventAt = lastActive;
	return agent!;
}

test("the idle sweep hibernates a completed agent nobody touched", async () => {
	const { m } = manager();
	const agent = finished(m, "done", "completed", Date.now() - 45 * 60_000);
	// A completed agent with a live process is what the sweep is for; restore()
	// gives us no client, so stand one in that reports itself as running.
	agent.client = { running: true, stop: async () => {}, getStderr: () => "" } as any;

	const slept = await m.sweepIdle();
	assert.deepEqual(slept.map((a) => a.name), ["done"]);
	assert.equal(agent.status, "hibernated");
	assert.equal(agent.client, undefined);
	// Hibernated, not closed: the conversation is still there to revive.
	assert.ok(existsSync(agent.sessionFile));
	assert.equal(m.list().length, 1);
});

test("the idle sweep leaves recent, running and failed agents alone", async () => {
	const { m } = manager();
	const live = { running: true, stop: async () => {}, getStderr: () => "" } as any;
	const recent = finished(m, "recent", "completed", Date.now() - 60_000);
	const running = finished(m, "running", "running", 0);
	const failed = finished(m, "failed", "failed", 0);
	for (const agent of [recent, running, failed]) agent.client = live;
	running.busy = true;

	assert.deepEqual(await m.sweepIdle(), []);
	assert.equal(recent.status, "completed");
	assert.equal(running.status, "running");
	assert.equal(failed.status, "failed");
});

test("the idle sweep is off when idleHibernateMinutes is 0", async () => {
	const changes: number[] = [];
	const m = new SubagentManager(
		{ onChange: () => changes.push(1), onMail: () => {} },
		{ idleHibernateMinutes: 0 },
	);
	const agent = finished(m, "ancient", "completed", 0);
	agent.client = { running: true, stop: async () => {}, getStderr: () => "" } as any;
	assert.deepEqual(await m.sweepIdle(), []);
	assert.equal(agent.status, "completed");
});

/**
 * A record whose session dir really lives under `subagentsRoot()`.
 *
 * `removeSessionDir` refuses to delete outside our own tree (deliberately), so
 * the cleanup policy can only be exercised with a realistic path.
 */
function rootedRecord(id: string) {
	const agentDir = mkdtempSync(join(tmpdir(), "subagent-agentdir-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const dir = join(agentDir, "subagents", "sessions", "parent", id);
	mkdirSync(dir, { recursive: true });
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	return {
		id,
		name: id,
		task: "t",
		cwd: dir,
		contextMode: "fresh",
		status: "completed",
		sessionFile,
		sessionDir: dir,
		startedAt: 10,
		usage: { ...emptyUsage() },
		output: "",
		launch: { notesPath: join(dir, "NOTES.md") },
	} as any;
}

test("a full slot table reclaims the stalest finished agent instead of failing", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const { m } = manager();
	try {
		const now = Date.now();
		// A table of running children plus one completed one: the completed one goes.
		for (let i = 0; i < m.maxOpenAgents - 1; i += 1) {
			const agent = finished(m, `run-${i}`, "running", now);
			agent.busy = true;
		}
		const [victim] = m.restore([rootedRecord("stale")]);
		victim!.status = "completed";
		victim!.endedAt = now - 90 * 60_000;
		victim!.lastEventAt = now - 90 * 60_000;
		assert.equal(m.openCount, m.maxOpenAgents);

		// The victim the rule picks is the one the manager must close.
		const choice = selectReapVictim(
			m.list().map((a) => ({
				id: a.id,
				name: a.name,
				status: a.status,
				busy: a.busy,
				lastEventAt: a.lastEventAt,
				endedAt: a.endedAt,
				startedAt: a.startedAt,
				hasProcess: a.client?.running === true,
			})),
		);
		assert.equal(choice.victim?.id, "stale");

		const sessionFile = victim!.sessionFile;
		await m.close(choice.victim!.id);
		assert.equal(m.get("stale"), undefined);
		assert.equal(existsSync(sessionFile), false, "a reclaimed agent's session dir is removed");
		assert.equal(m.openCount, m.maxOpenAgents - 1);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("reclaiming keeps a failed agent's transcript, exactly as an explicit close does", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const { m } = manager();
	try {
		const [agent] = m.restore([rootedRecord("broken")]);
		agent!.status = "failed";
		agent!.error = "it broke";
		const sessionFile = agent!.sessionFile;
		await m.close(agent!.id);
		// S7 policy: the only post-mortem evidence there is survives the close.
		assert.equal(existsSync(sessionFile), true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("a spawn that fails validation never costs an agent", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const reaped: Array<{ name: string; kind: string }> = [];
	const m = new SubagentManager(
		{
			onChange: () => {},
			onMail: () => {},
			onReap: (agent, kind) => reaped.push({ name: agent.name, kind }),
		},
		{},
	);
	try {
		for (let i = 0; i < m.maxOpenAgents - 1; i += 1) {
			const agent = finished(m, `run-${i}`, "running", Date.now());
			agent.busy = true;
		}
		const [victim] = m.restore([rootedRecord("stale")]);
		victim!.status = "completed";
		victim!.endedAt = 0;
		victim!.lastEventAt = 0;

		// Reclaiming ends a conversation; a typo must not be able to trigger it.
		await assert.rejects(() => m.spawn({} as any, [], { name: "new", task: "" }), /task is required/);
		await assert.rejects(
			() => m.spawn({} as any, [], { name: "../escape", task: "real" }),
			/invalid subagent name/,
		);
		assert.deepEqual(reaped, []);
		assert.ok(m.get("stale"), "the finished agent is still there");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("a valid spawn into a full table reclaims the stalest finished agent", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const reaped: Array<{ name: string; kind: string }> = [];
	const m = new SubagentManager(
		{
			onChange: () => {},
			onMail: () => {},
			onReap: (agent, kind) => reaped.push({ name: agent.name, kind }),
		},
		{},
	);
	try {
		for (let i = 0; i < m.maxOpenAgents - 1; i += 1) {
			const agent = finished(m, `run-${i}`, "running", Date.now());
			agent.busy = true;
		}
		const [victim] = m.restore([rootedRecord("stale")]);
		victim!.status = "completed";
		victim!.endedAt = 0;
		victim!.lastEventAt = 0;
		const sessionFile = victim!.sessionFile;

		// The spawn goes on to fail for want of a real context, but only *after*
		// room was made: the orchestrator must never see "too many subagents"
		// while a finished agent is sitting there.
		await assert.rejects(() =>
			m.spawn({ cwd: process.cwd() } as any, [], { name: "new", task: "real task" }),
		);
		assert.deepEqual(reaped, [{ name: "stale", kind: "reclaimed" }]);
		assert.equal(m.get("stale"), undefined);
		assert.equal(existsSync(sessionFile), false, "cleanup follows the explicit-close policy");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("spawn still refuses when every slot holds work that must not be lost", async () => {
	const { m } = manager();
	const running = m.maxOpenAgents - 2;
	for (let i = 0; i < running; i += 1) {
		const agent = finished(m, `run-${i}`, "running", Date.now());
		agent.busy = true;
	}
	finished(m, "wedged", "stalled", 0).busy = true;
	finished(m, "broken", "failed", 0);

	await assert.rejects(
		() => m.spawn({} as any, [], { name: "new", task: "real task" }),
		(error: Error) => {
			assert.match(error.message, /none can be reclaimed/);
			assert.match(error.message, new RegExp(`${running} still running`));
			assert.match(error.message, /1 stalled/);
			assert.match(error.message, /1 failed/);
			return true;
		},
	);
	// Nothing was destroyed on the way to that error.
	assert.equal(m.list().length, m.maxOpenAgents);
});

test("a table full of running agents is not 'fixed' by closing a hibernated one", async () => {
	const { m } = manager();
	for (let i = 0; i < m.maxOpenAgents; i += 1) {
		const agent = finished(m, `run-${i}`, "running", Date.now());
		agent.busy = true;
	}
	// Hibernated agents hold no slot, so taking one would destroy a conversation
	// without making any room at all.
	const asleep = finished(m, "asleep", "hibernated", 0);
	await assert.rejects(
		() => m.spawn({ cwd: process.cwd() } as any, [], { name: "new", task: "real task" }),
		/none can be reclaimed/,
	);
	assert.ok(m.get("asleep"), "the hibernated agent survives");
	assert.equal(asleep.status, "hibernated");
});

// --- ask_parent -----------------------------------------------------------

import { readFileSync } from "node:fs";
import { answerPath, answersDirectory, parseAnswer } from "../ask.ts";

/** Feed an event into an agent's stream exactly as ChildRpc would. */
function emit(m: SubagentManager, agent: any, event: any) {
	// attach() wires the manager's handler to the client; a restored agent has no
	// client, so drive the same private path the way the RPC layer does.
	(m as any).handleEvent(agent, event);
}

const askUpdate = (questionId: string, question: string, context?: string) => ({
	type: "tool_execution_update",
	toolName: "ask_parent",
	partialResult: { details: { questionId, question, ...(context ? { context } : {}) } },
});

test("a question puts the agent in waiting and mails the parent", () => {
	const { m } = manager();
	const mailed: Array<{ name: string; kind: string }> = [];
	(m as any).callbacks.onMail = (name: string, kind: string) => mailed.push({ name, kind });
	const [agent] = m.restore([record()]);
	agent!.status = "running";
	agent!.busy = true;

	emit(m, agent, askUpdate("q-1", "postgres or sqlite?", "both work here"));

	assert.equal(agent!.status, "waiting");
	assert.equal(agent!.pendingQuestion?.id, "q-1");
	assert.deepEqual(mailed, [{ name: "worker", kind: "question" }]);
	const mail = m.mailbox.peek();
	assert.equal(mail[0]!.kind, "question");
	// The context the child gathered rides along; asking twice for it wastes a turn.
	assert.match(mail[0]!.content, /postgres or sqlite\?/);
	assert.match(mail[0]!.content, /both work here/);
});

test("a re-announced question is not mailed twice", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	agent!.busy = true;
	emit(m, agent, askUpdate("q-1", "same question"));
	emit(m, agent, askUpdate("q-1", "same question"));
	assert.equal(m.mailbox.peek().filter((e) => e.kind === "question").length, 1);
});

test("a malformed ask update leaves the agent working", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	agent!.status = "running";
	agent!.busy = true;
	emit(m, agent, { type: "tool_execution_update", toolName: "ask_parent", partialResult: {} });
	assert.equal(agent!.status, "running");
	assert.equal(agent!.pendingQuestion, undefined);
});

test("answering writes the file the child is polling for, atomically", async () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	agent!.busy = true;
	emit(m, agent, askUpdate("q-42", "which port?"));

	const { delivered } = await m.answer("worker", "use 8080");
	assert.equal(delivered, true);

	const file = answerPath(answersDirectory(agent!.sessionDir), "q-42");
	const answer = parseAnswer(readFileSync(file, "utf-8"));
	assert.equal(answer?.answer, "use 8080");
	assert.equal(answer?.questionId, "q-42");
	// No .tmp left behind: the write is rename-based, not truncate-in-place.
	assert.equal(existsSync(`${file}.tmp`), false);

	// The UI stops saying "waiting for you" immediately, without waiting for the
	// child's tool_execution_end to come back.
	assert.equal(agent!.pendingQuestion, undefined);
	assert.equal(agent!.status, "running");
	assert.equal(m.mailbox.peek().length, 0, "the question card is consumed by answering");
});

test("answering an agent with no pending question reports that, losing nothing", async () => {
	const { m } = manager();
	m.restore([record()]);
	const { delivered } = await m.answer("worker", "unprompted advice");
	// index.ts turns this into an ordinary followup rather than dropping the text.
	assert.equal(delivered, false);
});

test("the child's tool_execution_end clears the question by itself", () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	agent!.busy = true;
	emit(m, agent, askUpdate("q-1", "?"));
	assert.equal(agent!.status, "waiting");
	// Answered out of band, or aborted: either way it is working again.
	emit(m, agent, { type: "tool_execution_end", toolName: "ask_parent", result: {} });
	assert.equal(agent!.pendingQuestion, undefined);
	assert.equal(agent!.status, "running");
});

test("a waiting child is never idle-hibernated or reclaimed", async () => {
	const { m } = manager();
	const [agent] = m.restore([record()]);
	agent!.busy = true;
	agent!.client = { running: true, stop: async () => {}, getStderr: () => "" } as any;
	emit(m, agent, askUpdate("q-1", "?"));
	agent!.lastEventAt = 0; // Ancient, but blocked on us rather than idle.

	assert.deepEqual(await m.sweepIdle(), []);
	m.sweepStalls();
	assert.equal(agent!.status, "waiting", "a blocked child is not a stalled one");
});

test("a question is queued whether the parent is idle or busy", () => {
	// The manager has no idea whether the parent is idle, and must not: the
	// enqueue is a guarantee, and idleness only decides when index.ts delivers.
	for (const parentIsBusy of [false, true]) {
		const { m } = manager();
		const [agent] = m.restore([record()]);
		agent!.busy = true;
		void parentIsBusy; // Nothing in this path can observe it.
		emit(m, agent, askUpdate("q-1", "which port?"));
		const queued = m.mailbox.peek().filter((e) => e.kind === "question");
		assert.equal(queued.length, 1);
		assert.equal(queued[0]!.questionId, "q-1");
	}
});

test("questions from several children queue up independently and in order", () => {
	const { m } = manager();
	const first = m.restore([record({ id: "api", name: "api" })])[0]!;
	const second = m.restore([record({ id: "ui", name: "ui" })])[0]!;
	first.busy = true;
	second.busy = true;

	emit(m, first, askUpdate("q-api", "which port?"));
	emit(m, second, askUpdate("q-ui", "which theme?"));

	assert.equal(first.status, "waiting");
	assert.equal(second.status, "waiting");
	const queued = m.mailbox.peek().filter((e) => e.kind === "question");
	assert.deepEqual(queued.map((e) => e.agentName), ["api", "ui"]);
	assert.deepEqual(queued.map((e) => e.questionId), ["q-api", "q-ui"]);
});

test("answering one blocked child leaves the other blocked and queued", async () => {
	const { m } = manager();
	const first = m.restore([record({ id: "api", name: "api" })])[0]!;
	const second = m.restore([record({ id: "ui", name: "ui" })])[0]!;
	first.busy = true;
	second.busy = true;
	emit(m, first, askUpdate("q-api", "which port?"));
	emit(m, second, askUpdate("q-ui", "which theme?"));

	await m.answer("api", "8080");

	assert.equal(first.pendingQuestion, undefined);
	assert.equal(second.pendingQuestion?.id, "q-ui", "the other child is untouched");
	assert.equal(second.status, "waiting");
	const left = m.mailbox.peek().filter((e) => e.kind === "question");
	assert.deepEqual(left.map((e) => e.agentName), ["ui"]);
	// And the answer went to the right child's directory.
	assert.equal(existsSync(answerPath(answersDirectory(first.sessionDir), "q-api")), true);
	assert.equal(existsSync(answerPath(answersDirectory(second.sessionDir), "q-ui")), false);
});

test("pendingQuestions lists every blocked child for the UI", () => {
	const { m } = manager();
	const first = m.restore([record({ id: "api", name: "api" })])[0]!;
	const second = m.restore([record({ id: "ui", name: "ui" })])[0]!;
	first.busy = true;
	second.busy = true;
	emit(m, first, askUpdate("q-api", "which port?"));
	emit(m, second, askUpdate("q-ui", "which theme?"));
	assert.deepEqual(
		m.pendingQuestions().map((p) => [p.agent.name, p.question.id]),
		[["api", "q-api"], ["ui", "q-ui"]],
	);
});

// --- spawn: progress + summary cache --------------------------------------

import { chmodSync } from "node:fs";

/**
 * A manager whose one expensive step is counted instead of performed.
 *
 * `spawn()` otherwise runs for real: context resolution, seeding, the system
 * prompt, and the launch — which is exactly the region under test. Only the
 * summarization is substituted, because it is the one step that needs a
 * provider and it is the step whose call count the cache is about.
 */
class CountingManager extends SubagentManager {
	summarizeCalls = 0;
	protected override summarize(): Promise<string> {
		this.summarizeCalls += 1;
		return Promise.resolve(`summary #${this.summarizeCalls}`);
	}
}

function spawnHarness(leafId: string | null = "leaf-1") {
	const home = mkdtempSync(join(tmpdir(), "subagent-spawn-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousBin = process.env.PI_SUBAGENT_BIN;
	process.env.PI_CODING_AGENT_DIR = home;
	// A child that exits immediately: the spawn fails at launch, after every step
	// under test has run, and leaves no process behind.
	const stub = join(home, "dead-child.sh");
	writeFileSync(stub, "#!/bin/sh\nexit 1\n");
	chmodSync(stub, 0o755);
	process.env.PI_SUBAGENT_BIN = stub;

	const m = new CountingManager({ onChange: () => {}, onMail: () => {} }, {});
	const ctx: any = {
		cwd: home,
		sessionManager: {
			getSessionId: () => "parent-session",
			getSessionFile: () => join(home, "parent.jsonl"),
			getEntries: () => [],
			getLeafId: () => leafId,
		},
	};
	const restore = () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previousBin;
	};
	return { m, ctx, home, restore };
}

/** Run a spawn that dies at process launch, collecting the progress it reported. */
async function attemptSpawn(m: CountingManager, ctx: any, name: string) {
	const stages: string[] = [];
	await m
		.spawn(ctx, [], {
			name,
			task: "do the thing",
			context: "compacted",
			onUpdate: (partial: any) => stages.push(partial?.details?.stage),
		})
		.catch(() => {});
	return stages;
}

test("spawn streams progress so a slow summarization does not read as a hang", async () => {
	const { m, ctx, restore } = spawnHarness();
	try {
		const stages = await attemptSpawn(m, ctx, "one");
		// These four are the work that happens before the child process exists,
		// which is the whole of the reported hang.
		assert.deepEqual(stages, ["context", "summarizing", "seeding", "starting"]);
	} finally {
		restore();
	}
});

test("a fan-out from one conversation point summarizes exactly once", async () => {
	const { m, ctx, restore } = spawnHarness();
	try {
		const first = await attemptSpawn(m, ctx, "one");
		const second = await attemptSpawn(m, ctx, "two");
		const third = await attemptSpawn(m, ctx, "three");
		assert.equal(m.summarizeCalls, 1, "three spawns from the same leaf must summarize once");
		assert.ok(first.includes("summarizing"));
		// And the reuse is announced rather than silently fast.
		assert.ok(second.includes("summary-cached"), `expected a cache hit, got ${second.join(",")}`);
		assert.ok(third.includes("summary-cached"));
	} finally {
		restore();
	}
});

test("the summary cache is invalidated when the parent leaf moves", async () => {
	let leaf = "leaf-1";
	const { m, ctx, restore } = spawnHarness();
	ctx.sessionManager.getLeafId = () => leaf;
	try {
		await attemptSpawn(m, ctx, "one");
		assert.equal(m.summarizeCalls, 1);
		leaf = "leaf-2"; // the parent said something else
		await attemptSpawn(m, ctx, "two");
		assert.equal(m.summarizeCalls, 2, "a moved leaf must not serve a stale summary");
	} finally {
		restore();
	}
});

test("a session with no leaf id is never served from the cache", async () => {
	const { m, ctx, restore } = spawnHarness(null);
	try {
		await attemptSpawn(m, ctx, "one");
		await attemptSpawn(m, ctx, "two");
		assert.equal(m.summarizeCalls, 2);
	} finally {
		restore();
	}
});

// --- persona context precedence ----------------------------------------------
//
// The chain is spawn param > persona frontmatter > "auto". `summarizeCalls` is
// the observable: only a resolved "compacted" mode summarizes, while "auto"
// against this harness's empty parent conversation resolves to "fresh".

import type { Persona } from "../personas.ts";

/** A minimal persona whose only interesting field is its context mode. */
function contextPersona(name: string, context: Persona["context"]): Persona {
	return {
		name,
		description: "",
		systemPrompt: `You are ${name}.`,
		source: "user",
		filePath: `/${name}.md`,
		context,
	};
}

test("a persona's frontmatter context is the spawn's default", async () => {
	const { m, ctx, restore } = spawnHarness();
	try {
		// Auto against an empty parent conversation means fresh, so a summarize call
		// here can only come from the persona's "compacted".
		await m
			.spawn(ctx, [contextPersona("compactor", "compacted")], {
				name: "one",
				task: "t",
				persona: "compactor",
			})
			.catch(() => {});
		assert.equal(m.summarizeCalls, 1);
	} finally {
		restore();
	}
});

test("a persona without a context mode falls back to auto", async () => {
	const { m, ctx, restore } = spawnHarness();
	try {
		await m
			.spawn(ctx, [contextPersona("plain", undefined)], { name: "one", task: "t", persona: "plain" })
			.catch(() => {});
		assert.equal(m.summarizeCalls, 0, "auto must resolve fresh here, not compacted");
	} finally {
		restore();
	}
});

test("the spawn param beats the persona's context mode", async () => {
	{
		const { m, ctx, restore } = spawnHarness();
		try {
			await m
				.spawn(ctx, [contextPersona("compactor", "compacted")], {
					name: "one",
					task: "t",
					persona: "compactor",
					context: "fresh",
				})
				.catch(() => {});
			assert.equal(m.summarizeCalls, 0, "fresh param must win over the persona's compacted");
		} finally {
			restore();
		}
	}
	{
		const { m, ctx, restore } = spawnHarness();
		try {
			await m
				.spawn(ctx, [contextPersona("scratchpad", "fresh")], {
					name: "one",
					task: "t",
					persona: "scratchpad",
					context: "compacted",
				})
				.catch(() => {});
			assert.equal(m.summarizeCalls, 1, "compacted param must win over the persona's fresh");
		} finally {
			restore();
		}
	}
});

// --- which MCP servers a child boots ----------------------------------------
//
// Three layers, most specific winning: the install-wide `childMcpServers`, the
// per-spawn `mcpServers`, and `setMcpScope` afterwards. The default is an *empty
// allowlist* rather than "everything", because the failure being avoided is a
// child accidentally booting a couple of servers and ~90 tools — and an
// allowlist's failure mode is a child that says it is missing a server, while a
// blocklist's is every newly configured server silently joining every child.

/**
 * Spawn against a stub that records its environment and then dies.
 *
 * The spawn fails at launch, which is fine and deliberate: everything under test
 * — the launch spec, and the environment `createClient` derives from it — has
 * already happened by then, and nothing is left running.
 */
function scopeHarness(config: Record<string, unknown>) {
	const home = mkdtempSync(join(tmpdir(), "subagent-mcp-scope-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousBin = process.env.PI_SUBAGENT_BIN;
	process.env.PI_CODING_AGENT_DIR = home;

	const envLog = join(home, "env.log");
	const stub = join(home, "child.sh");
	// Wrapped in markers because an *empty* scope is a meaningful value here, and a
	// bare empty line is indistinguishable from the trailing newline of the last one.
	writeFileSync(stub, `#!/bin/sh\nprintf '[%s]\\n' "\${PI_SUBAGENT_MCP-<unset>}" >> ${envLog}\nexit 1\n`);
	chmodSync(stub, 0o755);
	process.env.PI_SUBAGENT_BIN = stub;

	const m = new SubagentManager({ onChange: () => {}, onMail: () => {} }, config);
	const ctx: any = {
		cwd: home,
		sessionManager: {
			getSessionId: () => "parent-session",
			getSessionFile: () => join(home, "parent.jsonl"),
			getEntries: () => [],
			getLeafId: () => "leaf-1",
		},
	};
	return {
		m,
		ctx,
		home,
		/** What `PI_SUBAGENT_MCP` the child was launched with, per spawn. */
		scopes: () =>
			existsSync(envLog)
				? readFileSync(envLog, "utf-8")
						.split("\n")
						.filter((line) => line !== "")
						.map((line) => line.slice(1, -1))
				: [],
		restore() {
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previousBin;
		},
	};
}

test("with nothing configured, a spawned child boots no MCP servers", async () => {
	const h = scopeHarness({});
	try {
		await h.m.spawn(h.ctx, [], { name: "one", task: "do the thing" }).catch(() => {});
		// Empty, not absent: always writing the variable stops a stray
		// PI_SUBAGENT_MCP in the parent's own shell from leaking into children.
		assert.deepEqual(h.scopes(), [""]);
	} finally {
		h.restore();
	}
});

test("the install-wide default applies to a spawn that says nothing", async () => {
	const h = scopeHarness({ childMcpServers: ["notion"] });
	try {
		await h.m.spawn(h.ctx, [], { name: "one", task: "do the thing" }).catch(() => {});
		assert.deepEqual(h.scopes(), ["notion"]);
	} finally {
		h.restore();
	}
});

test("a per-spawn scope beats the install-wide default", async () => {
	const h = scopeHarness({ childMcpServers: ["notion"] });
	try {
		// The point of the per-spawn layer: a research child gets Notion and the
		// child writing code beside it gets Linear, from one install default.
		await h.m
			.spawn(h.ctx, [], { name: "one", task: "t", mcpServers: ["linear", "grafana"] })
			.catch(() => {});
		assert.deepEqual(h.scopes(), ["grafana,linear"]);
	} finally {
		h.restore();
	}
});

test("an explicitly empty per-spawn scope beats a non-empty default", async () => {
	const h = scopeHarness({ childMcpServers: ["notion"] });
	try {
		// `[]` is a decision, not an omission, so it must win. This is why
		// `parseMcpScope` returns `undefined` for a missing value rather than `[]`.
		await h.m.spawn(h.ctx, [], { name: "one", task: "t", mcpServers: [] }).catch(() => {});
		assert.deepEqual(h.scopes(), [""]);
	} finally {
		h.restore();
	}
});

test("siblings spawned from one parent carry their own scopes", async () => {
	const h = scopeHarness({ childMcpServers: ["notion"] });
	try {
		await h.m.spawn(h.ctx, [], { name: "one", task: "t", mcpServers: ["linear"] }).catch(() => {});
		await h.m.spawn(h.ctx, [], { name: "two", task: "t" }).catch(() => {});
		await h.m.spawn(h.ctx, [], { name: "three", task: "t", mcpServers: ["*"] }).catch(() => {});
		// Each child's scope lives in its own environment, so there is no shared
		// state for one sibling's scope to reach another through.
		assert.deepEqual(h.scopes(), ["linear", "notion", "*"]);
	} finally {
		h.restore();
	}
});

// --- where the task text lives ----------------------------------------------
//
// The registry is rewritten on every transition of every child on the machine,
// so it holds a one-line label and the text goes beside the child's transcript.
// See `task-store.ts`.

test("the registry node carries the label and neither blob", () => {
	// What `registryNode` puts on the wire is the whole point of the split: a
	// one-line label, and no `task` or `output` however large the child's were.
	const agent: any = {
		id: "a1",
		sessionId: "s1",
		name: "one",
		task: `# Audit the lock code\n\n${"detail ".repeat(2000)}`,
		taskSummary: "Audit the lock code",
		cwd: "/w",
		contextMode: "fresh",
		status: "running",
		startedAt: 1,
		usage: emptyUsage(),
		output: "x".repeat(40000),
		activity: [],
		sessionFile: "/w/s.jsonl",
		sessionDir: "/w",
		launch: { notesPath: "" },
		busy: false,
	};
	const m = new SubagentManager({ onChange: () => {}, onMail: () => {} }, {});
	const node = (m as any).registryNode(agent);
	assert.equal(node.taskSummary, "Audit the lock code");
	assert.equal(node.task, undefined);
	assert.equal(node.output, undefined);
	// And the node stays small regardless of how big the child's text was.
	assert.ok(JSON.stringify(node).length < 1000, "registry node should not carry blobs");
});

// --- the built-in child protocol --------------------------------------------
//
// Every spawned child receives this section verbatim from `buildSystemPrompt`.
// The cwd line is a contract: it must advise, never prohibit, because some
// briefs deliberately send a child outside its own tree (shared-workspace
// lanes, evidence written to absolute paths). Pin the sentence so an absolutist
// regression cannot slip in unnoticed.

test("the built-in protocol presents the cwd as advice, not a prohibition", () => {
	const m = new SubagentManager({ onChange: () => {}, onMail: () => {} }, {});
	const prompt = (m as any).buildSystemPrompt(
		"one",
		"do the thing",
		"/w/one",
		"/w/NOTES.md",
		undefined,
	);
	assert.ok(
		prompt.includes(
			"Your working directory is /w/one. Sibling agents may be working in other directories, so\n" +
				"stay inside your own tree unless your task explicitly sends you elsewhere.",
		),
		`the cwd line must yield to the task's brief, got:\n${prompt}`,
	);
});

/**
 * The liveness invariant: an extension must never be able to make pi
 * uninterruptible.
 *
 * These are the regression tests for the freeze that motivated the whole file.
 * A human hit a session where pi reported busy, Escape would not cancel and
 * `/reload` would not run — no way out but killing the terminal. It began on a
 * `subagent {action:"interrupt"}` that returned "No result provided": the
 * manager awaited `ChildRpc.abort()`, whose response promise had neither a
 * deadline nor a cancellation path, and the child never answered.
 *
 * Every test here answers one question: *given a child that has stopped
 * co-operating, does this parent-side call still return?* The child under test
 * is a stub — a fake transport, or a tiny real process that accepts commands
 * and answers nothing — because the failure is about the shape of the await,
 * not about any real model behaviour.
 *
 * A test that fails here does not fail politely: it hangs. Every case therefore
 * asserts a wall-clock bound rather than merely awaiting.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ChildRpc,
	DEFAULT_REQUEST_TIMEOUT_MS,
	RpcAbortedError,
	RpcTimeoutError,
} from "../rpc.ts";
import { SubagentManager, onDeadlineExceeded } from "../manager.ts";
import { emptyUsage } from "../types.ts";

/**
 * Resolve `promise`, or fail loudly if it takes longer than `ms`.
 *
 * `assert.ok(elapsed < n)` after the fact is not enough: the whole failure mode
 * under test is "never settles", and a suite that hangs reports nothing at all.
 */
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return (await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${what} did not settle within ${ms}ms — pi would be wedged`)),
					ms,
				);
				timer.unref?.();
			}),
		])) as T;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- fake rpc --

/**
 * A `ChildRpc` stand-in that accepts every command and answers none.
 *
 * This is the pathological child: alive, reading its stdin, and never
 * responding — exactly what a wedged provider call looks like from the parent.
 */
function silentClient(overrides: Record<string, unknown> = {}) {
	const sent: string[] = [];
	return {
		sent,
		running: true,
		pid: 4242,
		getStderr: () => "",
		onEvent: () => () => {},
		onExit: () => () => {},
		prompt: (message: string) => (sent.push(`prompt:${message}`), new Promise<never>(() => {})),
		steer: (message: string) => (sent.push(`steer:${message}`), new Promise<never>(() => {})),
		followUp: (message: string) => (sent.push(`followUp:${message}`), new Promise<never>(() => {})),
		abort: () => (sent.push("abort"), new Promise<never>(() => {})),
		stop: () => new Promise<never>(() => {}), // Will not even die.
		...overrides,
	} as any;
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "subagent-cancel-"));
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const mailed: Array<{ name: string; kind: string }> = [];
	const manager = new SubagentManager(
		{ onChange: () => {}, onMail: (name, kind) => mailed.push({ name, kind }) },
		{},
	);
	const [agent] = manager.restore([
		{
			id: "w-1",
			name: "worker",
			task: "do the thing",
			cwd: dir,
			contextMode: "fresh",
			status: "running",
			sessionFile,
			sessionDir,
			startedAt: Date.now(),
			usage: emptyUsage(),
			output: "",
			launch: { notesPath: join(dir, "NOTES.md") },
		} as any,
	]);
	agent!.status = "running";
	agent!.busy = true;
	agent!.client = silentClient();
	return {
		manager,
		agent: agent!,
		mailed,
		client: () => agent!.client as any,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

// --- interrupt: the call that froze the session ---------------------------

test("interrupt returns immediately when the child never acknowledges the abort", () => {
	const f = fixture();
	try {
		// Synchronous by construction now: there is nothing left to await. That is
		// the fix — an acknowledgement means "accepted", not "stopped", so waiting
		// for it bought nothing and cost the whole session.
		const started = Date.now();
		const agent = f.manager.interrupt("worker");
		assert.ok(Date.now() - started < 100);
		assert.equal(agent.status, "interrupted");
		assert.equal(agent.busy, false);
		// The abort was still dispatched: this is fire-and-forget, not skip.
		assert.deepEqual(f.client().sent, ["abort"]);
	} finally {
		f.cleanup();
	}
});

test("interrupt marks abortRequested so the child's settle is not mailed as a result", () => {
	const f = fixture();
	try {
		f.manager.interrupt("worker");
		assert.equal(f.agent.abortRequested, true);
		// The settle that our own abort eventually produces must not look like the
		// child's answer to the task.
		(f.manager as any).handleEvent(f.agent, { type: "agent_settled" });
		assert.equal(f.agent.status, "interrupted");
		assert.deepEqual(f.mailed, []);
	} finally {
		f.cleanup();
	}
});

test("interrupt clears a pending question so the parent stops being asked", () => {
	const f = fixture();
	try {
		(f.manager as any).handleEvent(f.agent, {
			type: "tool_execution_update",
			toolName: "ask_parent",
			partialResult: { details: { questionId: "q-1", question: "which port?" } },
		});
		assert.equal(f.agent.status, "waiting");
		f.manager.interrupt("worker");
		// The child's poll loop died with the interrupt; leaving the question set
		// would keep the footer demanding an answer nobody is waiting for.
		assert.equal(f.agent.pendingQuestion, undefined);
		assert.deepEqual(f.manager.pendingQuestions(), []);
	} finally {
		f.cleanup();
	}
});

test("interrupt records the missing acknowledgement instead of throwing it", async () => {
	const f = fixture();
	try {
		// An abort that rejects fast, standing in for the RPC timeout.
		f.agent.client = silentClient({
			abort: () => Promise.reject(new RpcTimeoutError("abort", 10)),
		});
		f.manager.interrupt("worker");
		// The rejection is handled asynchronously; give the microtask queue a turn.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const last = f.agent.activity.at(-1)?.text ?? "";
		assert.match(last, /abort not acknowledged/);
	} finally {
		f.cleanup();
	}
});

// --- close / stopAll / hibernateAll: bounded teardown ---------------------

test("close returns even when the child's stop() never resolves", async () => {
	const f = fixture();
	try {
		await within(3_000, "close on an unkillable child", f.manager.close("worker", 200));
		assert.equal(f.manager.get("worker"), undefined);
	} finally {
		f.cleanup();
	}
});

test("stopAll returns even when every child's stop() never resolves", async () => {
	const f = fixture();
	try {
		await within(3_000, "stopAll on unkillable children", f.manager.stopAll(200));
		assert.deepEqual(f.manager.list(), []);
	} finally {
		f.cleanup();
	}
});

test("hibernateAll returns its records even when the stops never resolve", async () => {
	const f = fixture();
	try {
		const records = await within(3_000, "hibernateAll", f.manager.hibernateAll(200));
		// The records are taken before anything is stopped, precisely so that a
		// hung teardown cannot cost the human their children on reload.
		assert.deepEqual(records.map((r) => r.name), ["worker"]);
		assert.equal(f.agent.status, "hibernated");
		assert.equal(f.agent.client, undefined);
	} finally {
		f.cleanup();
	}
});

test("the idle sweep returns even when a hibernating child will not die", async () => {
	const f = fixture();
	try {
		f.agent.status = "completed";
		f.agent.busy = false;
		// `lastActiveAt` is the max of all three, so startedAt has to move too.
		f.agent.startedAt = Date.now() - 90 * 60_000;
		f.agent.endedAt = Date.now() - 60 * 60_000;
		f.agent.lastEventAt = f.agent.endedAt;
		// A timer callback that never returns is the same wedge with no user
		// action to blame it on.
		await within(4_000, "sweepIdle", f.manager.sweepIdle());
		assert.equal(f.agent.status, "hibernated");
	} finally {
		f.cleanup();
	}
});

// --- send / retry: bounded, cancellable delivery --------------------------

test("send rejects rather than hanging when the child never acknowledges", async () => {
	const f = fixture();
	try {
		f.agent.busy = false;
		f.agent.client = new ChildRpc({ cwd: process.cwd(), args: [] });
		// Fake just enough of a live process: writes go nowhere, nothing answers.
		(f.agent.client as any).child = { stdin: { write: () => true } };
		await within(
			2_000,
			"send to a silent child",
			assert.rejects(
				() => f.manager.send("worker", "hello", "followUp", { timeoutMs: 100 }),
				/did not acknowledge/,
			),
		);
	} finally {
		f.cleanup();
	}
});

test("send is cancelled by the caller's abort signal", async () => {
	const f = fixture();
	try {
		f.agent.busy = false;
		f.agent.client = new ChildRpc({ cwd: process.cwd(), args: [] });
		(f.agent.client as any).child = { stdin: { write: () => true } };
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		await within(
			2_000,
			"send cancelled by Escape",
			assert.rejects(
				() => f.manager.send("worker", "hello", "followUp", { signal: controller.signal }),
				/was cancelled/,
			),
		);
	} finally {
		f.cleanup();
	}
});

test("retry escalates to replacing the process when the abort is never acknowledged", async () => {
	const f = fixture();
	try {
		let revived = 0;
		// The escalation is the point: an abort that goes unanswered means the
		// process is beyond talking to, and the conversation is rescued by a new
		// one on the same session file.
		(f.manager as any).revive = async () => {
			revived += 1;
			f.agent.client = silentClient({ prompt: async () => ({ success: true }) });
			return f.agent;
		};
		f.agent.client = silentClient({
			abort: () => Promise.reject(new RpcTimeoutError("abort", 10)),
		});
		const result = await within(3_000, "retry on a wedged child", f.manager.retry("worker"));
		assert.equal(result.revived, true);
		assert.equal(revived, 1);
	} finally {
		f.cleanup();
	}
});

test("retry does not restart the child when the caller cancelled", async () => {
	const f = fixture();
	try {
		let revived = 0;
		(f.manager as any).revive = async () => {
			revived += 1;
			return f.agent;
		};
		const controller = new AbortController();
		controller.abort();
		f.agent.client = silentClient({
			abort: () => Promise.reject(new RpcAbortedError("abort")),
		});
		await within(
			2_000,
			"retry cancelled by Escape",
			assert.rejects(() => f.manager.retry("worker", undefined, { signal: controller.signal })),
		);
		// Escape is not evidence that the child is wedged; restarting a process
		// nobody is waiting for would be a destructive misreading of it.
		assert.equal(revived, 0);
	} finally {
		f.cleanup();
	}
});

// --- ask_parent liveness on the parent side -------------------------------

test("a child blocked on a question cannot wedge the parent", async () => {
	const f = fixture();
	try {
		(f.manager as any).handleEvent(f.agent, {
			type: "tool_execution_update",
			toolName: "ask_parent",
			partialResult: { details: { questionId: "q-1", question: "which port?" } },
		});
		assert.equal(f.agent.status, "waiting");

		// Every parent-side operation on a blocked child must still return. The
		// child waits forever by design; the parent never waits for the child.
		await within(1_000, "answer", f.manager.answer("worker", "8080"));
		f.manager.interrupt("worker");
		await within(3_000, "close", f.manager.close("worker", 200));
	} finally {
		f.cleanup();
	}
});

test("answer never waits for the child to pick the answer up", async () => {
	const f = fixture();
	try {
		(f.manager as any).handleEvent(f.agent, {
			type: "tool_execution_update",
			toolName: "ask_parent",
			partialResult: { details: { questionId: "q-1", question: "which port?" } },
		});
		// The stub client never reads anything and never emits tool_execution_end.
		// `answer` must still return: it writes a file and publishes, nothing more.
		const started = Date.now();
		const { delivered } = await within(1_000, "answer", f.manager.answer("worker", "8080"));
		assert.equal(delivered, true);
		assert.ok(Date.now() - started < 500);
	} finally {
		f.cleanup();
	}
});

test("a question raised while the parent is mid-turn is still enqueued", () => {
	const f = fixture();
	try {
		// The manager cannot observe parent idleness and must not try to: the
		// enqueue is the guarantee, the delivery timing is index.ts's optimisation.
		(f.manager as any).handleEvent(f.agent, {
			type: "tool_execution_update",
			toolName: "ask_parent",
			partialResult: { details: { questionId: "q-1", question: "which port?" } },
		});
		const queued = f.manager.mailbox.peek().filter((e) => e.kind === "question");
		assert.equal(queued.length, 1);
		assert.deepEqual(f.mailed, [{ name: "worker", kind: "question" }]);
	} finally {
		f.cleanup();
	}
});

test("a child that dies while blocked does not leave a phantom question", () => {
	const f = fixture();
	try {
		(f.manager as any).handleEvent(f.agent, {
			type: "tool_execution_update",
			toolName: "ask_parent",
			partialResult: { details: { questionId: "q-1", question: "which port?" } },
		});
		assert.equal(f.manager.pendingQuestions().length, 1);

		// Its poll loop died with it. Left set, the footer would say "1 waiting for
		// you" forever and `answer()` would report delivering to a dead process.
		(f.manager as any).handleExit(f.agent, { code: 1, signal: null });
		assert.deepEqual(f.manager.pendingQuestions(), []);
		assert.equal(f.agent.status, "failed");
	} finally {
		f.cleanup();
	}
});

test("a child re-announcing a question the parent forgot is heard again", () => {
	const f = fixture();
	const ask = {
		type: "tool_execution_update",
		toolName: "ask_parent",
		partialResult: { details: { questionId: "q-1", question: "which port?" } },
	};
	try {
		(f.manager as any).handleEvent(f.agent, ask);
		assert.equal(f.manager.mailbox.peek().filter((e) => e.kind === "question").length, 1);

		// Still remembered: a repeat is a no-op, so the child can re-announce as
		// often as it likes without spamming the orchestrator.
		(f.manager as any).handleEvent(f.agent, ask);
		assert.equal(f.manager.mailbox.peek().filter((e) => e.kind === "question").length, 1);

		// Now the parent forgets — exactly what a reload, a revive or an interrupt
		// does. The child is still blocked, so its next re-announcement must land.
		f.agent.pendingQuestion = undefined;
		f.manager.mailbox.drain(f.agent.id);
		(f.manager as any).handleEvent(f.agent, ask);
		assert.equal(f.agent.pendingQuestion?.id, "q-1");
		assert.equal(f.manager.mailbox.peek().filter((e) => e.kind === "question").length, 1);
	} finally {
		f.cleanup();
	}
});

test("hibernating a blocked child clears the question the parent can no longer serve", async () => {
	const f = fixture();
	try {
		(f.manager as any).handleEvent(f.agent, {
			type: "tool_execution_update",
			toolName: "ask_parent",
			partialResult: { details: { questionId: "q-1", question: "which port?" } },
		});
		await within(3_000, "hibernateAll", f.manager.hibernateAll(200));
		assert.deepEqual(f.manager.pendingQuestions(), []);
	} finally {
		f.cleanup();
	}
});

// --- the diagnostic backstop ----------------------------------------------

test("a bounded await that hits its deadline is reported, not swallowed", async () => {
	const f = fixture();
	const seen: Array<{ what: string; ms: number }> = [];
	const off = onDeadlineExceeded((info) => seen.push(info));
	try {
		// A backstop that trips silently is how this whole class of bug survived a
		// code review: the session stays responsive, so nobody learns the child is
		// wedged until the work quietly fails to arrive.
		await within(3_000, "close", f.manager.close("worker", 100));
		assert.ok(seen.length > 0, "the abandoned stop() was reported");
		assert.match(seen[0]!.what, /closing "worker"/);
		assert.ok(seen[0]!.ms > 0);
	} finally {
		off();
		f.cleanup();
	}
});

test("a throwing deadline listener cannot break liveness", async () => {
	const f = fixture();
	const off = onDeadlineExceeded(() => {
		throw new Error("boom");
	});
	try {
		await within(3_000, "close with a broken diagnostic", f.manager.close("worker", 100));
		assert.equal(f.manager.get("worker"), undefined);
	} finally {
		off();
		f.cleanup();
	}
});

// --- ChildRpc: the per-request bound (S9) ---------------------------------

/** A `ChildRpc` whose writes vanish, so nothing ever responds. */
function mutedRpc(): ChildRpc {
	const client = new ChildRpc({ cwd: process.cwd(), args: [] });
	(client as any).child = { stdin: { write: () => true } };
	return client;
}

test("every request-bearing method rejects on its own deadline", async () => {
	const client = mutedRpc();
	for (const [name, call] of [
		["prompt", () => client.prompt("x", undefined, { timeoutMs: 60 })],
		["steer", () => client.steer("x", { timeoutMs: 60 })],
		["followUp", () => client.followUp("x", { timeoutMs: 60 })],
		["abort", () => client.abort({ timeoutMs: 60 })],
	] as const) {
		await within(
			1_000,
			`${name} on a silent child`,
			assert.rejects(call, (error: Error) => {
				assert.ok(error instanceof RpcTimeoutError, `${name} rejects with RpcTimeoutError`);
				assert.match(error.message, /did not acknowledge/);
				return true;
			}),
		);
	}
	assert.equal(client.pendingCount, 0, "a timed-out request leaves nothing pending");
});

test("every request-bearing method honours an abort signal", async () => {
	const client = mutedRpc();
	for (const [name, call] of [
		["prompt", (s: AbortSignal) => client.prompt("x", undefined, { signal: s })],
		["steer", (s: AbortSignal) => client.steer("x", { signal: s })],
		["followUp", (s: AbortSignal) => client.followUp("x", { signal: s })],
		["abort", (s: AbortSignal) => client.abort({ signal: s })],
	] as const) {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		await within(
			1_000,
			`${name} cancelled`,
			assert.rejects(
				() => call(controller.signal),
				(error: Error) => {
					assert.ok(error instanceof RpcAbortedError, `${name} rejects with RpcAbortedError`);
					return true;
				},
			),
		);
	}
	assert.equal(client.pendingCount, 0, "a cancelled request leaves nothing pending");
});

test("a request with an already-aborted signal is never even sent", async () => {
	const client = mutedRpc();
	const writes: string[] = [];
	(client as any).child = { stdin: { write: (line: string) => (writes.push(line), true) } };
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => client.prompt("x", undefined, { signal: controller.signal }));
	assert.deepEqual(writes, []);
});

test("no caller can opt out of the request ceiling", async () => {
	const client = mutedRpc();
	// A caller asking for a day gets the ceiling; the bound is the invariant, not
	// a default that politeness happens to preserve.
	const started = Date.now();
	const pending = client.prompt("x", undefined, { timeoutMs: 24 * 60 * 60_000 });
	// Reach in and prove the clamp rather than waiting ten seconds for it.
	assert.ok(DEFAULT_REQUEST_TIMEOUT_MS <= 60_000, "the ceiling is on a human timescale");
	(client as any).markExited(1, null, new Error("done"));
	await assert.rejects(() => pending);
	assert.ok(Date.now() - started < 1_000);
});

test("a late response to a timed-out request is dropped, not mis-routed", async () => {
	const client = mutedRpc();
	await assert.rejects(() => client.prompt("x", undefined, { timeoutMs: 30 }));
	// The child eventually answers. Nothing is listening, and nothing must break.
	client.consume(`${JSON.stringify({ type: "response", id: "1", success: true })}\n`);
	assert.equal(client.pendingCount, 0);
});

test("process death settles every pending request at once", async () => {
	const client = mutedRpc();
	const pending = [client.prompt("a"), client.steer("b"), client.abort()];
	assert.equal(client.pendingCount, 3);
	(client as any).markExited(9, null, new Error("subagent process exited"));
	for (const p of pending) await assert.rejects(() => p, /exited/);
	assert.equal(client.pendingCount, 0, "exit clears the timers as well as the promises");
});

// --- a real never-responding process --------------------------------------

/**
 * The end-to-end version, with an actual process.
 *
 * The fakes above prove the shape of the awaits; this proves the shape survives
 * contact with a real pipe, a real SIGTERM and a real child that ignores both.
 */
test("a real child that answers nothing and ignores SIGTERM cannot wedge the parent", async () => {
	const previousBin = process.env.PI_SUBAGENT_BIN;
	const dir = mkdtempSync(join(tmpdir(), "subagent-wedge-"));
	const stub = join(dir, "stub.js");
	// Reads its stdin and drops it on the floor; survives SIGTERM.
	writeFileSync(
		stub,
		"process.on('SIGTERM', () => {});\nprocess.stdin.on('data', () => {});\nsetInterval(() => {}, 1000);\n",
	);
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	process.env.PI_SUBAGENT_BIN = stub;

	const manager = new SubagentManager({ onChange: () => {}, onMail: () => {} }, {});
	manager.restore([
		{
			id: "w-1",
			name: "worker",
			task: "t",
			cwd: dir,
			contextMode: "fresh",
			status: "running",
			sessionFile,
			sessionDir,
			startedAt: Date.now(),
			usage: emptyUsage(),
			output: "",
			launch: { notesPath: join(dir, "NOTES.md") },
		} as any,
	]);

	try {
		await within(10_000, "revive", manager.revive("worker"));
		const agent = manager.get("worker")!;
		agent.busy = true;
		agent.status = "running";

		// Before the fix this hung forever and took the session with it.
		const started = Date.now();
		manager.interrupt("worker");
		assert.ok(Date.now() - started < 500, "interrupt must not wait on the child");

		await within(8_000, "close on a SIGTERM-ignoring child", manager.close("worker", 300));
		assert.equal(manager.get("worker"), undefined);
		await within(4_000, "stopAll", manager.stopAll(300));
	} finally {
		await manager.stopAll(300).catch(() => {});
		if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previousBin;
		rmSync(dir, { recursive: true, force: true });
	}
});

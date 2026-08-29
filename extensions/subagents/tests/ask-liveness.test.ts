/**
 * `ask_parent` liveness, with real processes on both ends of the pipe.
 *
 * The contract is asymmetric on purpose and the asymmetry is the safety
 * property:
 *
 *   - The **child** blocks with no timeout. A guessed answer is worse than a
 *     slow one, and with hibernation a blocked child is recoverable rather
 *     than lost.
 *   - The **parent** never blocks on anything. It enqueues a question and
 *     writes an answer file; it never awaits the child noticing either.
 *
 * If that ever inverted \u2014 if any parent-side path came to await the child \u2014
 * two agents would be waiting on each other with no timeout on either side,
 * which is the freeze this whole change exists to make impossible.
 *
 * These tests drive a stub `pi --mode rpc` that speaks the real protocol: it
 * emits a `tool_execution_update` for `ask_parent` and then genuinely polls the
 * answers directory, exactly as `child-extension.ts` does.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerPath, answersDirectory } from "../ask.ts";
import { SubagentManager } from "../manager.ts";
import { emptyUsage } from "../types.ts";

/**
 * A child that asks a question and then blocks, for real.
 *
 * It answers the RPC handshake (so the manager can talk to it), announces the
 * question through the event stream the way pi forwards `onUpdate`, and then
 * polls `PI_SUBAGENT_ANSWERS` until the file appears — at which point it emits
 * `tool_execution_end` and settles. Nothing about it is mocked except the
 * model.
 */
const ASKING_STUB = `
const fs = require("node:fs");
const path = require("node:path");
const answersDir = process.env.PI_SUBAGENT_ANSWERS;
const questionId = "q-live-1";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    say({ type: "response", id: message.id, success: true });
    if (message.type === "prompt" || message.type === "follow_up") ask();
  }
});
function say(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function ask() {
  say({
    type: "tool_execution_update",
    toolName: "ask_parent",
    partialResult: { details: { questionId, question: "which port?", context: "8080 or 3000" } },
  });
  const file = path.join(answersDir, questionId + ".json");
  const poll = setInterval(() => {
    let raw;
    try { raw = fs.readFileSync(file, "utf-8"); } catch { return; }
    let answer;
    try { answer = JSON.parse(raw); } catch { return; }
    clearInterval(poll);
    say({ type: "tool_execution_end", toolName: "ask_parent", result: { details: { questionId } } });
    say({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "using " + answer.answer }] },
    });
    say({ type: "agent_settled" });
  }, 50);
}
setInterval(() => {}, 1000);
`;

function fixture(stubSource = ASKING_STUB) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-ask-live-"));
	const stub = join(dir, "stub.js");
	writeFileSync(stub, stubSource);
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);

	const previousBin = process.env.PI_SUBAGENT_BIN;
	process.env.PI_SUBAGENT_BIN = stub;

	const mailed: Array<{ name: string; kind: string }> = [];
	const manager = new SubagentManager(
		{ onChange: () => {}, onMail: (name, kind) => mailed.push({ name, kind }) },
		{},
	);
	manager.restore([
		{
			id: "asker-1",
			name: "asker",
			task: "pick a port",
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

	return {
		manager,
		mailed,
		sessionDir,
		async cleanup() {
			await manager.stopAll(500);
			if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previousBin;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Wait for a predicate, or fail rather than hang the suite. */
async function until(what: string, predicate: () => boolean, ms = 8_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

test("a real child blocks on its question while the parent stays free", async () => {
	const f = fixture();
	try {
		await f.manager.send("asker", "go", "followUp");
		const agent = f.manager.get("asker")!;
		await until("the question to arrive", () => agent.status === "waiting");
		assert.equal(agent.pendingQuestion?.id, "q-live-1");
		assert.deepEqual(f.mailed.at(-1), { name: "asker", kind: "question" });

		// The child is genuinely blocked right now. Every parent-side call must
		// still return promptly — that is the whole safety property.
		const started = Date.now();
		f.manager.list();
		f.manager.pendingQuestions();
		f.manager.snapshots();
		assert.ok(Date.now() - started < 2_000, "the parent never waits for a blocked child");
	} finally {
		await f.cleanup();
	}
});

test("answering unblocks the real child, in the same turn", async () => {
	const f = fixture();
	try {
		await f.manager.send("asker", "go", "followUp");
		const agent = f.manager.get("asker")!;
		await until("the question", () => agent.status === "waiting");

		const { delivered } = await f.manager.answer("asker", "8080");
		assert.equal(delivered, true);
		// Written where the child is actually looking.
		const file = answerPath(answersDirectory(f.sessionDir), "q-live-1");
		assert.equal(existsSync(file), true);
		assert.match(readFileSync(file, "utf-8"), /8080/);

		// The child picks it up and carries on without a new prompt: it never left
		// its turn, which is the point of announcing through onUpdate.
		await until("the child to finish", () => agent.status === "completed");
		assert.match(agent.output, /using 8080/);
		assert.deepEqual(f.mailed.map((m) => m.kind), ["question", "final"]);
	} finally {
		await f.cleanup();
	}
});

test("interrupting a really-blocked child returns instantly and frees the parent", async () => {
	const f = fixture();
	try {
		await f.manager.send("asker", "go", "followUp");
		const agent = f.manager.get("asker")!;
		await until("the question", () => agent.status === "waiting");

		const started = Date.now();
		f.manager.interrupt("asker");
		assert.ok(Date.now() - started < 200);
		assert.equal(agent.status, "interrupted");
		// And the parent is no longer being asked for something nobody wants.
		assert.deepEqual(f.manager.pendingQuestions(), []);
	} finally {
		await f.cleanup();
	}
});

test("closing a really-blocked child does not hang on its poll loop", async () => {
	const f = fixture();
	try {
		await f.manager.send("asker", "go", "followUp");
		await until("the question", () => f.manager.get("asker")!.status === "waiting");

		const started = Date.now();
		await f.manager.close("asker", 500);
		assert.ok(Date.now() - started < 5_000, "close must not wait out the child");
		assert.equal(f.manager.get("asker"), undefined);
	} finally {
		await f.cleanup();
	}
});

test("a child that dies while blocked stops being counted as waiting", async () => {
	const f = fixture();
	try {
		await f.manager.send("asker", "go", "followUp");
		const agent = f.manager.get("asker")!;
		await until("the question", () => agent.status === "waiting");

		// Killed from outside: the poll loop is gone, so the question can never be
		// read. Continuing to offer it would be a lie the footer keeps telling.
		process.kill(agent.client!.pid!, "SIGKILL");
		await until("the exit to be observed", () => agent.status === "failed");
		assert.deepEqual(f.manager.pendingQuestions(), []);
		assert.equal(agent.pendingQuestion, undefined);
	} finally {
		await f.cleanup();
	}
});

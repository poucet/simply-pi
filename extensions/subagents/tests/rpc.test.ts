import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChildRpc, piInvocation, type RpcEvent } from "../rpc.ts";

function collector(): { client: ChildRpc; events: RpcEvent[] } {
	const client = new ChildRpc({ cwd: process.cwd(), args: [] });
	const events: RpcEvent[] = [];
	client.onEvent((event) => events.push(event));
	return { client, events };
}

// --- piInvocation ---------------------------------------------------------

test("piInvocation honours PI_SUBAGENT_BIN for a script path", () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	process.env.PI_SUBAGENT_BIN = "/tmp/fake-pi.js";
	try {
		const invocation = piInvocation(["--mode", "rpc"]);
		assert.equal(invocation.command, process.execPath);
		assert.deepEqual(invocation.args, ["/tmp/fake-pi.js", "--mode", "rpc"]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previous;
	}
});

test("piInvocation honours PI_SUBAGENT_BIN for a binary", () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	process.env.PI_SUBAGENT_BIN = "/usr/local/bin/pi";
	try {
		assert.deepEqual(piInvocation(["--mode", "rpc"]), {
			command: "/usr/local/bin/pi",
			args: ["--mode", "rpc"],
		});
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previous;
	}
});

test("piInvocation does not re-enter a non-CLI entry point", () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	delete process.env.PI_SUBAGENT_BIN;
	try {
		// argv[1] here is the test runner, not the pi CLI: we must not spawn it.
		const invocation = piInvocation(["--mode", "rpc"]);
		assert.notEqual(invocation.args[0], process.argv[1]);
		assert.equal(invocation.command, "pi");
		assert.deepEqual(invocation.args, ["--mode", "rpc"]);
	} finally {
		if (previous !== undefined) process.env.PI_SUBAGENT_BIN = previous;
	}
});

// --- JSONL framing --------------------------------------------------------

test("consume parses one whole line", () => {
	const { client, events } = collector();
	client.consume(`${JSON.stringify({ type: "agent_settled" })}\n`);
	assert.deepEqual(events, [{ type: "agent_settled" }]);
});

test("consume reassembles a record split across chunks", () => {
	const { client, events } = collector();
	const line = JSON.stringify({ type: "message_end", message: { role: "assistant" } });
	for (const piece of [line.slice(0, 7), line.slice(7, 20), line.slice(20), "\n"]) {
		client.consume(piece);
	}
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "message_end");
});

test("consume splits multiple records in one chunk and buffers the partial tail", () => {
	const { client, events } = collector();
	client.consume('{"type":"a"}\n{"type":"b"}\n{"type":"c"');
	assert.deepEqual(events.map((e) => e.type), ["a", "b"]);
	client.consume('}\n');
	assert.deepEqual(events.map((e) => e.type), ["a", "b", "c"]);
});

test("consume tolerates CRLF line endings", () => {
	const { client, events } = collector();
	client.consume('{"type":"a"}\r\n{"type":"b"}\r\n');
	assert.deepEqual(events.map((e) => e.type), ["a", "b"]);
});

test("consume does not split on U+2028/U+2029 inside a JSON string", () => {
	const { client, events } = collector();
	// A raw U+2028 is legal inside a JSON string; `readline` would split here.
	client.consume(`{"type":"text","text":"a\u2028b\u2029c"}\n`);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.text, "a\u2028b\u2029c");
});

test("consume ignores blank lines and non-JSON noise", () => {
	const { client, events } = collector();
	client.consume('\n   \nnot json at all\n{"type":"a"}\n');
	assert.deepEqual(events.map((e) => e.type), ["a"]);
});

test("consume routes responses to callers, not to event listeners", () => {
	const { client, events } = collector();
	client.consume('{"type":"response","id":"1","success":true}\n');
	assert.deepEqual(events, []);
});

test("a throwing event listener does not stop the pump", () => {
	const { client, events } = collector();
	client.onEvent(() => {
		throw new Error("boom");
	});
	client.consume('{"type":"a"}\n{"type":"b"}\n');
	assert.deepEqual(events.map((e) => e.type), ["a", "b"]);
});

// --- lifecycle ------------------------------------------------------------

test("stop() on a never-started client resolves immediately", async () => {
	const { client } = collector();
	await client.stop(10);
	assert.equal(client.running, false);
});

test("stop() returns promptly for a child killed by a signal", async () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	const dir = mkdtempSync(join(tmpdir(), "subagent-rpc-"));
	const script = join(dir, "stubborn.js");
	// A child that ignores SIGTERM and never speaks the protocol: `stop()` must
	// still return (S1: exitCode stays null when a signal kills the process).
	writeFileSync(script, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);\n");
	process.env.PI_SUBAGENT_BIN = script;
	const client = new ChildRpc({ cwd: process.cwd(), args: [] });
	const exits: unknown[] = [];
	client.onExit((exit) => exits.push(exit));
	try {
		await client.start();
		assert.equal(client.running, true);
		const started = Date.now();
		await client.stop(200);
		assert.equal(client.running, false);
		assert.ok(Date.now() - started < 5000, "stop() must not hang");
		assert.equal(exits.length, 1);
		await client.stop(200); // Idempotent, and still must not hang.
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a dead child reports its exit and writes do not crash the parent", async () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	const dir = mkdtempSync(join(tmpdir(), "subagent-rpc-"));
	const script = join(dir, "crash.js");
	writeFileSync(script, "setTimeout(() => process.exit(7), 200);\n");
	process.env.PI_SUBAGENT_BIN = script;
	const client = new ChildRpc({ cwd: process.cwd(), args: [] });
	const exits: Array<{ code: number | null }> = [];
	try {
		await client.start();
		const seen = new Promise<void>((resolve) => client.onExit((exit) => (exits.push(exit), resolve())));
		await seen;
		assert.equal(exits.length, 1);
		assert.equal(exits[0]!.code, 7);
		assert.equal(client.running, false);
		// S10: writing to a dead child must reject, not raise an uncaught EPIPE.
		await assert.rejects(() => client.prompt("anyone there?"));
		await client.stop(100);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- pending-line cap (a child must not be able to OOM the parent) --------

test("consume leaves normal traffic alone, however it is chunked", () => {
	const { client, events } = collector();
	// Well under the cap, but far larger than a typical frame: a big event must
	// still go through, and a burst of complete lines in one chunk must not trip
	// the cap even if the chunk itself is large.
	const big = "x".repeat(2 * 1024 * 1024);
	client.consume(`${JSON.stringify({ type: "big", text: big })}\n`);
	client.consume(`${JSON.stringify({ type: "a" })}\n${JSON.stringify({ type: "b" })}\n`);
	assert.deepEqual(
		events.map((event) => event.type),
		["big", "a", "b"],
	);
	assert.equal(client.running, false, "no process was started, so nothing to kill");
});

test("consume caps an unterminated line and fails the client with a diagnostic", () => {
	const { client, events } = collector();
	const exits: Array<{ code: number | null; signal: string | null }> = [];
	client.onExit((exit) => exits.push(exit as any));

	// A runaway child: megabytes with no newline in sight.
	const head = "HEAD-MARKER";
	const tailMarker = "TAIL-MARKER";
	client.consume(head);
	for (let i = 0; i < 15; i += 1) client.consume("y".repeat(1024 * 1024));
	// This is the chunk that crosses the cap, so it is the one whose tail is quoted.
	client.consume(`${"y".repeat(1024 * 1024)}${tailMarker}`);

	assert.equal(events.length, 0, "nothing was ever a complete line");
	assert.equal(exits.length, 1, "the breach fails the client exactly once");

	// The client is now unusable, and says why.
	assert.equal(client.running, false);
	return assert.rejects(
		() => client.prompt("still there?"),
		(error: Error) => {
			assert.match(error.message, /with no newline/);
			assert.match(error.message, /limit 16777216/);
			assert.match(error.message, new RegExp(head), "diagnostic quotes the start");
			assert.match(error.message, new RegExp(tailMarker), "diagnostic quotes the end");
			return true;
		},
	);
});

test("the cap is only tripped by data with no newline in it", () => {
	const { client, events } = collector();
	// 20MB delivered as complete 1MB lines: cumulative volume is irrelevant,
	// only what is left pending after framing.
	for (let i = 0; i < 20; i += 1) {
		client.consume(`${JSON.stringify({ type: "chunk", i, pad: "z".repeat(1024 * 1024) })}\n`);
	}
	assert.equal(events.length, 20);
});

// --- process-group kill ---------------------------------------------------

test("stop() signals the process group, not just the child pid", async () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	const dir = mkdtempSync(join(tmpdir(), "subagent-rpc-"));
	const script = join(dir, "ignores-term.js");
	// Ignores SIGTERM, so the only way it dies is the SIGKILL escalation.
	writeFileSync(script, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
	process.env.PI_SUBAGENT_BIN = script;
	const client = new ChildRpc({ cwd: process.cwd(), args: [] });
	const signalled: Array<{ pid: number; signal: string }> = [];
	const realKill = process.kill.bind(process);
	(process as any).kill = (pid: number, signal?: any) => {
		signalled.push({ pid, signal: String(signal) });
		return realKill(pid, signal);
	};
	try {
		await client.start();
		const pid = client.pid!;
		await client.stop(150);
		assert.equal(client.running, false);
		// Negative pid == "the whole group", which is the entire point.
		assert.ok(
			signalled.some((entry) => entry.pid === -pid && entry.signal === "SIGTERM"),
			`expected SIGTERM to -${pid}, saw ${JSON.stringify(signalled)}`,
		);
		assert.ok(
			signalled.some((entry) => entry.pid === -pid && entry.signal === "SIGKILL"),
			`expected SIGKILL to -${pid}, saw ${JSON.stringify(signalled)}`,
		);
		assert.ok(
			!signalled.some((entry) => entry.pid === pid),
			"the bare pid must never be signalled while the group call succeeds",
		);
	} finally {
		(process as any).kill = realKill;
		if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stop() kills a grandchild the subagent left running", async () => {
	const previous = process.env.PI_SUBAGENT_BIN;
	const dir = mkdtempSync(join(tmpdir(), "subagent-rpc-"));
	const grandchildPidFile = join(dir, "grandchild.pid");
	const script = join(dir, "spawns-a-server.js");
	// The real shape of the bug: a subagent that started `npm test` or a dev
	// server. Killing only the subagent's pid leaves this running forever.
	writeFileSync(
		script,
		`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(kid.pid));
setInterval(() => {}, 1000);
`,
	);
	process.env.PI_SUBAGENT_BIN = script;
	const client = new ChildRpc({ cwd: process.cwd(), args: [] });
	try {
		await client.start();
		const { readFileSync } = await import("node:fs");
		const grandchild = Number(readFileSync(grandchildPidFile, "utf8"));
		assert.ok(grandchild > 0, "the stub must have recorded its child's pid");
		assert.doesNotThrow(() => process.kill(grandchild, 0), "grandchild should be alive");

		await client.stop(300);

		// Signals are asynchronous; give the OS a moment to reap.
		let alive = true;
		for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			try {
				process.kill(grandchild, 0);
			} catch {
				alive = false;
			}
		}
		assert.equal(alive, false, `grandchild ${grandchild} survived stop()`);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
		else process.env.PI_SUBAGENT_BIN = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

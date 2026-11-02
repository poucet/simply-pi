/**
 * Reviving a hibernated child, with a real process.
 *
 * A stub stands in for `pi --mode rpc` (via `PI_SUBAGENT_BIN`): it records the
 * argv it was launched with and answers the JSONL protocol. That is enough to
 * prove the two things that actually matter and cannot be checked by inspecting
 * state — that a revived child is launched on its *existing* session file, and
 * that sending to a hibernated agent starts a process before delivering.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SubagentManager } from "../manager.ts";
import { emptyUsage } from "../types.ts";

/**
 * A stub child: logs its argv, answers every command, and stays alive.
 *
 * It never emits `agent_settled`, so the agent stays busy — which is also what
 * a network-partitioned child looks like from out here.
 */
const STUB = `
const fs = require("node:fs");
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
fs.appendFileSync(process.env.STUB_ENV_LOG, JSON.stringify({
  PI_SUBAGENT: process.env.PI_SUBAGENT,
  PI_SUBAGENT_NAME: process.env.PI_SUBAGENT_NAME,
  PI_SUBAGENT_PARENT: process.env.PI_SUBAGENT_PARENT,
  PI_SUBAGENT_NOTES: process.env.PI_SUBAGENT_NOTES,
  PI_SUBAGENT_ANSWERS: process.env.PI_SUBAGENT_ANSWERS,
  PI_SUBAGENT_MCP: process.env.PI_SUBAGENT_MCP,
}) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    fs.appendFileSync(process.env.STUB_CMD_LOG, line + "\\n");
    process.stdout.write(JSON.stringify({ type: "response", id: message.id, success: true }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_start", role: "assistant" }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;

/**
 * A manager whose extension discovery is scripted.
 *
 * The real `resolveChildExtensions` drives pi's `DefaultPackageManager` across
 * the developer's actual filesystem, which is neither reproducible nor the thing
 * under test here: what matters is what `revive` *does* with the answer.
 */
class ScriptedManager extends SubagentManager {
	/** What discovery returns; `undefined` makes it throw, as a timeout would. */
	discovery: string[] | undefined = [];
	discoveryCalls = 0;
	protected override async resolveChildExtensions(): Promise<string[]> {
		this.discoveryCalls += 1;
		// Mirrors the real method's contract exactly: it swallows its own failures
		// and returns `[]`, which is why an empty result cannot be trusted to mean
		// "no extensions" (see `refreshChildExtensions`).
		return this.discovery ?? [];
	}
}

function fixture(options: { extensions?: string[]; mcpScope?: string[] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-revive-"));
	const stub = join(dir, "stub.js");
	writeFileSync(stub, STUB);
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const argvLog = join(dir, "argv.log");
	const cmdLog = join(dir, "cmd.log");
	const envLog = join(dir, "env.log");
	writeFileSync(argvLog, "");
	writeFileSync(cmdLog, "");
	writeFileSync(envLog, "");

	const previousBin = process.env.PI_SUBAGENT_BIN;
	process.env.PI_SUBAGENT_BIN = stub;
	process.env.STUB_ARGV_LOG = argvLog;
	process.env.STUB_CMD_LOG = cmdLog;
	process.env.STUB_ENV_LOG = envLog;

	const drift: Array<{ agent: string; recorded: string[]; resolved: string[] | undefined }> = [];
	const manager = new ScriptedManager(
		{
			onChange: () => {},
			onMail: () => {},
			onExtensionDrift: (agent, recorded, resolved) =>
				drift.push({ agent: agent.name, recorded, resolved }),
		},
		{ stallSeconds: 120, parentSessionId: "parent-uuid" },
	);
	manager.restore([
		{
			id: "worker-1",
			sessionId: "child-uuid",
			parentSessionId: "parent-uuid",
			name: "worker",
			task: "finish the refactor",
			cwd: dir,
			contextMode: "forked",
			status: "running",
			sessionFile,
			sessionDir,
			startedAt: Date.now() - 60_000,
			usage: { ...emptyUsage(), turns: 3 },
			output: "half done",
			launch: {
				model: "test/model",
				notesPath: join(dir, "NOTES.md"),
				...(options.extensions ? { extensions: options.extensions } : {}),
				...(options.mcpScope ? { mcpScope: options.mcpScope } : {}),
			},
		},
	]);

	return {
		manager,
		drift,
		dir,
		sessionFile,
		sessionDir,
		argv: () =>
			readFileSync(argvLog, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]),
		commands: () =>
			readFileSync(cmdLog, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		childEnv: () =>
			readFileSync(envLog, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, string | undefined>),
		async cleanup() {
			await manager.stopAll(500);
			if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previousBin;
			delete process.env.STUB_ARGV_LOG;
			delete process.env.STUB_CMD_LOG;
			delete process.env.STUB_ENV_LOG;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("revive launches pi on the child's existing session file", async () => {
	const f = fixture();
	try {
		const agent = await f.manager.revive("worker");
		assert.equal(agent.status, "idle");
		assert.equal(agent.client?.running, true);

		const [argv] = f.argv();
		assert.ok(argv, "the child was launched");
		// The whole point: same session file, same session dir, so the child
		// resumes its conversation instead of starting an empty one.
		assert.equal(argv[argv.indexOf("--session") + 1], f.sessionFile);
		assert.equal(argv[argv.indexOf("--session-dir") + 1], f.sessionDir);
		assert.ok(argv.includes("--mode") && argv.includes("rpc"));
		// "Inherit minus a denylist" is expressed as --no-extensions plus an
		// explicit -e per survivor, because the CLI has no per-extension exclude.
		assert.ok(argv.includes("--no-extensions"));
		assert.ok(argv.includes("-e"), "child-extension.ts is still loaded explicitly");
		// This agent was restored with no inherited extensions recorded and discovery
		// finds none, so the only -e is the child extension itself.
		const loaded = argv.filter((a, i) => argv[i - 1] === "-e");
		assert.equal(loaded.length, 1);
		assert.match(loaded[0]!, /child-extension\.ts$/);
		assert.equal(argv[argv.indexOf("--model") + 1], "test/model");
		// No seeding: the session file must not be rewritten under the child.
		assert.equal(
			readFileSync(f.sessionFile, "utf-8").trim().split("\n").length,
			1,
			"revive must not re-seed the session",
		);
	} finally {
		await f.cleanup();
	}
});

test("a child is booted with the flag, and with identity carried separately", async () => {
	const f = fixture();
	try {
		await f.manager.revive("worker");
		const [env] = f.childEnv();
		assert.ok(env, "the child recorded its environment");
		// The boot flag: one bit, set before any session exists, which is all the UI
		// guard in index.ts is allowed to consult.
		assert.equal(env!.PI_SUBAGENT, "1");
		// The parent's uuid travels separately, as plumbing rather than as identity.
		assert.equal(env!.PI_SUBAGENT_PARENT, "parent-uuid");
		// The name is still passed, but only as a label for logs and notes entries.
		assert.equal(env!.PI_SUBAGENT_NAME, "worker");
		assert.match(String(env!.PI_SUBAGENT_ANSWERS), /answers$/);
	} finally {
		await f.cleanup();
	}
});

test("sending to a hibernated agent revives it and then delivers", async () => {
	const f = fixture();
	try {
		const agent = await f.manager.send("worker", "carry on", "followUp");
		assert.equal(agent.status, "running");
		assert.equal(agent.busy, true);
		assert.equal(f.argv().length, 1, "exactly one process was started");
		const commands = f.commands();
		assert.deepEqual(
			commands.map((c) => c.type),
			["prompt"],
			"a revived child is prompted, not steered",
		);
		assert.equal(commands[0]!.message, "carry on");
		// The revive counts as activity, so the agent is not instantly stalled.
		assert.ok(agent.lastEventAt !== undefined);
	} finally {
		await f.cleanup();
	}
});

test("revive is a no-op while the child is already running", async () => {
	const f = fixture();
	try {
		await f.manager.revive("worker");
		await f.manager.revive("worker");
		// A second process writing the same session file would interleave entries.
		assert.equal(f.argv().length, 1);
	} finally {
		await f.cleanup();
	}
});

test("retry re-prompts a stalled child on the same conversation", async () => {
	const f = fixture();
	try {
		await f.manager.send("worker", "carry on", "followUp");
		const agent = f.manager.get("worker")!;
		// Pretend the connection died three minutes ago.
		agent.lastEventAt = Date.now() - 180_000;
		f.manager.sweepStalls();
		assert.equal(agent.status, "stalled");

		const { agent: after, revived } = await f.manager.retry("worker");
		assert.equal(after.status, "running");
		assert.equal(revived, false, "the stub answers its abort, so no restart is needed");
		assert.equal(f.argv().length, 1, "the same process was reused");
		assert.deepEqual(
			f.commands().map((c) => c.type),
			["prompt", "abort", "prompt"],
		);
		// The re-prompt carries the task so the child knows what to resume.
		assert.match(f.commands().at(-1)!.message, /finish the refactor/);
		assert.equal(after.stallNotifiedAt, undefined);
	} finally {
		await f.cleanup();
	}
});

test("a dead child is revived rather than abandoned", async () => {
	const f = fixture();
	try {
		await f.manager.revive("worker");
		const agent = f.manager.get("worker")!;
		// The process goes away underneath us; the exit handler marks it failed.
		agent.client!.stop(200);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(agent.client?.running, false);

		const { revived } = await f.manager.retry("worker");
		assert.equal(revived, true);
		assert.equal(f.argv().length, 2, "a fresh process on the same session file");
		assert.equal(f.argv()[1]![f.argv()[1]!.indexOf("--session") + 1], f.sessionFile);
	} finally {
		await f.cleanup();
	}
});

test("stopAll leaves no child processes behind", async () => {
	const f = fixture();
	try {
		await f.manager.revive("worker");
		const pid = f.manager.get("worker")!.client!.pid!;
		const started = Date.now();
		await f.manager.stopAll(1000);
		assert.ok(Date.now() - started < 3000, "shutdown must be fast, not per-child serial");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.throws(() => process.kill(pid, 0), /ESRCH/, "the child process is gone");
	} finally {
		await f.cleanup();
	}
});

test("hibernateAll stops the processes but keeps the agents restorable", async () => {
	const f = fixture();
	try {
		await f.manager.revive("worker");
		const pid = f.manager.get("worker")!.client!.pid!;
		const records = await f.manager.hibernateAll(1000);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		assert.equal(records.length, 1);
		assert.equal(records[0]!.sessionFile, f.sessionFile);
		const agent = f.manager.get("worker")!;
		assert.equal(agent.status, "hibernated");
		// A stop we asked for is not a crash: no error mail, no "failed".
		assert.equal(agent.error, undefined);
		assert.equal(f.manager.mailbox.size, 0);
	} finally {
		await f.cleanup();
	}
});

test("reviving respects the process cap without counting the agent itself", async () => {
	const f = fixture();
	try {
		// A full table of other children already holds every process slot.
		for (let i = 0; i < f.manager.maxOpenAgents; i += 1) {
			const [other] = f.manager.restore([
				{
					id: `other-${i}`,
					name: `other-${i}`,
					task: "t",
					cwd: f.dir,
					contextMode: "fresh",
					status: "running",
					sessionFile: f.sessionFile,
					sessionDir: f.sessionDir,
					startedAt: 0,
					usage: { ...emptyUsage() },
					output: "",
					launch: { notesPath: "/n" },
				},
			]);
			other!.status = "running"; // Occupying a slot, as a live child would.
		}
		await assert.rejects(() => f.manager.revive("worker"), /too many open subagents/);
		assert.equal(f.argv().length, 0, "no process was started");
	} finally {
		await f.cleanup();
	}
});

// --- re-resolving extensions on revive -------------------------------------
//
// The launch spec records absolute paths captured at spawn, and `createClient`
// skips any that no longer exist. That combination silently un-equips every
// hibernated child the moment an extension moves on disk — no error, no log,
// just a child that comes back less capable than it went away. A revive
// therefore asks discovery again rather than replaying the recorded answer.

test("a moved extension is found at its new path instead of being dropped", async () => {
	const f = fixture({ extensions: ["/old/place/model-routing.ts"] });
	try {
		// The extension moved: the recorded path is gone, discovery knows the new one.
		f.manager.discovery = ["/new/place/model-routing.ts"];
		await f.manager.revive("worker");

		const [argv] = f.argv();
		const loaded = argv!.filter((a, i) => argv![i - 1] === "-e");
		// Before this change the recorded path failed `existsSync` and the child
		// launched with the child extension alone.
		assert.deepEqual(
			loaded.filter((p) => !p.endsWith("child-extension.ts")),
			["/new/place/model-routing.ts"],
		);
	} finally {
		await f.cleanup();
	}
});

test("the registry's stored paths are refreshed, not left stale", async () => {
	const f = fixture({ extensions: ["/old/place/model-routing.ts"] });
	try {
		f.manager.discovery = ["/new/place/model-routing.ts", "/new/place/mcp/index.ts"];
		await f.manager.revive("worker");
		// The record now describes the child that actually launched. Left stale, the
		// next cold start would replay the same dead path all over again.
		assert.deepEqual(f.manager.get("worker")!.launch.extensions, [
			"/new/place/model-routing.ts",
			"/new/place/mcp/index.ts",
		]);
	} finally {
		await f.cleanup();
	}
});

test("a changed extension set is reported rather than swapped in silently", async () => {
	const f = fixture({ extensions: ["/old/place/model-routing.ts"] });
	try {
		f.manager.discovery = ["/new/place/model-routing.ts"];
		await f.manager.revive("worker");
		assert.equal(f.drift.length, 1);
		assert.deepEqual(f.drift[0]!.recorded, ["/old/place/model-routing.ts"]);
		assert.deepEqual(f.drift[0]!.resolved, ["/new/place/model-routing.ts"]);

		// Said once per agent, not once per revive: a child that hibernates and
		// comes back every few minutes would otherwise repeat itself forever.
		const agent = f.manager.get("worker")!;
		await agent.client!.stop(200);
		await new Promise((resolve) => setTimeout(resolve, 300));
		agent.client = undefined;
		await f.manager.revive("worker");
		assert.equal(f.drift.length, 1);
	} finally {
		await f.cleanup();
	}
});

test("an unchanged extension set says nothing", async () => {
	const f = fixture({ extensions: ["/place/model-routing.ts"] });
	try {
		f.manager.discovery = ["/place/model-routing.ts"];
		await f.manager.revive("worker");
		assert.deepEqual(f.drift, []);
	} finally {
		await f.cleanup();
	}
});

test("discovery failure falls back to the recorded paths rather than failing the revive", async () => {
	const f = fixture({ extensions: ["/place/model-routing.ts"] });
	try {
		// The real method swallows its own errors and returns `[]`, so an empty
		// result is indistinguishable from a timeout. It must not be allowed to
		// strip a child that previously had extensions.
		f.manager.discovery = [];
		const agent = await f.manager.revive("worker");
		assert.equal(agent.status, "idle", "a discovery hiccup does not fail the revive");
		assert.deepEqual(
			agent.launch.extensions,
			["/place/model-routing.ts"],
			"the last known-good paths are kept",
		);
		// The loudest case: those paths may themselves be gone, so it is reported.
		assert.equal(f.drift.length, 1);
		assert.equal(f.drift[0]!.resolved, undefined);
	} finally {
		await f.cleanup();
	}
});

test("the fallback still refuses to pass paths that are gone", async () => {
	// Discovery failed, so the recorded paths are all we have and they are *not*
	// trustworthy — this is the one case the existsSync filter is still for.
	const f = fixture({ extensions: ["/gone/model-routing.ts"] });
	try {
		f.manager.discovery = [];
		await f.manager.revive("worker");
		const [argv] = f.argv();
		const loaded = argv!.filter((a, i) => argv![i - 1] === "-e");
		assert.deepEqual(
			loaded.filter((p) => !p.endsWith("child-extension.ts")),
			[],
			"a dead path is not handed to the child as if it were real",
		);
	} finally {
		await f.cleanup();
	}
});

test("a child that legitimately has no extensions is not reported as drift", async () => {
	// Recorded empty, discovered empty: nothing changed and nothing was lost.
	const f = fixture();
	try {
		f.manager.discovery = [];
		await f.manager.revive("worker");
		assert.deepEqual(f.drift, []);
	} finally {
		await f.cleanup();
	}
});

// --- MCP server scoping -----------------------------------------------------

test("a child with no scope boots no MCP servers", async () => {
	const f = fixture();
	try {
		await f.manager.revive("worker");
		// Always set, never absent: an unset variable would let a stray
		// PI_SUBAGENT_MCP in the parent's own shell leak into the child.
		assert.equal(f.childEnv()[0]!.PI_SUBAGENT_MCP, "");
	} finally {
		await f.cleanup();
	}
});

test("a child's scope is replayed on revive", async () => {
	const f = fixture({ mcpScope: ["notion"] });
	try {
		await f.manager.revive("worker");
		assert.equal(f.childEnv()[0]!.PI_SUBAGENT_MCP, "notion");
	} finally {
		await f.cleanup();
	}
});

test("changing a running child's scope lands on the spec and applies at the next revive", async () => {
	const f = fixture({ mcpScope: ["notion"] });
	try {
		await f.manager.revive("worker");
		assert.equal(f.childEnv()[0]!.PI_SUBAGENT_MCP, "notion");

		const { pending } = f.manager.setMcpScope("worker", ["linear", "grafana"]);
		// Honest about the deferral: MCP servers connect while the child's process
		// boots, so the live process is still on its old set.
		assert.equal(pending, true, "a running child cannot hot-swap its servers");
		assert.deepEqual(f.manager.get("worker")!.launch.mcpScope, ["grafana", "linear"]);
		assert.equal(f.childEnv().length, 1, "no process was restarted behind our back");

		// The next revive is where it takes effect.
		const agent = f.manager.get("worker")!;
		await agent.client!.stop(200);
		await new Promise((resolve) => setTimeout(resolve, 300));
		agent.client = undefined;
		await f.manager.revive("worker");
		assert.equal(f.childEnv()[1]!.PI_SUBAGENT_MCP, "grafana,linear");
	} finally {
		await f.cleanup();
	}
});

test("scoping a hibernated child takes effect the moment it is revived", async () => {
	const f = fixture();
	try {
		const { pending } = f.manager.setMcpScope("worker", ["notion"]);
		assert.equal(pending, false, "no process, so nothing to defer behind");
		await f.manager.revive("worker");
		assert.equal(f.childEnv()[0]!.PI_SUBAGENT_MCP, "notion");
	} finally {
		await f.cleanup();
	}
});

test("two concurrent children carry different scopes without interfering", async () => {
	// One fixture, two agents: the stub's log paths come from the environment, so
	// two fixtures alive at once would both write to the second one's files.
	const f = fixture({ mcpScope: ["notion"] });
	try {
		f.manager.restore([
			{
				id: "sibling-1",
				sessionId: "sibling-uuid",
				name: "sibling",
				task: "something else",
				cwd: f.dir,
				contextMode: "fresh",
				status: "hibernated",
				sessionFile: f.sessionFile,
				sessionDir: f.sessionDir,
				startedAt: Date.now(),
				usage: { ...emptyUsage() },
				output: "",
				launch: { notesPath: join(f.dir, "NOTES.md"), mcpScope: ["linear"] },
			},
		]);

		await Promise.all([f.manager.revive("worker"), f.manager.revive("sibling")]);
		// The scope travels in each child's own environment, so there is no shared
		// file for two children to race through. This is the whole reason it is not
		// expressed through mcp-state.json, which is global across processes.
		const scopes = f.childEnv().map((env) => env.PI_SUBAGENT_MCP);
		assert.deepEqual([...scopes].sort(), ["linear", "notion"]);

		// And narrowing one does not touch the other.
		f.manager.setMcpScope("worker", []);
		assert.deepEqual(f.manager.get("worker")!.launch.mcpScope, []);
		assert.deepEqual(f.manager.get("sibling")!.launch.mcpScope, ["linear"]);
	} finally {
		await f.cleanup();
	}
});

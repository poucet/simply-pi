/**
 * Interrupted work restarting itself, with real processes.
 *
 * The point of auto-resume is that no human and no orchestrator decision is
 * involved, so the only honest test is one where nothing is stubbed on the path
 * under test: a real `SubagentManager`, real child processes (a stub standing in
 * for `pi --mode rpc` via `PI_SUBAGENT_BIN`), and the real transition table
 * deciding what gets mailed.
 *
 * That matters here specifically. A previous bug in this extension survived a
 * fully green suite because a test double supplied the very method the real
 * class was missing — so the pure policy in `resume.ts` is tested directly *and*
 * driven through `manager.autoResume()`, and the assertions about what happened
 * are made against the real mailbox rather than against a spy.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HIBERNATE_ENTRY_TYPE } from "../hibernate.ts";
import subagents from "../index.ts";
import { SubagentManager } from "../manager.ts";
import { Registry } from "../registry.ts";
import {
	DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES,
	DEFAULT_MAX_RESUME_ATTEMPTS,
	isUnfinished,
	planResumes,
	resumePrompt,
	resumeVerdict,
} from "../resume.ts";
import { emptyUsage } from "../types.ts";

// ------------------------------------------------------------ the pure policy --

const candidate = (over: Partial<Parameters<typeof resumeVerdict>[0]> = {}) => ({
	name: "worker",
	status: "running",
	lastActiveAt: Date.now(),
	hasSessionFile: true,
	...over,
});

const policy = (over: Partial<Parameters<typeof resumeVerdict>[1]> = {}) => ({
	trigger: "reload" as const,
	now: Date.now(),
	autoResumeMaxAgeMinutes: DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES,
	maxResumeAttempts: DEFAULT_MAX_RESUME_ATTEMPTS,
	...over,
});

test("unfinished means running, starting or stalled — and not waiting", () => {
	assert.equal(isUnfinished("running"), true);
	assert.equal(isUnfinished("starting"), true);
	assert.equal(isUnfinished("stalled"), true);
	assert.equal(isUnfinished("completed"), false);
	assert.equal(isUnfinished("failed"), false);
	assert.equal(isUnfinished("interrupted"), false);
	assert.equal(isUnfinished("hibernated"), false);
	// `waiting` is blocked on the parent, not interrupted: resuming it restarts a
	// turn that blocks again immediately. The child re-announces on revive.
	assert.equal(isUnfinished("waiting"), false);
});

test("interrupted work resumes; finished work does not", () => {
	assert.equal(resumeVerdict(candidate({ status: "running" }), policy()).action, "resume");
	assert.equal(resumeVerdict(candidate({ status: "stalled" }), policy()).action, "resume");

	// The half that protects completed work from being redone.
	const done = resumeVerdict(candidate({ status: "completed" }), policy());
	assert.equal(done.action, "leave");
	assert.match((done as { why: string }).why, /not interrupted work/);
});

test("nothing is resumed without a session file to resume it on", () => {
	const gone = resumeVerdict(candidate({ hasSessionFile: false }), policy());
	assert.equal(gone.action, "leave");
	assert.match((gone as { why: string }).why, /session file/);
});

test("the age bound applies to a cold start and not to a reload", () => {
	const old = candidate({ lastActiveAt: Date.now() - 3 * 60 * 60_000 });
	// A reload knows the process was alive moments ago, so age says nothing.
	assert.equal(resumeVerdict(old, policy({ trigger: "reload" })).action, "resume");
	// A cold start cannot know that: day-old work springing to life and editing
	// files is a worse surprise than work left asleep.
	const cold = resumeVerdict(old, policy({ trigger: "cold-start" }));
	assert.equal(cold.action, "leave");
	assert.match((cold as { why: string }).why, /auto-resume window|minutes ago/);
	// Fresh work at a cold start is resumed.
	assert.equal(
		resumeVerdict(candidate({ lastActiveAt: Date.now() - 60_000 }), policy({ trigger: "cold-start" }))
			.action,
		"resume",
	);
	// `0` disables the bound entirely.
	assert.equal(
		resumeVerdict(old, policy({ trigger: "cold-start", autoResumeMaxAgeMinutes: 0 })).action,
		"resume",
	);
});

test("the resume cap stops a crash loop and says why", () => {
	assert.equal(resumeVerdict(candidate({ resumeAttempts: 2 }), policy()).action, "resume");
	const capped = resumeVerdict(candidate({ resumeAttempts: 3 }), policy());
	assert.equal(capped.action, "give-up");
	assert.match((capped as { reason: string }).reason, /resumed automatically 3 time/);
	assert.match((capped as { reason: string }).reason, /read its transcript/);
	// `0` disables the cap.
	assert.equal(
		resumeVerdict(candidate({ resumeAttempts: 99 }), policy({ maxResumeAttempts: 0 })).action,
		"resume",
	);
});

test("attempts count up rather than restarting from one", () => {
	assert.equal(
		(resumeVerdict(candidate({ resumeAttempts: 1 }), policy()) as { attempt: number }).attempt,
		2,
	);
});

test("planResumes partitions a mixed set", () => {
	const plan = planResumes(
		[
			candidate({ name: "busy", status: "running" }),
			candidate({ name: "done", status: "completed" }),
			candidate({ name: "broken", status: "running", resumeAttempts: 5 }),
			candidate({ name: "gone", status: "running", hasSessionFile: false }),
		],
		policy(),
	);
	assert.deepEqual(plan.resume.map((r) => r.candidate.name), ["busy"]);
	assert.deepEqual(plan.giveUp.map((r) => r.candidate.name), ["broken"]);
	assert.deepEqual(plan.leave.map((r) => r.candidate.name).sort(), ["done", "gone"]);
});

test("the resume prompt tells the child what happened without restating the task", () => {
	const text = resumePrompt("worker", "reload");
	// Re-describing the job invites starting over; the conversation is intact.
	assert.match(text, /continue where you left off/i);
	assert.match(text, /Re-check the current state/i);
	assert.match(text, /Nobody cancelled/i);
	assert.match(resumePrompt("w", "cold-start"), /parent pi exited/);
});

// -------------------------------------------------------- the real manager path --

/** A stub `pi --mode rpc` that answers the protocol and stays alive. */
const STUB = `
const fs = require("node:fs");
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
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
  }
});
setInterval(() => {}, 1000);
`;

/** A stub that dies immediately, so a resume of it always fails. */
const DYING_STUB = `process.exit(7);`;

interface FixtureOptions {
	/** Status the agent had when its process went away. */
	status?: string;
	unfinishedStatus?: string;
	resumeAttempts?: number;
	lastActiveMinutesAgo?: number;
	maxResumeAttempts?: number;
	autoResumeMaxAgeMinutes?: number;
	dying?: boolean;
}

function fixture(options: FixtureOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-resume-"));
	const stub = join(dir, "stub.js");
	writeFileSync(stub, options.dying ? DYING_STUB : STUB);
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const argvLog = join(dir, "argv.log");
	const cmdLog = join(dir, "cmd.log");
	writeFileSync(argvLog, "");
	writeFileSync(cmdLog, "");

	const previousBin = process.env.PI_SUBAGENT_BIN;
	process.env.PI_SUBAGENT_BIN = stub;
	process.env.STUB_ARGV_LOG = argvLog;
	process.env.STUB_CMD_LOG = cmdLog;

	const mailed: Array<{ name: string; kind: string }> = [];
	const manager = new SubagentManager(
		{ onChange: () => {}, onMail: (name, kind) => mailed.push({ name, kind }) },
		{
			parentSessionId: "parent-uuid",
			...(options.maxResumeAttempts !== undefined
				? { maxResumeAttempts: options.maxResumeAttempts }
				: {}),
			...(options.autoResumeMaxAgeMinutes !== undefined
				? { autoResumeMaxAgeMinutes: options.autoResumeMaxAgeMinutes }
				: {}),
		},
	);
	const lastActive = Date.now() - (options.lastActiveMinutesAgo ?? 1) * 60_000;
	manager.restore([
		{
			id: "worker-1",
			sessionId: "child-uuid",
			parentSessionId: "parent-uuid",
			name: "worker",
			task: "finish the refactor",
			cwd: dir,
			contextMode: "forked",
			status: options.status ?? "running",
			...(options.unfinishedStatus ? { unfinishedStatus: options.unfinishedStatus } : {}),
			...(options.resumeAttempts ? { resumeAttempts: options.resumeAttempts } : {}),
			sessionFile,
			sessionDir,
			startedAt: lastActive,
			endedAt: lastActive,
			usage: { ...emptyUsage(), turns: 3 },
			output: "half done",
			launch: { model: "test/model", notesPath: join(dir, "NOTES.md") },
		},
	]);

	return {
		manager,
		mailed,
		mail: () => manager.mailbox.peek(),
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
		sessionFile,
		async cleanup() {
			await manager.stopAll(500);
			if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previousBin;
			delete process.env.STUB_ARGV_LOG;
			delete process.env.STUB_CMD_LOG;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("an unfinished hibernated agent resumes itself, with no user input at all", async () => {
	const f = fixture({ status: "running" });
	try {
		// Nobody messages it, nobody runs a command, no human is involved.
		const { resumed, gaveUp } = await f.manager.autoResume("reload");

		assert.deepEqual(resumed.map((a) => a.name), ["worker"]);
		assert.equal(gaveUp.length, 0);
		// A real process was launched, on the child's *existing* session file.
		const argv = f.argv();
		assert.equal(argv.length, 1, "exactly one child should have been launched");
		assert.ok(argv[0]!.includes(f.sessionFile), "resumed on a different session file");
		// And it was actually told to continue.
		const prompts = f.commands().filter((c) => c.type === "prompt" || c.command === "prompt");
		assert.ok(prompts.length > 0, `no prompt was sent: ${JSON.stringify(f.commands())}`);
		assert.match(JSON.stringify(prompts), /continue where you left off/i);

		assert.equal(f.manager.get("worker")!.status, "running");
	} finally {
		await f.cleanup();
	}
});

test("a resumed agent is announced to the orchestrator through the mailbox", async () => {
	const f = fixture({ status: "running" });
	try {
		await f.manager.autoResume("reload");
		// The framework acting on its own is exactly the kind of thing the
		// orchestrator must be told about: it believed this agent was gone.
		const resumedMail = f.mail().filter((e) => e.kind === "resumed");
		assert.equal(resumedMail.length, 1);
		assert.match(resumedMail[0]!.content, /restarted automatically/);
		assert.match(resumedMail[0]!.content, /attempt 1 of/);
		assert.deepEqual(f.mailed, [{ name: "worker", kind: "resumed" }]);
	} finally {
		await f.cleanup();
	}
});

test("a completed hibernated agent is left asleep and nothing is launched", async () => {
	// The idle sweep stopped it on purpose; restarting it would redo the work.
	const f = fixture({ status: "completed" });
	try {
		const { resumed, gaveUp } = await f.manager.autoResume("reload");
		assert.deepEqual(resumed, []);
		assert.deepEqual(gaveUp, []);
		assert.deepEqual(f.argv(), [], "a finished agent must not be launched");
		assert.deepEqual(f.mailed, [], "and nothing should be mailed about it");
	} finally {
		await f.cleanup();
	}
});

test("the age bound is honoured on a cold start and ignored on a reload", async () => {
	const cold = fixture({ status: "running", lastActiveMinutesAgo: 180 });
	try {
		const result = await cold.manager.autoResume("cold-start");
		assert.deepEqual(result.resumed, [], "3-hour-old work must not restart at a cold start");
		assert.deepEqual(cold.argv(), []);
	} finally {
		await cold.cleanup();
	}

	const reload = fixture({ status: "running", lastActiveMinutesAgo: 180 });
	try {
		const result = await reload.manager.autoResume("reload");
		assert.deepEqual(
			result.resumed.map((a) => a.name),
			["worker"],
			"a reload knows the process was alive moments ago, so age is irrelevant",
		);
		assert.equal(reload.argv().length, 1);
	} finally {
		await reload.cleanup();
	}
});

test("the resume cap stops a crash loop and reports it as stopped work", async () => {
	const f = fixture({ status: "running", resumeAttempts: 3, maxResumeAttempts: 3 });
	try {
		const { resumed, gaveUp } = await f.manager.autoResume("reload");
		assert.deepEqual(resumed, [], "a capped agent must not be launched again");
		assert.deepEqual(gaveUp.map((a) => a.name), ["worker"]);
		assert.deepEqual(f.argv(), []);

		const agent = f.manager.get("worker")!;
		assert.equal(agent.status, "failed");
		assert.match(agent.error!, /resumed automatically 3 time/);

		// Published as `stall`, not `error`: it is stopped work needing a decision,
		// and only `stall` is steered into a running turn. Giving up silently would
		// be the same bug the transition table exists to prevent, one level up.
		assert.deepEqual(f.mailed, [{ name: "worker", kind: "stall" }]);
		assert.match(f.mail()[0]!.content, /read its transcript/);
	} finally {
		await f.cleanup();
	}
});

test("the attempt counter is written before the attempt, so a crash cannot reset it", async () => {
	// A counter incremented *after* a successful resume never survives the crash
	// it is counting, and the loop runs forever.
	const f = fixture({ status: "running", dying: true, maxResumeAttempts: 3 });
	try {
		await f.manager.autoResume("reload");
		const agent = f.manager.get("worker")!;
		assert.equal(agent.resumeAttempts, 1, "the attempt must be recorded even though it failed");
		// Still resumable: one failure is not a crash loop.
		assert.equal(agent.status, "hibernated");
	} finally {
		await f.cleanup();
	}
});

test("repeated failed resumes reach the cap instead of retrying forever", async () => {
	const f = fixture({ status: "running", dying: true, maxResumeAttempts: 2 });
	try {
		// Each sweep is a fresh "the parent came back" event.
		await f.manager.autoResume("reload");
		assert.equal(f.manager.get("worker")!.resumeAttempts, 1);
		await f.manager.autoResume("reload");
		assert.equal(f.manager.get("worker")!.resumeAttempts, 2);

		// Third time: the cap is reached and it stops trying.
		const { resumed, gaveUp } = await f.manager.autoResume("reload");
		assert.deepEqual(resumed, []);
		assert.deepEqual(gaveUp.map((a) => a.name), ["worker"]);
		assert.equal(f.manager.get("worker")!.status, "failed");
		assert.ok(
			f.mailed.some((m) => m.kind === "stall"),
			`the give-up must be mailed: ${JSON.stringify(f.mailed)}`,
		);
	} finally {
		await f.cleanup();
	}
});

test("an unfinished status survives hibernation, which is what makes the distinction work", async () => {
	// `hibernated` is true of a finished child and an interrupted one alike, so
	// the pre-hibernation status is the only thing that separates them. If this
	// is lost, auto-resume either redoes finished work or strands unfinished work.
	const f = fixture({ status: "running" });
	try {
		await f.manager.hibernateAll(500);
		const agent = f.manager.get("worker")!;
		assert.equal(agent.status, "hibernated");
		assert.equal(agent.unfinishedStatus, "running");

		// And it is therefore still recognised as resumable.
		const { resumed } = await f.manager.autoResume("reload");
		assert.deepEqual(resumed.map((a) => a.name), ["worker"]);
	} finally {
		await f.cleanup();
	}
});

test("a cancelled auto-resume launches nothing further", async () => {
	// It starts processes in a loop, so a shutdown arriving halfway must be able
	// to stop it — otherwise the session tears down while children are launching.
	const f = fixture({ status: "running" });
	try {
		const abort = new AbortController();
		abort.abort();
		const { resumed } = await f.manager.autoResume("reload", Date.now(), abort.signal);
		assert.deepEqual(resumed, []);
		assert.deepEqual(f.argv(), []);
	} finally {
		await f.cleanup();
	}
});

// ------------------------------------------- the gate: which sessions resume --

/**
 * Drive the **real extension** through `session_start`, with a real unfinished
 * child in its session entries.
 *
 * This is the end-to-end half of the gate: not "does `autoResume` work" (above)
 * but "does `session_start` reach it", which is where both the nesting bug and
 * the suite hang lived. A real `pi --mode rpc` stub is on `PI_SUBAGENT_BIN`, so
 * a resume that fires launches an observable process and one that must not fire
 * leaves the log empty.
 */
function sessionHarness(options: { hasUI: boolean; argv?: string[]; asChild?: boolean }) {
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_PARENT;
	// `asChild` makes this process look like a subagent that has children of its
	// own — the nesting case. Without it the harness is merely *headless*, which is
	// a weaker claim: `identity.isChild` would be false and the old
	// `if (identity.isChild) return` gate would let it through, so a test that did
	// not set this could not detect that gate coming back.
	if (options.asChild) process.env.PI_SUBAGENT = "1";

	const dir = mkdtempSync(join(tmpdir(), "subagent-gate-"));
	const stub = join(dir, "stub.js");
	writeFileSync(stub, STUB);
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	const childUuid = `uuid-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: childUuid, cwd: dir })}\n`,
	);
	const argvLog = join(dir, "argv.log");
	writeFileSync(argvLog, "");

	const agentDir = mkdtempSync(join(tmpdir(), "subagent-gate-home-"));
	const previous = {
		bin: process.env.PI_SUBAGENT_BIN,
		log: process.env.STUB_ARGV_LOG,
		home: process.env.PI_CODING_AGENT_DIR,
		argv: process.argv,
	};
	process.env.PI_SUBAGENT_BIN = stub;
	process.env.STUB_ARGV_LOG = argvLog;
	process.env.STUB_CMD_LOG = join(dir, "cmd.log");
	writeFileSync(process.env.STUB_CMD_LOG, "");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Auto-resume on: that is the thing under test here.
	writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ autoResume: true }));
	if (options.argv) process.argv = [previous.argv[0]!, ...options.argv];

	// One unfinished child, in the parent's own session entries: the reload path.
	const entries = [
		{
			type: "custom",
			customType: HIBERNATE_ENTRY_TYPE,
			data: {
				version: 1,
				at: Date.now(),
				sessionId: "gate-parent",
				agents: [
					{
						id: "worker-1",
						sessionId: childUuid,
						parentSessionId: "gate-parent",
						name: "worker",
						task: "finish the refactor",
						cwd: dir,
						contextMode: "forked",
						// Unfinished: nobody chose to stop it.
						status: "running",
						sessionFile,
						sessionDir,
						startedAt: Date.now() - 60_000,
						usage: { ...emptyUsage(), turns: 2 },
						output: "half done",
						launch: { notesPath: join(dir, "NOTES.md") },
					},
				],
			},
		},
	];

	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const ctx: any = {
		hasUI: options.hasUI,
		ui: { setStatus: () => {}, setWidget: () => {}, setEditorComponent: () => {}, notify: () => {} },
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => "gate-parent",
			getEntries: () => entries,
			getSessionFile: () => join(dir, "parent.jsonl"),
			// A session whose header names a parent *is* a child, whatever the env
			// says — that is how `sessionIdentity` decides, so the nesting case has to
			// be expressed here and not only through the boot flag.
			getHeader: () =>
				options.asChild
					? {
							type: "session",
							id: "gate-parent",
							cwd: dir,
							parentSession: join(dir, "grandparent.jsonl"),
						}
					: { type: "session", id: "gate-parent", cwd: dir },
		},
	};
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
	};
	subagents(pi);

	return {
		handlers,
		ctx,
		launched: () => readFileSync(argvLog, "utf-8").split("\n").filter(Boolean).length,
		async cleanup() {
			try {
				await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			} catch {
				/* teardown is best effort; the assertions have already run */
			}
			process.argv = previous.argv;
			delete process.env.PI_SUBAGENT;
			if (previous.bin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previous.bin;
			if (previous.log === undefined) delete process.env.STUB_ARGV_LOG;
			else process.env.STUB_ARGV_LOG = previous.log;
			delete process.env.STUB_CMD_LOG;
			if (previous.home === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.home;
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

test("a headless rpc-mode parent resumes its own unfinished child, with no user input", async () => {
	// The nesting case, and the reason the `hasUI` gate was overturned. An
	// intermediate parent is a `pi --mode rpc` process with no human attached,
	// ever. Measured against the real CLI, such a process reports `hasUI: true`
	// — that surface is how its parent drives it — so this is a *real* session
	// and its interrupted children are its own to restart. Gating this on a human
	// strands an interrupted grandchild permanently.
	const h = sessionHarness({ hasUI: true, argv: ["pi", "--mode", "rpc"], asChild: true });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		// Nobody typed anything; no command was run.
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 1, "the unfinished child was not resumed by its headless parent");
	} finally {
		await h.cleanup();
	}
});

test("a one-shot -p invocation resumes nothing", async () => {
	// The regression guard for the suite hang. `session_start` fires for a
	// one-shot run (measured: `pi -p …` reports `hasUI: false`), and any child
	// launched there is stranded the moment the command exits — which is exactly
	// how this suite came to leave live `pi --mode rpc` processes behind.
	const h = sessionHarness({ hasUI: false, argv: ["pi", "-p", "do a thing"] });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 0, "a one-shot invocation must never launch children");
	} finally {
		await h.cleanup();
	}
});

test("-p is excluded even if the host reports a UI", async () => {
	// Defence in depth: `hasUI` is pi's to define and a future version could
	// plausibly report `true` for a print run. Getting this wrong in the
	// permissive direction re-creates the hang, so argv is checked as well.
	const h = sessionHarness({ hasUI: true, argv: ["pi", "-p", "do a thing"] });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 0, "argv did not exclude a print run");
	} finally {
		await h.cleanup();
	}
});

test("--print is excluded as well as -p", async () => {
	const h = sessionHarness({ hasUI: true, argv: ["pi", "--print", "do a thing"] });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 0);
	} finally {
		await h.cleanup();
	}
});

test("an interactive parent still resumes, as it did before", async () => {
	const h = sessionHarness({ hasUI: true, argv: ["pi"] });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 1);
	} finally {
		await h.cleanup();
	}
});

// --------------------------------------- the scope: whose interrupted work? --

/**
 * A cold start driven off the **registry**, with a real stub on `PI_SUBAGENT_BIN`.
 *
 * The gate tests above come in through the parent's own session entries, which
 * is the reload path. This is the other one: `kill pi && pi` opens a session with
 * no entries at all, and everything the new process knows comes out of
 * `registry.json`. It is also the only path where the *directory* question can be
 * asked, because a reload is by definition the same directory.
 *
 * A launch here is an observable fact (a line in the argv log), so "resumed" and
 * "left alone" are distinguishable without trusting a status field.
 */
function coldHarness(options: { registryCwd: string; sessionCwd: string }) {
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_PARENT;

	const dir = mkdtempSync(join(tmpdir(), "subagent-cold-"));
	const stub = join(dir, "stub.js");
	writeFileSync(stub, STUB);
	const sessionDir = join(dir, "agent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "session.jsonl");
	const childUuid = `uuid-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: childUuid, cwd: dir })}\n`,
	);
	const argvLog = join(dir, "argv.log");
	writeFileSync(argvLog, "");

	const agentDir = mkdtempSync(join(tmpdir(), "subagent-cold-home-"));
	const previous = {
		bin: process.env.PI_SUBAGENT_BIN,
		log: process.env.STUB_ARGV_LOG,
		cmd: process.env.STUB_CMD_LOG,
		home: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.PI_SUBAGENT_BIN = stub;
	process.env.STUB_ARGV_LOG = argvLog;
	process.env.STUB_CMD_LOG = join(dir, "cmd.log");
	writeFileSync(process.env.STUB_CMD_LOG, "");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ autoResume: true }));

	// One child, interrupted mid-task, orphaned by a parent that is gone: no pid,
	// and a status that says it was working when the process went away.
	new Registry().upsert({
		sessionId: childUuid,
		parentSessionId: "dead-parent",
		name: "worker",
		task: "finish the refactor",
		// The directory the *parent* was working in. The whole question.
		parentCwd: options.registryCwd,
		cwd: dir,
		contextMode: "forked",
		status: "running",
		sessionFile,
		sessionDir,
		startedAt: Date.now() - 60_000,
		lastActiveAt: Date.now() - 60_000,
		usage: { ...emptyUsage(), turns: 2 },
		output: "half done",
		launch: { notesPath: join(dir, "NOTES.md") },
	});

	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const ctx: any = {
		hasUI: true,
		ui: { setStatus: () => {}, setWidget: () => {}, setEditorComponent: () => {}, notify: () => {} },
		cwd: options.sessionCwd,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => "cold-parent",
			getEntries: () => [],
			getSessionFile: () => join(dir, "parent.jsonl"),
			getHeader: () => ({ type: "session", id: "cold-parent", cwd: options.sessionCwd }),
		},
	};
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
	};
	subagents(pi);

	return {
		handlers,
		ctx,
		launched: () => readFileSync(argvLog, "utf-8").split("\n").filter(Boolean).length,
		async cleanup() {
			try {
				await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
			} catch {
				/* teardown is best effort; the assertions have already run */
			}
			if (previous.bin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previous.bin;
			if (previous.log === undefined) delete process.env.STUB_ARGV_LOG;
			else process.env.STUB_ARGV_LOG = previous.log;
			if (previous.cmd === undefined) delete process.env.STUB_CMD_LOG;
			else process.env.STUB_CMD_LOG = previous.cmd;
			if (previous.home === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.home;
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

test("a cold start resumes the interrupted work of its own directory", async () => {
	const here = mkdtempSync(join(tmpdir(), "subagent-cold-repo-"));
	const h = coldHarness({ registryCwd: here, sessionCwd: here });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 1, "this directory's interrupted child was not resumed");
	} finally {
		await h.cleanup();
	}
});

test("a cold start does not start processes for another directory's work", async () => {
	// The hazard auto-restore would otherwise create: opening pi in one repo
	// launching a `pi --mode rpc` that edits files in another. The child is not
	// stranded — the next pi opened *there* finds it exactly the same way — and
	// `/agents restore` reaches it in the meantime.
	const theirs = mkdtempSync(join(tmpdir(), "subagent-cold-theirs-"));
	const mine = mkdtempSync(join(tmpdir(), "subagent-cold-mine-"));
	const h = coldHarness({ registryCwd: theirs, sessionCwd: mine });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(h.launched(), 0, "resumed a child belonging to another directory");
	} finally {
		await h.cleanup();
	}
});

/**
 * Smoke test for the extension's own wiring.
 *
 * It cannot spawn a child (that needs a provider), but it can prove that the
 * handlers exist, that `session_start` installs the wrapped editor and the
 * footer status, and that a shutdown does not throw — all of which are
 * otherwise only exercised inside a live TUI.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resetForTests, setRenderer, snapshot } from "../../shared/border-badges.ts";
import { HIBERNATE_ENTRY_TYPE } from "../hibernate.ts";
import subagents from "../index.ts";
import { Registry } from "../registry.ts";
import { emptyUsage } from "../types.ts";

// Everything the extension persists (registry, shared notes, child session
// dirs) is redirected to a scratch `PI_CODING_AGENT_DIR` by tests/run.mjs, so
// these tests never touch the user's real `~/.pi/agent`.
//
// Auto-resume is switched off for the whole file (`autoResume: false` in the
// scratch settings, written below). These tests are about *restore* — which
// records come back and what the footer says — and auto-resume would have every
// one of them launch real `pi --mode rpc` children for the unfinished agents in
// their fixtures. `tests/resume.test.ts` exercises that path deliberately.
/**
 * Switch auto-resume off in whatever agent directory is current.
 *
 * Called per harness rather than once at module load, because several tests
 * point `PI_CODING_AGENT_DIR` at a fresh temp directory of their own and
 * `loadSettings` reads it afresh on every `session_start`. Writing the file once
 * would silently miss exactly those tests — which is how a real `pi --mode rpc`
 * child was left running by the "parent is still alive" case.
 */
function disableAutoResume(): void {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "subagents.json");
	// Merged rather than overwritten: a test that set up its own settings and then
	// built a harness would otherwise have them silently erased here, and the
	// assertion would fail somewhere that says nothing about why.
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
	} catch {
		/* no file yet, or one this run is about to replace anyway */
	}
	writeFileSync(file, JSON.stringify({ ...existing, autoResume: false }, null, "\t"));
}

/**
 * A directory nothing else in this file uses.
 *
 * Auto-restore is scoped by the session's cwd (see `registry.treeSpawnedIn`),
 * and every harness here shares one scratch registry. Without a cwd per test,
 * every test would adopt every previous test's leftovers — which is not a bug in
 * the feature but is certainly a bug in the fixtures. Tests that *want* the
 * cold-start behaviour pass the same `cwd` to both halves on purpose.
 */
function scratchCwd(): string {
	return mkdtempSync(join(tmpdir(), "subagent-wiring-cwd-"));
}

function harness(entries: any[] = [], sessionId = "wiring-test", cwd = scratchCwd()) {
	// These tests are about *restore* — which records come back and what the
	// footer says. Auto-resume would have several of them launch real
	// `pi --mode rpc` children for the unfinished agents in their fixtures, and
	// leave them running after the suite finished. `tests/resume.test.ts`
	// exercises that path on purpose instead.
	disableAutoResume();
	// The extension suppresses its *UI* inside a child (the PI_SUBAGENT boot
	// flag). These tests exercise the parent side, and the suite may itself be
	// running inside a subagent, so the flags are cleared for the duration.
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_SUBAGENT_NAME;
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const sent: any[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let editorFactory: unknown;

	const notices: Array<{ text: string; level?: string }> = [];
	const ui = {
		setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		setWidget: (key: string, content: unknown) => widgets.set(key, content),
		setEditorComponent: (factory: unknown) => {
			editorFactory = factory;
		},
		notify: (text: string, level?: string) => notices.push({ text, level }),
	};
	const ctx: any = {
		hasUI: true,
		ui,
		cwd,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			// A root session: no `parentSession`, so `sessionIdentity` reports it as
			// the top of the tree.
			getHeader: () => ({ type: "session", id: sessionId, cwd }),
		},
	};
	const appended: Array<{ customType: string; data: any }> = [];
	const shortcuts: string[] = [];
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (tool: any) => tools.push(tool),
		registerCommand: (name: string, spec: any) => commands.set(name, spec),
		registerShortcut: (key: string) => shortcuts.push(key),
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
	};
	subagents(pi);
	return {
		handlers,
		sent,
		statuses,
		widgets,
		ctx,
		cwd,
		appended,
		shortcuts,
		tools,
		commands,
		notices,
		editor: () => editorFactory,
	};
}

/** A hibernation entry whose session file really exists, so restore accepts it. */
function hibernateEntry(name = "worker") {
	const dir = mkdtempSync(join(tmpdir(), "subagent-wiring-"));
	const sessionFile = join(dir, "session.jsonl");
	// The child's own session uuid — its identity across the whole tree, and what
	// the registry is keyed by. Randomised so tests that run in the same scratch
	// agent directory do not collide in the shared registry.
	const sessionId = `uuid-${name}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: dir })}\n`,
	);
	return {
		type: "custom",
		customType: HIBERNATE_ENTRY_TYPE,
		data: {
			version: 1,
			at: Date.now(),
			agents: [
				{
					id: `${name}-1`,
					sessionId,
					name,
					task: "keep going",
					cwd: dir,
					contextMode: "forked",
					status: "running",
					sessionFile,
					sessionDir: dir,
					startedAt: Date.now() - 60_000,
					usage: { ...emptyUsage(), turns: 4 },
					output: "partial",
					launch: { notesPath: join(dir, "NOTES.md") },
				},
			],
		},
	};
}

test("the extension registers the handlers it needs", () => {
	const { handlers } = harness();
	for (const event of ["session_start", "session_shutdown", "before_agent_start", "agent_settled"]) {
		assert.ok(handlers.has(event), `missing handler for ${event}`);
	}
});

test("session_start installs the wrapped editor and clears a stale status", async () => {
	const { handlers, ctx, statuses, widgets, editor } = harness();
	await handlers.get("session_start")!({}, ctx);
	assert.equal(typeof editor(), "function");
	// No children yet: both signals say nothing rather than lying.
	assert.equal(statuses.get("subagents"), undefined);
	assert.equal(widgets.get("subagents"), undefined);
});

test("an empty mailbox adds no message to the next request", async () => {
	const { handlers, ctx } = harness();
	await handlers.get("session_start")!({}, ctx);
	const result = await handlers.get("before_agent_start")!({ systemPrompt: "SP" }, ctx);
	assert.equal(result?.message, undefined);
});

test("a settled turn with nothing pending wakes nobody", async () => {
	const { handlers, ctx, sent } = harness();
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("agent_settled")!({}, ctx);
	assert.deepEqual(sent, []);
});

test("shutdown is safe with no children", async () => {
	const { handlers, ctx } = harness();
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

// --- reload survival ------------------------------------------------------

test("session_start restores the agents a previous reload hibernated", async () => {
	const { handlers, ctx, statuses } = harness([hibernateEntry()]);
	await handlers.get("session_start")!({}, ctx);
	// Visible in the footer straight away, without a process being started.
	assert.match(String(statuses.get("subagents")), /1 hibernated/);
});

test("a reload writes a session entry, a quit does not", async () => {
	const reload = harness([hibernateEntry()]);
	await reload.handlers.get("session_start")!({}, reload.ctx);
	await reload.handlers.get("session_shutdown")!({ reason: "reload" }, reload.ctx);
	assert.equal(reload.appended.length, 1);
	assert.equal(reload.appended[0]!.customType, HIBERNATE_ENTRY_TYPE);
	assert.deepEqual(
		reload.appended[0]!.data.agents.map((a: any) => a.name),
		["worker"],
	);

	// Quitting writes nothing into the session it is leaving — the *registry* is
	// what carries a quit across a cold restart now; see below.
	const quit = harness([hibernateEntry()]);
	await quit.handlers.get("session_start")!({}, quit.ctx);
	await quit.handlers.get("session_shutdown")!({ reason: "quit" }, quit.ctx);
	assert.deepEqual(quit.appended, []);
});

// --- cold-restart survival ------------------------------------------------

test("quitting persists the tree to the registry instead of discarding it", async () => {
	// The case session entries structurally cannot cover: `kill pi`, start again.
	// A cold start opens a *new* session and never reads the old one, so anything
	// written only into the old session file is stranded.
	const quit = harness([hibernateEntry("survivor")], "session-quit");
	await quit.handlers.get("session_start")!({}, quit.ctx);
	await quit.handlers.get("session_shutdown")!({ reason: "quit" }, quit.ctx);

	const registry = new Registry();
	assert.ok(
		registry.read().nodes.some((node) => node.name === "survivor"),
		"the quit checkpointed the tree",
	);
});

test("a cold start adopts the previous run in this directory, without reviving it", async () => {
	const dir = scratchCwd();
	const first = harness([hibernateEntry("leftover")], "session-cold-a", dir);
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "quit" }, first.ctx);

	// A brand new session, with no entries of its own: exactly what `kill pi &&
	// pi` produces. Same directory, so these children are its own.
	const cold = harness([], "session-cold-b", dir);
	await cold.handlers.get("session_start")!({}, cold.ctx);

	// They are simply back — no chore, and no footer entry nagging about one.
	assert.match(String(cold.statuses.get("subagents")), /1 hibernated/);
	assert.equal(cold.statuses.get("subagents-restore"), undefined);
	assert.ok(
		cold.notices.some((n) => /restored 1 subagent/.test(n.text)),
		`expected an adoption notice, got ${JSON.stringify(cold.notices)}`,
	);
	// Adopting is records, not processes: nobody asked for a `pi` to be launched.
	assert.ok(
		!cold.notices.some((n) => /resumed/.test(n.text)),
		"a cold start must not report having started anything",
	);
});

test("an automatic adoption does not start a parent turn", async () => {
	// Waking here would mean opening pi spends a model turn before the human has
	// typed anything. The mail is still published, so the orchestrator hears about
	// its children on the first request it actually makes.
	const dir = scratchCwd();
	const first = harness([hibernateEntry("quiet")], "session-quiet-a", dir);
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "quit" }, first.ctx);

	const cold = harness([], "session-quiet-b", dir);
	await cold.handlers.get("session_start")!({}, cold.ctx);
	assert.deepEqual(cold.sent, [], "an adoption at startup must not wake the parent");

	// …but it is waiting for it, folded into the next request.
	const result = await cold.handlers.get("before_agent_start")!({ systemPrompt: "SP" }, cold.ctx);
	assert.match(String(result?.message?.content), /quiet/);
});

test("another directory's children are left alone, and /agents restore still takes them", async () => {
	// One registry file describes every tree on the machine. Adopting a different
	// project's agents would show them in a switcher they have nothing to do with.
	const first = harness([hibernateEntry("elsewhere")], "session-restore-a", scratchCwd());
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "quit" }, first.ctx);

	const cold = harness([], "session-restore-b", scratchCwd());
	await cold.handlers.get("session_start")!({}, cold.ctx);
	assert.equal(cold.statuses.get("subagents"), undefined, "adopted somebody else's agents");
	assert.ok(
		cold.notices.some((n) => /were left alone/.test(n.text)),
		`expected a "left alone" notice, got ${JSON.stringify(cold.notices)}`,
	);

	// An explicit request may reach across directories: somebody asked for it.
	await cold.commands.get("agents")!.handler("restore", cold.ctx);
	assert.match(String(cold.statuses.get("subagents")), /hibernated/);
	// The footer entry the human did not want is gone in every state.
	assert.equal(cold.statuses.get("subagents-restore"), undefined);
});

test("work older than the auto-restore window is left for /agents restore", async () => {
	// Without an age bound a stale registry resurrects the same pile at every
	// launch until somebody closes them one at a time.
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagent-stale-"));
	try {
		const dir = scratchCwd();
		const childDir = mkdtempSync(join(tmpdir(), "subagent-stale-child-"));
		const sessionFile = join(childDir, "session.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "ancient" })}\n`);
		new Registry().upsert({
			sessionId: "ancient",
			name: "greybeard",
			status: "completed",
			parentCwd: dir,
			cwd: childDir,
			sessionFile,
			sessionDir: childDir,
			// Three days ago: the same directory, but not the same working day.
			lastActiveAt: Date.now() - 3 * 24 * 60 * 60_000,
		});

		const cold = harness([], "session-stale", dir);
		await cold.handlers.get("session_start")!({}, cold.ctx);
		assert.equal(cold.statuses.get("subagents"), undefined, "adopted a three-day-old agent");

		await cold.commands.get("agents")!.handler("restore", cold.ctx);
		assert.match(String(cold.statuses.get("subagents")), /hibernated/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("a child that is still running under another pi is never adopted", async () => {
	// Two pi windows on one repo share a directory, so scoping by cwd cannot tell
	// them apart. A surviving pid can: `Registry.live()` clears the pid of
	// everything that is not running, so one that is left is a real process.
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagent-twowindows-"));
	try {
		const dir = scratchCwd();
		const childDir = mkdtempSync(join(tmpdir(), "subagent-twowindows-child-"));
		const sessionFile = join(childDir, "session.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "busy" })}\n`);
		new Registry().upsert({
			sessionId: "busy",
			name: "working",
			status: "running",
			parentCwd: dir,
			cwd: childDir,
			sessionFile,
			sessionDir: childDir,
			lastActiveAt: Date.now(),
			// A pid that can certainly be signalled: this very process.
			pid: process.pid,
		});

		const cold = harness([], "session-twowindows", dir);
		await cold.handlers.get("session_start")!({}, cold.ctx);
		assert.equal(
			cold.statuses.get("subagents"),
			undefined,
			"adopted a child another pi is driving",
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("a one-shot invocation adopts nothing", async () => {
	// `pi -p …` gets a session_start too. Folding somebody's agents into a single
	// scripted turn is neither wanted nor observable.
	const dir = scratchCwd();
	const first = harness([hibernateEntry("oneshot")], "session-oneshot-a", dir);
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "quit" }, first.ctx);

	const argv = process.argv;
	process.argv = [argv[0]!, "pi", "-p", "do a thing"];
	try {
		const cold = harness([], "session-oneshot-b", dir);
		await cold.handlers.get("session_start")!({}, cold.ctx);
		assert.equal(cold.statuses.get("subagents"), undefined);
	} finally {
		process.argv = argv;
	}
});

test("a nested agent surveys nothing: the tree belongs to the root", async () => {
	// A child offering to adopt its own siblings would put two `pi` processes on
	// one session file.
	const first = harness([hibernateEntry("sibling")], "session-nested-a");
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "quit" }, first.ctx);

	const child = harness([], "session-nested-child");
	// A session whose header names a parent *is* a child, whatever the env says.
	child.ctx.sessionManager.getHeader = () => ({
		type: "session",
		id: "session-nested-child",
		cwd: child.cwd,
		parentSession: "/sessions/session-nested-a.jsonl",
	});
	await child.handlers.get("session_start")!({}, child.ctx);
	assert.equal(child.statuses.get("subagents-restore"), undefined);
	assert.equal(child.statuses.get("subagents"), undefined);
});

test("a node whose parent is still alive is not ours to adopt", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagent-owned-"));
	try {
		const dir = mkdtempSync(join(tmpdir(), "subagent-owned-child-"));
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "grandchild" })}\n`);
		const registry = new Registry();
		// A live parent (this very process's pid) still owns its child.
		registry.upsert({
			sessionId: "living-parent",
			name: "mid",
			status: "running",
			lastActiveAt: Date.now(),
			pid: process.pid,
			sessionFile,
			sessionDir: dir,
		});
		registry.upsert({
			sessionId: "grandchild",
			parentSessionId: "living-parent",
			name: "deep",
			status: "running",
			lastActiveAt: Date.now(),
			sessionFile,
			sessionDir: dir,
		});

		const cold = harness([], "session-owned");
		await cold.handlers.get("session_start")!({}, cold.ctx);
		// The dead `living-parent`… is not dead, so only it would be offered, and
		// its child is left to it.
		assert.ok(
			!cold.notices.some((n) => /2 subagents/.test(n.text)),
			`the grandchild should not be offered: ${JSON.stringify(cold.notices)}`,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("a cold start with an unreadable registry starts anyway", async () => {
	// A registry that could keep pi from starting would be a strictly worse bug
	// than the one it exists to fix.
	//
	// Isolated in its own agent directory, both so the corruption is the *only*
	// thing under test and so it is not left behind for the tests that follow.
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagent-corrupt-"));
	try {
		const registry = new Registry();
		mkdirSync(dirname(registry.file), { recursive: true });
		writeFileSync(registry.file, "{ truncated mid-write");
		const cold = harness([], "session-corrupt");
		await cold.handlers.get("session_start")!({}, cold.ctx);
		assert.equal(cold.statuses.get("subagents-restore"), undefined);
		// The corrupt file is still there and still reads as empty rather than
		// throwing; a shutdown on top of it is equally uneventful.
		assert.deepEqual(registry.read().nodes, []);
		await cold.handlers.get("session_shutdown")!({ reason: "quit" }, cold.ctx);
		assert.deepEqual(registry.read().nodes, []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("the hibernated set survives a full reload round-trip", async () => {
	const first = harness([hibernateEntry()]);
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "reload" }, first.ctx);

	// The entry pi wrote for us is what the next session reads back.
	const entry = { type: "custom", ...first.appended[0]! };
	const second = harness([entry]);
	await second.handlers.get("session_start")!({}, second.ctx);
	assert.match(String(second.statuses.get("subagents")), /1 hibernated/);
});

test("a session with nothing to hibernate writes no entry", async () => {
	const { handlers, ctx, appended } = harness();
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
	assert.deepEqual(appended, []);
});

test("ctrl+g is not registered: it is pi's own external-editor binding", () => {
	const { shortcuts } = harness();
	assert.deepEqual(shortcuts, []);
});

test("the tool offers retry as an action", () => {
	const { tools } = harness();
	const subagent = tools.find((t) => t.name === "subagent");
	assert.ok(subagent, "the subagent tool is registered");
	const actions = subagent.parameters.properties.action.enum;
	assert.ok(actions.includes("retry"), `retry missing from ${actions.join(", ")}`);
});

test("the tool registers both renderers so it is not an anonymous red box", () => {
	const { tools } = harness();
	const subagent = tools.find((t) => t.name === "subagent");
	assert.equal(typeof subagent.renderCall, "function", "renderCall missing");
	assert.equal(typeof subagent.renderResult, "function", "renderResult missing");

	// Drive them the way ToolExecutionComponent does, with a structural theme.
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const args = { action: "spawn", name: "w", task: "do the thing" };
	const callComponent = subagent.renderCall(args, theme, { expanded: false });
	assert.match(String(callComponent.text), /subagent spawn "w"/);
	assert.match(String(callComponent.text), /do the thing/);

	const resultComponent = subagent.renderResult(
		{ details: { agent: "w", contextMode: "forked", cwd: "/tmp" } },
		{ expanded: false, isPartial: false },
		theme,
		{ args },
	);
	assert.match(String(resultComponent.text), /spawned/);
});

test("a fork does not claim the children of the session it forked from", async () => {
	const dir = scratchCwd();
	const first = harness([hibernateEntry()], "session-A", dir);
	await first.handlers.get("session_start")!({}, first.ctx);
	await first.handlers.get("session_shutdown")!({ reason: "fork" }, first.ctx);

	// The forked session inherits the entry, but the original may still be
	// running those children: two parents reviving one child would put two `pi`
	// processes on one session file.
	//
	// Two independent guards, and the second is why the cwd is deliberately the
	// *same* here: `collectRecords` rejects an entry written by another session,
	// and `SessionManager.forkFrom` writes `parentSession` into the new header —
	// which is exactly what `sessionIdentity` reads to decide that a session does
	// not survey the registry at all.
	const forked = harness([{ type: "custom", ...first.appended[0]! }], "session-B", dir);
	forked.ctx.sessionManager.getHeader = () => ({
		type: "session",
		id: "session-B",
		cwd: dir,
		parentSession: "/sessions/session-A.jsonl",
	});
	await forked.handlers.get("session_start")!({}, forked.ctx);
	assert.equal(forked.statuses.get("subagents"), undefined);
});

// --- the badge bar, from the publisher's side ------------------------------

/** This extension's group in the shared registry, as `tone:text` pairs. */
const publishedBadges = (): string[] | undefined =>
	snapshot()
		.find((group) => group.source === "subagents")
		?.badges.map((b) => `${b.tone}:${b.text}`);

test("with no agents this extension puts nothing on the bar and nothing in the footer", async () => {
	resetForTests();
	const { handlers, ctx, statuses } = harness();
	await handlers.get("session_start")!({}, ctx);
	assert.equal(publishedBadges(), undefined, "an idle extension must occupy no bar space");
	assert.equal(statuses.get("subagents"), undefined);
	resetForTests();
});

test("restored agents reach the bar as a glyph and a count", async () => {
	resetForTests();
	const { handlers, ctx } = harness([hibernateEntry()]);
	await handlers.get("session_start")!({}, ctx);
	// One hibernated child: parked, so it recedes.
	assert.deepEqual(publishedBadges(), ["muted:🤖 1"]);
	resetForTests();
});

test("the footer sentence is written only while nothing is drawing the bar", async () => {
	// The degradation rule, applied to this extension exactly as to mcp. It owns
	// the editor today, but asking `hasRenderer()` rather than assuming is what
	// keeps it right the moment something else takes the slot.
	resetForTests();
	const { handlers, ctx, statuses } = harness([hibernateEntry()]);
	await handlers.get("session_start")!({}, ctx);
	assert.match(String(statuses.get("subagents")), /1 hibernated/, "no renderer, so the sentence");

	setRenderer(true);
	try {
		assert.equal(statuses.get("subagents"), undefined, "the sentence survived the bar appearing");
		// …while the badges are still published: presence gates the fallback, never
		// the data.
		assert.deepEqual(publishedBadges(), ["muted:🤖 1"]);
	} finally {
		setRenderer(false);
	}
	assert.match(String(statuses.get("subagents")), /1 hibernated/, "the sentence did not return");
	resetForTests();
});

test("shutdown withdraws this extension's chip", async () => {
	// Same reason mcp withdraws its own: a bar left holding the last snapshot
	// would spend the end of the session reporting agents that are being stopped.
	resetForTests();
	const { handlers, ctx } = harness([hibernateEntry()]);
	await handlers.get("session_start")!({}, ctx);
	assert.notEqual(publishedBadges(), undefined);
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
	assert.equal(publishedBadges(), undefined);
	resetForTests();
});

// --- settings: MCP scope, and keys that stopped meaning anything -------------

/**
 * Point `PI_CODING_AGENT_DIR` at a fresh directory holding this settings file.
 *
 * `loadSettings` reads the file on every `session_start`, so a per-test agent
 * directory is the only way to vary it without leaking into the rest of the run.
 */
function withSettings(settings: Record<string, unknown>) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "subagent-settings-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	// These tests are about configuration, not restore; auto-resume would launch
	// real `pi --mode rpc` children out of any leftover records.
	writeFileSync(
		join(dir, "subagents.json"),
		JSON.stringify({ autoResume: false, ...settings }, null, "\t"),
	);
	return {
		dir,
		restore() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		},
	};
}

test("the spawn tool advertises the MCP scope, and the action that changes it", async () => {
	const h = harness();
	const tool = h.tools.find((t: any) => t.name === "subagent");
	assert.ok(tool, "the subagent tool is registered");
	// The orchestrator can only scope a child if the parameter is described to it.
	assert.ok(tool.parameters.properties.mcp_servers, "mcp_servers is a spawn parameter");
	assert.ok(tool.parameters.properties.action.enum.includes("mcp"), "the mcp action exists");
	// The deferral is stated where the model will read it. Claiming a hot swap
	// would be a lie: MCP servers connect while the child's process boots.
	assert.match(tool.description, /next revive/);
});

test("an obsolete settings key is called out rather than ignored in silence", async () => {
	// It is inert, but it *reads* as configuration — which is how a path to a file
	// that moved away years of edits ago sits in a config nobody questions.
	const s = withSettings({ childExtensions: ["/gone/model-routing.ts"], childMcp: false });
	try {
		const h = harness([], "session-obsolete", scratchCwd());
		await h.handlers.get("session_start")!({}, h.ctx);
		const said = h.notices.map((n) => n.text).join("\n");
		assert.match(said, /childExtensions/);
		assert.match(said, /childMcp/);
		// And each says what to use instead, so the notice is actionable.
		assert.match(said, /childDeny/);
		assert.match(said, /childMcpServers/);
	} finally {
		s.restore();
	}
});

test("a config without the obsolete keys says nothing about them", async () => {
	const s = withSettings({ childMcpServers: ["notion"] });
	try {
		const h = harness([], "session-clean", scratchCwd());
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.ok(
			!h.notices.some((n) => /no longer does anything/.test(n.text)),
			`expected no obsolete-key notice, got ${JSON.stringify(h.notices)}`,
		);
	} finally {
		s.restore();
	}
});

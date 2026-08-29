/**
 * Mail reaching a parent that nobody is watching.
 *
 * Publishing has always been unconditional. *Delivery* was not: mail that did
 * not wake an idle parent "rode into the next request", and the next request
 * only exists when a human types. At depth 1 that is a delay. Under nesting it
 * is fatal — a grandchild's parent is itself a `pi --mode rpc` process with no
 * terminal and no human, so its queue was never drained at all. The tree
 * silently stopped working below depth 1 and nothing reported it.
 *
 * Two layers are tested, and neither stubs the thing under test:
 *
 *   1. `routeMail` over every kind, including `hasUI: false` — the decision.
 *   2. The **real extension**, driven through the same handler surface pi uses,
 *      with a real `SubagentManager` and a real mailbox behind it — the wiring.
 *      A test double supplying the drain would make the second layer vacuous,
 *      and a bug in this extension once survived a fully green suite for
 *      exactly that reason.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import subagents from "../index.ts";
import { type MailKind, Mailbox } from "../mailbox.ts";
import { SubagentManager } from "../manager.ts";
import { routeMail } from "../notify.ts";
import { DELIVERY_BY_KIND } from "../transitions.ts";

const KINDS = Object.keys(DELIVERY_BY_KIND) as MailKind[];
const ACTIONABLE = KINDS.filter((k) => k !== "report");

// ------------------------------------------------------------- the decision --

test("no actionable kind ever waits for a user, whatever the parent is doing", () => {
	// The invariant the whole nesting fix rests on, over the full cross product.
	for (const kind of ACTIONABLE) {
		for (const idle of [true, false]) {
			for (const hasUI of [true, false]) {
				for (const onFinish of ["wake", "notify"] as const) {
					const route = routeMail({ kind, idle, onFinish, hasUI });
					assert.notEqual(
						route,
						"ride",
						`${kind} (idle=${idle}, hasUI=${hasUI}, onFinish=${onFinish}) routed to "ride", ` +
							"which means \u201cnever\u201d for a parent nobody types into",
					);
				}
			}
		}
	}
});

test("report always rides, whatever the parent is doing", () => {
	// The property being protected: a chatty child must not start a parent turn
	// every few seconds. This is about `report`'s volume, not about humans.
	for (const idle of [true, false]) {
		for (const hasUI of [true, false]) {
			assert.equal(routeMail({ kind: "report", idle, onFinish: "wake", hasUI }), "ride");
		}
	}
});

test("a headless parent ignores onFinish, which only a human can hold", () => {
	for (const kind of ACTIONABLE) {
		assert.equal(
			routeMail({ kind, idle: true, onFinish: "notify", hasUI: false }),
			"wake",
			`${kind} was withheld from a headless parent by a preference nobody expressed`,
		);
	}
});

// --------------------------------------------------------------- the wiring --

/**
 * A parent session, with or without a human attached.
 *
 * `hasUI: false` is the nesting case: an intermediate parent in a tree, itself a
 * child agent. It has a session, a mailbox and children of its own, and there is
 * nobody to type into it, ever.
 */
function harness(options: { hasUI: boolean; idle?: boolean; onFinish?: "wake" | "notify" }) {
	delete process.env.PI_SUBAGENT;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_PARENT;

	// Auto-resume starts real processes; these tests are about delivery only.
	const dir = process.env.PI_CODING_AGENT_DIR!;
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "subagents.json"),
		JSON.stringify({ autoResume: false, onFinish: options.onFinish ?? "wake" }),
	);

	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const sent: Array<{ message: any; options: any }> = [];
	const tools: any[] = [];
	let idle = options.idle ?? true;

	const ctx: any = {
		hasUI: options.hasUI,
		ui: { setStatus: () => {}, setWidget: () => {}, setEditorComponent: () => {}, notify: () => {} },
		cwd: process.cwd(),
		isIdle: () => idle,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => "delivery-session",
			getEntries: () => [],
			getSessionFile: () => "/sessions/delivery.jsonl",
			getHeader: () => ({ type: "session", id: "delivery-session", cwd: process.cwd() }),
		},
	};
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (tool: any) => tools.push(tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: (message: unknown, opts: unknown) => sent.push({ message, options: opts }),
		appendEntry: () => {},
	};
	subagents(pi);

	return {
		handlers,
		ctx,
		sent,
		setIdle: (value: boolean) => {
			idle = value;
		},
		/** Let the deferred wake timer fire. */
		settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
	};
}

/**
 * Every `Mailbox` ever constructed, in order.
 *
 * Recorded at construction rather than at first publish, so the extension's own
 * mailbox is identifiable the moment `subagents(pi)` returns. Nothing is
 * replaced or faked: this *is* the production mailbox, and everything downstream
 * of it — `onMail`, `routeMail`, the wake timer, `takeMail` — is production code.
 * That is the point of this half of the file.
 */
/**
 * Every manager the extension builds, captured as it is built.
 *
 * `SubagentManager` assigns `readonly mailbox = new Mailbox()` as a field
 * initialiser, so the instance exists before any method runs. Hooking
 * `setConfig` — which `session_start` calls on the real manager, unconditionally
 * and before anything else — catches it without replacing a single line of
 * production behaviour.
 *
 * Earlier attempts patched `Mailbox.prototype` instead and captured nothing: a
 * headless `session_start` touches none of its members, because `refreshUi` is
 * gated behind `registersUi`. Worth recording, because a capture that silently
 * finds nothing turns every assertion downstream into a tautology.
 */
const managers: SubagentManager[] = [];
{
	const originalSetConfig = SubagentManager.prototype.setConfig;
	SubagentManager.prototype.setConfig = function (this: SubagentManager, ...args: any[]) {
		if (!managers.includes(this)) managers.push(this);
		return (originalSetConfig as any).apply(this, args);
	};
}

/**
 * The mailbox belonging to the harness built most recently.
 *
 * Each `harness()` call runs `subagents(pi)`, which builds one manager and one
 * mailbox; `session_start` then calls `peek`/`refreshUi`, registering it. So the
 * newest recorded instance is this harness's.
 */
function mailboxOf(_h: ReturnType<typeof harness>): Mailbox {
	const manager = managers.at(-1);
	assert.ok(manager, "no manager was captured; the extension did not build one");
	return manager.mailbox;
}

/** Publish real mail into the extension's real mailbox and let it route. */
async function publish(h: ReturnType<typeof harness>, kind: MailKind, content = "body") {
	// `before_agent_start` is deliberately never called: that is the path that
	// requires a user, and the point is that delivery no longer depends on it.
	mailboxOf(h).publish({ kind, agentId: "a1", agentName: "worker", content });
	await h.settle();
}

test("a busy headless parent drains when its turn ends, with no user input", async () => {
	const h = harness({ hasUI: false, idle: false });
	await h.handlers.get("session_start")!({}, h.ctx);
	// The extension's own mailbox, reached by publishing into it directly.
	await publish(h, "final", "finished while you were busy");
	const duringTurn = h.sent.length;

	// The turn ends. Nobody typed; `before_agent_start` never fired.
	h.setIdle(true);
	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();

	assert.ok(
		h.sent.length > duringTurn,
		"the queue did not drain at the end of the turn, so it would have waited for a user who does not exist",
	);
	assert.match(String(h.sent.at(-1)!.message.content), /finished while you were busy/);
});

test("agent_settled drains a headless queue even when nothing armed a wake", async () => {
	// The old code only re-checked at settle if `onMail` had armed `wakeWhenIdle`
	// *and* `onFinish === "wake"`. Mail that arrived any other way — a reload, a
	// requeue after a failed send — sat there until a human typed.
	const h = harness({ hasUI: false, idle: true, onFinish: "notify" });
	await h.handlers.get("session_start")!({}, h.ctx);
	const mailbox = mailboxOf(h);
	// Published with no routing call at all: straight into the queue.
	mailbox.publish({ kind: "stall", agentId: "a1", agentName: "worker", content: "silent for ages" });

	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	assert.ok(h.sent.length > 0, "a settle must drain whatever is queued, however it got there");
});

test("before_agent_start is not the only way mail is delivered", async () => {
	// Directly the nesting bug: this handler fires only when a user sends a
	// message, and an intermediate parent never receives one.
	const h = harness({ hasUI: false, idle: true });
	await h.handlers.get("session_start")!({}, h.ctx);
	const mailbox = mailboxOf(h);
	mailbox.publish({ kind: "final", agentId: "a1", agentName: "worker", content: "done" });

	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	assert.ok(h.sent.length > 0, "delivery still depended on before_agent_start");
	// And the mailbox really was drained, not merely copied.
	assert.equal(mailbox.size, 0);
});

test("mail is never delivered twice, whichever path takes it", async () => {
	const h = harness({ hasUI: false, idle: true });
	await h.handlers.get("session_start")!({}, h.ctx);
	const mailbox = mailboxOf(h);
	mailbox.publish({ kind: "final", agentId: "a1", agentName: "worker", content: "once only" });

	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	const first = h.sent.length;
	assert.ok(first > 0);

	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	assert.equal(h.sent.length, first, "the same result was delivered twice");
});

test("a report alone never triggers a delivery", async () => {
	const h = harness({ hasUI: false, idle: true });
	await h.handlers.get("session_start")!({}, h.ctx);
	const mailbox = mailboxOf(h);
	mailbox.publish({ kind: "report", agentId: "a1", agentName: "worker", content: "still working" });

	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	assert.deepEqual(
		h.sent,
		[],
		"a chatty child must not drive parent turns; that is what `report` being passive protects",
	);
	// But it is not lost: it is still queued for whatever goes out next.
	assert.equal(mailbox.size, 1);
});

test("a queued report rides out with the next actionable delivery", async () => {
	const h = harness({ hasUI: false, idle: true });
	await h.handlers.get("session_start")!({}, h.ctx);
	const mailbox = mailboxOf(h);
	mailbox.publish({ kind: "report", agentId: "a1", agentName: "worker", content: "interim note" });
	mailbox.publish({ kind: "final", agentId: "a1", agentName: "worker", content: "all done" });

	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	assert.equal(h.sent.length, 1);
	assert.match(String(h.sent[0]!.message.content), /interim note/);
	assert.match(String(h.sent[0]!.message.content), /all done/);
});

test("a parent with a human keeps onFinish:notify, but still never waits forever", async () => {
	const h = harness({ hasUI: true, idle: true, onFinish: "notify" });
	await h.handlers.get("session_start")!({}, h.ctx);
	const mailbox = mailboxOf(h);
	mailbox.publish({ kind: "final", agentId: "a1", agentName: "worker", content: "done" });

	// The turn ending still delivers it: the preference is about not being
	// interrupted, not about the result being dropped.
	await h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	assert.ok(h.sent.length > 0, "even with a human, a result must not wait for input forever");
});

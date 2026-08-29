/**
 * The regression guard for the whole "nobody was told" class of bug.
 *
 * A stall was detected, shown in the human's UI, and never mailed to the
 * orchestrator. The first attempted fix added a wake rule for a `MailKind` that
 * did not exist and that nothing published — dead code that looked like a fix.
 *
 * So these tests do not check individual kinds. They check the *property*: that
 * every status a transition can reach either publishes mail or appears in the
 * table with a written reason for not doing so, and that both unions are covered
 * exhaustively. Adding a status or a kind without deciding its mail should fail
 * here, loudly, whoever adds it.
 *
 * There is no type-checker in this project's test loop (no `tsconfig.json`, no
 * typescript dependency), so the `never` assertions in transitions.ts are real
 * but nothing runs them. The union declarations are therefore re-derived from
 * the source text below and checked at runtime. That is the enforcing half.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EVICTABLE, type MailKind, Mailbox, formatMail, isEvictable } from "../mailbox.ts";
import { routeMail, selfDriving, wakesParent } from "../notify.ts";
import {
	ALL_CAUSES,
	ALL_STATUSES,
	ALL_TIMINGS,
	DELIVERY_BY_KIND,
	TRANSITION_TABLE,
	deliveryFor,
	describeTransitionTable,
	mailForTransition,
	timingDisagreements,
	transitionRows,
} from "../transitions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(here, "..", name), "utf-8");

/**
 * Pull the members of an exported string-literal union out of the source text.
 *
 * Deliberately textual. The point is to compare the table against the *union as
 * declared*, not against another list in the same file that could drift with it
 * — a list checking itself proves nothing.
 */
function unionMembers(file: string, typeName: string): string[] {
	const text = source(file);
	const start = text.indexOf(`export type ${typeName} =`);
	assert.ok(start >= 0, `cannot find "export type ${typeName}" in ${file}`);
	// Comment lines are stripped *first*. These unions are heavily commented and a
	// `;` inside a doc comment truncated the parse, which under-reported the
	// members and made the coverage checks pass for the wrong reason — the exact
	// failure mode this file exists to catch, occurring in the checker itself.
	const members: string[] = [];
	for (const line of text.slice(start).split("\n")) {
		if (/^\s*(\/\*|\*|\/\/)/.test(line)) continue;
		const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
		const match = /^\s*\|?\s*"([^"]+)"/.exec(code);
		if (match) members.push(match[1]!);
		// The declaration ends on the line whose code part terminates with `;`.
		if (/;\s*$/.test(code) && members.length > 0) break;
	}
	assert.ok(members.length > 0, `no string members parsed out of ${typeName}`);
	return members;
}

// --------------------------------------------------------------- the property --

test("every AgentStatus is in the transition table", () => {
	// The compile-time half is `Record<AgentStatus, StatusPolicy>`. This is the
	// half that actually runs.
	const declared = unionMembers("types.ts", "AgentStatus");
	const tabled = Object.keys(TRANSITION_TABLE).sort();
	assert.deepEqual(
		tabled,
		[...declared].sort(),
		"a status was added to AgentStatus without deciding its mail in transitions.ts",
	);
});

test("ALL_STATUSES matches the AgentStatus union exactly", () => {
	assert.deepEqual(
		[...ALL_STATUSES].sort(),
		unionMembers("types.ts", "AgentStatus").sort(),
		"ALL_STATUSES has drifted from the AgentStatus union",
	);
});

test("ALL_CAUSES matches the TransitionCause union exactly", () => {
	assert.deepEqual(
		[...ALL_CAUSES].sort(),
		unionMembers("transitions.ts", "TransitionCause").sort(),
		"ALL_CAUSES has drifted from the TransitionCause union",
	);
});

test("ALL_TIMINGS matches the DeliveryTiming union exactly", () => {
	assert.deepEqual(
		[...ALL_TIMINGS].sort(),
		unionMembers("transitions.ts", "DeliveryTiming").sort(),
	);
});

test("every MailKind has an eviction decision and a delivery timing", () => {
	const declared = unionMembers("mailbox.ts", "MailKind").sort();
	assert.deepEqual(
		Object.keys(EVICTABLE).sort(),
		declared,
		"a MailKind was added without deciding whether it can be evicted",
	);
	assert.deepEqual(
		Object.keys(DELIVERY_BY_KIND).sort(),
		declared,
		"a MailKind was added without deciding when it is delivered",
	);
});

test("EVERY reachable transition either publishes or gives a reason for silence", () => {
	// The whole point of the exercise, in one assertion.
	for (const { status, cause, decision } of transitionRows()) {
		const where = `${status}/${cause}`;
		assert.ok(
			typeof decision.why === "string" && decision.why.trim().length > 20,
			`${where} has no meaningful reason string; a silence without a reason is ` +
				"indistinguishable from the bug this table exists to prevent",
		);
		if (decision.publish === "silent") continue;
		assert.ok(
			ALL_TIMINGS.includes(decision.deliver),
			`${where} publishes ${decision.publish} with an unknown delivery timing`,
		);
	}
});

test("mailForTransition is total over every status and cause", () => {
	// No combination may fall through to undefined: the fallback to the status's
	// `default` row is what makes the table safe to extend with new causes.
	for (const status of ALL_STATUSES) {
		for (const cause of ALL_CAUSES) {
			const decision = mailForTransition(status, cause);
			assert.ok(decision, `${status}/${cause} produced no decision`);
			assert.equal(typeof decision.why, "string");
			assert.equal(typeof decision.persist, "boolean");
		}
	}
});

// ------------------------------------------------------- the deliberate silences --

test("the deliberate silences are present, with their reasons", () => {
	// Each of these was a real decision that cost something to make. If one turns
	// into a publish, that must be a deliberate edit here rather than a surprise.
	const cases: Array<[Parameters<typeof mailForTransition>[0], Parameters<typeof mailForTransition>[1], RegExp]> = [
		// S4: publishing here reported the parent's own action back as a failure.
		["interrupted", "abort-requested", /S4|asked for/i],
		["failed", "abort-requested", /S4|asked for/i],
		// Hibernation the orchestrator itself triggered.
		["hibernated", "shutdown", /asked|triggered/i],
		["hibernated", "reload-restore", /same conversation|not forgotten|has not forgotten/i],
		// Its own action; the tool call returns the outcome.
		["closed", "closed", /own action|tool call/i],
		// Progress, not news.
		["running", "resumed", /progress|news/i],
		["starting", "spawn", /synchronous|spawn tool/i],
	];
	for (const [status, cause, reason] of cases) {
		const decision = mailForTransition(status, cause);
		assert.equal(decision.publish, "silent", `${status}/${cause} should be silent`);
		assert.match(decision.why, reason, `${status}/${cause} reason changed: ${decision.why}`);
	}
});

test("the two known gaps are now covered", () => {
	// The idle sweep hibernating an agent the orchestrator chose to KEEP.
	const idle = mailForTransition("hibernated", "idle-sweep");
	assert.equal(idle.publish, "hibernated");
	assert.match(idle.why, /KEEP|kept|decided/i);

	// A cold start surfacing children from the registry.
	const cold = mailForTransition("hibernated", "cold-restore");
	assert.equal(cold.publish, "restored");
	assert.match(cold.why, /no memory|duplicate/i);
});

test("a settled turn publishes final, and a settled failure publishes error", () => {
	assert.equal(mailForTransition("completed", "settled").publish, "final");
	assert.equal(mailForTransition("failed", "settled").publish, "error");
	assert.equal(mailForTransition("failed", "died").publish, "error");
	assert.equal(mailForTransition("waiting", "asked").publish, "question");
	assert.equal(mailForTransition("stalled", "silent").publish, "stall");
});

test("a repeated stall is not re-mailed every sweep tick", () => {
	// The sweep runs on a timer; `stall` cannot be evicted, so re-publishing it
	// every tick would fill the mailbox with a kind nothing can trim.
	assert.equal(mailForTransition("stalled", "silent").publish, "stall");
	assert.equal(mailForTransition("stalled", "still-silent").publish, "silent");
});

test("stopAll's closed status is deliberately not persisted", () => {
	// The load-bearing `persist: false`: `stopAll` checkpoints the tree *before*
	// marking everything closed so a cold start can offer the conversations back.
	// Writing the `closed` through would erase exactly what the checkpoint was for.
	assert.equal(mailForTransition("closed", "shutdown").persist, false);
	assert.equal(mailForTransition("closed", "closed").persist, true);
});

// ------------------------------------------------------------------- eviction --

test("only report is evictable, and a new kind must opt in explicitly", () => {
	assert.equal(isEvictable("report"), true);
	for (const kind of Object.keys(EVICTABLE) as MailKind[]) {
		if (kind === "report") continue;
		assert.equal(isEvictable(kind), false, `${kind} must not be evictable without a decision`);
	}
});

test("a non-evictable kind survives a mailbox flooded past its bounds", () => {
	// The real mechanism, not the flag: publish far past both bounds and assert
	// nothing exempt was dropped.
	const mailbox = new Mailbox({ maxMessageBytes: 200, maxMessagesPerAgent: 1 });
	const exempt = (Object.keys(EVICTABLE) as MailKind[]).filter((k) => !isEvictable(k));
	for (const kind of exempt) {
		mailbox.publish({ kind, agentId: "a", agentName: "a", content: `keep-${kind}` });
	}
	for (let i = 0; i < 50; i++) {
		mailbox.publish({ kind: "report", agentId: "a", agentName: "a", content: `chatter ${"x".repeat(200)}` });
	}
	const survivors = mailbox.peek();
	for (const kind of exempt) {
		assert.ok(
			survivors.some((e) => e.kind === kind && e.content === `keep-${kind}`),
			`${kind} was evicted; a dropped question blocks a child forever and a dropped stall recreates the original bug`,
		);
	}
	// And the chatter really was trimmed, i.e. the bounds were actually exercised.
	assert.ok(
		survivors.filter((e) => e.kind === "report").length <= 1,
		"the report bound did not fire, so this test proved nothing",
	);
});

// ------------------------------------------------------------------- delivery --

test("the table's per-transition timing agrees with the per-kind timing", () => {
	// `notify.ts` routes an already-published event, which no longer knows its
	// cause, so the timing has to be derivable from the kind alone. A row claiming
	// to be more urgent than its kind would have that urgency silently dropped at
	// delivery — which is this file's whole subject.
	//
	// This caught a real one: an exhausted auto-resume was written as an `error`
	// that steers. `error` is delivered at turn end, so the steer would never have
	// happened. It publishes `stall` now, which is what it actually is.
	assert.deepEqual(timingDisagreements(), []);
	for (const { status, cause, decision } of transitionRows()) {
		if (decision.publish === "silent") continue;
		assert.equal(
			decision.deliver,
			deliveryFor(decision.publish),
			`${status}/${cause} publishes ${decision.publish} with timing ${decision.deliver}, ` +
				`but DELIVERY_BY_KIND says ${deliveryFor(decision.publish)}`,
		);
	}
});

test("report is the only kind that waits for a user", () => {
	// The nesting invariant, asserted over every kind at once rather than case by
	// case: an intermediate parent has no human, so anything actionable that
	// routed to "next-request" would never be delivered at all.
	for (const kind of Object.keys(DELIVERY_BY_KIND) as MailKind[]) {
		if (kind === "report") {
			assert.equal(selfDriving(kind), false);
			assert.equal(deliveryFor(kind), "next-request");
			continue;
		}
		assert.equal(selfDriving(kind), true, `${kind} must not depend on a user typing`);
		assert.notEqual(deliveryFor(kind), "next-request");
	}
});

test("kinds meaning something is STOPPED are steered into a running turn", () => {
	// A blocked or stalled child does not get better while the parent works.
	for (const kind of ["question", "stall"] as const) {
		assert.equal(deliveryFor(kind), "immediate-steer");
		assert.equal(routeMail({ kind, idle: false, onFinish: "wake" }), "steer");
	}
	// Results are not urgent in that sense: nothing is blocked, so they wait for
	// the turn to end rather than interrupting a tool call.
	for (const kind of ["final", "error"] as const) {
		assert.equal(routeMail({ kind, idle: false, onFinish: "wake" }), "at-settle");
	}
});

test("a busy parent never leaves actionable mail waiting for a user", () => {
	for (const kind of Object.keys(DELIVERY_BY_KIND) as MailKind[]) {
		const route = routeMail({ kind, idle: false, onFinish: "wake" });
		if (kind === "report") {
			assert.equal(route, "ride");
			continue;
		}
		assert.notEqual(
			route,
			"ride",
			`${kind} routed to "ride" while the parent was busy, which means "never" for a headless parent`,
		);
	}
});

test("report still never wakes an idle parent, whatever else changed", () => {
	// The constraint that must survive every rework of this file: a chatty child
	// starting a parent turn every few seconds destroys "spawning does not block
	// you". This is about `report`'s volume, not about whether a human exists.
	assert.equal(wakesParent("report", "wake"), false);
	assert.equal(routeMail({ kind: "report", idle: true, onFinish: "wake" }), "ride");
	assert.equal(routeMail({ kind: "report", idle: true, onFinish: "wake", hasUI: false }), "ride");
	assert.equal(routeMail({ kind: "report", idle: false, onFinish: "wake", hasUI: false }), "ride");
});

test("a headless parent drains everything actionable, ignoring onFinish", () => {
	// The nesting case. `onFinish: "notify"` is a preference held by a watching
	// human; with no human there is nobody to hold it, and honouring it would
	// strand the queue forever.
	for (const kind of Object.keys(DELIVERY_BY_KIND) as MailKind[]) {
		if (kind === "report") continue;
		assert.equal(
			routeMail({ kind, idle: true, onFinish: "notify", hasUI: false }),
			"wake",
			`${kind} was not delivered to an idle headless parent`,
		);
	}
});

// ------------------------------------------------------------------ rendering --

test("every kind renders a distinct label, so none reads as routine chatter", () => {
	const seen = new Map<string, string>();
	for (const kind of Object.keys(DELIVERY_BY_KIND) as MailKind[]) {
		const text = formatMail(
			[{ sequence: 1, kind, agentId: "a", agentName: "worker", content: "body", createdAt: 0 }],
			"NONCE",
		);
		const label = /kind="([^"]+)"/.exec(text)?.[1];
		assert.ok(label, `${kind} rendered no kind attribute`);
		if (kind !== "report") {
			assert.notEqual(
				label,
				"interim report",
				`${kind} fell through to the "interim report" label, which is how an urgent notice reads as ignorable`,
			);
		}
		const clash = seen.get(label!);
		assert.equal(clash, undefined, `${kind} and ${clash} share the label "${label}"`);
		seen.set(label!, kind);
	}
});

test("every actionable kind has a rule in orchestrator.md", () => {
	// The standing lesson of this whole exercise, made mechanical: a capability
	// without a line in orchestrator.md means the model has the tool and not the
	// habit. The stall bug needed three fixes — the kind, the publish, and the
	// rule — and shipping two of the three is what made it look fixed.
	const guidance = readFileSync(join(here, "..", "orchestrator.md"), "utf-8").toLowerCase();
	// What the orchestrator must recognise when it sees each kind. Keyed on the
	// kind so a new one cannot be added without landing here.
	const expected: Record<Exclude<MailKind, "report">, RegExp> = {
		final: /final result/,
		error: /failed in a way|close it/,
		question: /ask_parent|answering subagent questions/,
		stall: /stall/,
		hibernated: /hibernated/,
		restored: /restored/,
		resumed: /auto-resumed/,
	};
	for (const kind of Object.keys(DELIVERY_BY_KIND) as MailKind[]) {
		if (kind === "report") continue; // Context, not a decision; needs no rule.
		const pattern = expected[kind as Exclude<MailKind, "report">];
		assert.ok(pattern, `${kind} has no expected orchestrator.md rule declared in this test`);
		assert.match(
			guidance,
			pattern,
			`orchestrator.md says nothing an orchestrator could act on for "${kind}" mail`,
		);
		// Mentioning a kind is not a rule. The paragraph around the mention has to
		// tell the model to *do* something — the whole failure being guarded against
		// is guidance that describes a situation and leaves the model to infer the
		// action, which is exactly what it does not reliably do.
		const at = guidance.search(pattern);
		const around = guidance.slice(Math.max(0, at - 400), at + 800);
		assert.match(
			around,
			/subagent \{action|close it|read it|follow it up|answer|retry|do not/,
			`orchestrator.md mentions "${kind}" but prescribes no action near it`,
		);
	}
});

test("the rendered table names every row and both extremes of the timing scale", () => {
	const text = describeTransitionTable();
	for (const status of ALL_STATUSES) assert.match(text, new RegExp(status));
	assert.match(text, /immediate-steer/);
	assert.match(text, /next-request/);
	// It is shown to a human by `/agents mail`; a table with no reasons in it
	// would not answer "why was I not told about that?".
	assert.ok(text.split("\n").length > ALL_STATUSES.length);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Mailbox } from "../mailbox.ts";
import {
	countAgents,
	formatStatus,
	returnMail,
	routeMail,
	statusBadges,
	takeMail,
	wakesParent,
} from "../notify.ts";

test("no agents means no footer status", () => {
	assert.equal(formatStatus([], 0), undefined);
	// Closed agents no longer exist; they must not keep the footer alive.
	assert.equal(formatStatus(["closed", "closed"], 0), undefined);
});

test("the status line counts each state", () => {
	assert.equal(
		formatStatus(["running", "completed", "completed"], 1),
		"subagents: 1 running, 2 done (1 unread)",
	);
	assert.equal(formatStatus(["starting"], 0), "subagents: 1 running");
});

test("the footer shows the two most actionable states and counts the rest", () => {
	// The footer is one line shared with every other extension, so a census of
	// eight states would push everybody else off the screen. The switcher below
	// the editor carries the full breakdown.
	assert.equal(
		formatStatus(["failed", "interrupted", "idle"], 0),
		"subagents: 1 failed, 1 stopped, +1 more",
	);
	// Ordered by what wants a human, so truncation never drops the urgent part.
	assert.equal(
		formatStatus(
			["waiting", "running", "running", "stalled", "completed", "failed", "hibernated"],
			3,
		),
		"subagents: 1 waiting for you, 2 running, +4 more (3 unread)",
	);
	// `+N more` counts agents, not states, so the line still adds up to the total.
	const line = formatStatus(["running", "completed", "completed", "idle", "idle", "idle"], 0)!;
	assert.equal(line, "subagents: 1 running, 2 done, +3 more");
});

test("a single state needs no remainder", () => {
	// The everyday case, and the whole reason for the cap: short enough to sit
	// beside another extension's status.
	assert.equal(formatStatus(["running"], 0), "subagents: 1 running");
	assert.equal(formatStatus(["hibernated", "hibernated"], 0), "subagents: 2 hibernated");
	assert.ok(!formatStatus(["running", "completed"], 0)?.includes("more"));
});

test("unread is only mentioned when there is unread mail", () => {
	assert.ok(!formatStatus(["completed"], 0)?.includes("unread"));
	assert.match(formatStatus(["completed"], 3)!, /\(3 unread\)$/);
});

test("countAgents ignores closed agents", () => {
	const counts = countAgents(["running", "closed", "completed"]);
	assert.equal(counts.total, 2);
	assert.equal(counts.running, 1);
	assert.equal(counts.done, 1);
});

test("interim reports never wake the parent", () => {
	assert.equal(wakesParent("report", "wake"), false);
	assert.equal(routeMail({ kind: "report", idle: true, onFinish: "wake" }), "ride");
});

test("a final result wakes an idle parent, and settles into a busy one", () => {
	assert.equal(routeMail({ kind: "final", idle: true, onFinish: "wake" }), "wake");
	assert.equal(routeMail({ kind: "error", idle: true, onFinish: "wake" }), "wake");
	// Busy: delivered when the turn ends, NOT when a user next types. A turn
	// always ends; a user typing is not guaranteed to ever happen, and under
	// nesting it is guaranteed not to.
	assert.equal(routeMail({ kind: "final", idle: false, onFinish: "wake" }), "at-settle");
});

test('onFinish "notify" defers a result to the end of the turn, never to a user', () => {
	assert.equal(wakesParent("final", "notify"), false);
	// It no longer "rides": the human asked not to be interrupted, which is a
	// statement about starting a turn, not a licence to strand the result.
	assert.equal(routeMail({ kind: "final", idle: true, onFinish: "notify" }), "at-settle");
	assert.equal(routeMail({ kind: "error", idle: true, onFinish: "notify" }), "at-settle");
	// And with no human there is nobody to hold that preference at all.
	assert.equal(
		routeMail({ kind: "final", idle: true, onFinish: "notify", hasUI: false }),
		"wake",
	);
});

test("mail is taken exactly once, whichever path takes it", () => {
	const mailbox = new Mailbox();
	mailbox.publish({ kind: "final", agentId: "a", agentName: "a", content: "done" });
	const first = takeMail(mailbox);
	assert.match(first!.content, /done/);
	// The other delivery path finds nothing left, so nothing is said twice.
	assert.equal(takeMail(mailbox), undefined);
	assert.equal(mailbox.size, 0);
});

test("mail whose delivery failed goes back in the mailbox", () => {
	const mailbox = new Mailbox();
	mailbox.publish({ kind: "error", agentId: "a", agentName: "a", content: "boom" });
	const taken = takeMail(mailbox)!;
	returnMail(mailbox, taken.events);
	assert.equal(mailbox.size, 1);
	assert.match(takeMail(mailbox)!.content, /boom/);
});

test("an empty mailbox produces no delivery at all", () => {
	assert.equal(takeMail(new Mailbox()), undefined);
});

// --- the badge form --------------------------------------------------------

/** `tone:text` pairs, the shape the border bar actually receives. */
const badges = (statuses: any[], unread = 0) =>
	statusBadges(statuses, unread)?.map((b) => `${b.tone}:${b.text}`);

test("the ordinary case is one chip: a glyph and a count", () => {
	// What the user asked for. No `subagents:` label — the robot is the label, and
	// the bar is shared, so nine columns of prose is nine columns somebody else
	// does not get.
	assert.deepEqual(badges(["running"]), ["ok:🤖 1"]);
	assert.deepEqual(badges(["running", "running"]), ["ok:🤖 2"]);
	// Closed agents no longer exist and must not be counted, exactly as in the
	// sentence form.
	assert.deepEqual(badges(["running", "closed"]), ["ok:🤖 1"]);
	assert.equal(statusBadges([], 0), undefined);
	assert.equal(statusBadges(["closed"], 0), undefined);
});

test("the count is every agent, and the state rides in the tone", () => {
	// The information the sentence used to spell out is not thrown away — it moves
	// channel. One number, one colour.
	assert.deepEqual(badges(["running", "completed", "hibernated"]), ["ok:🤖 3"]);
});

test("an agent blocked on you outranks everything else", () => {
	// `ask_parent` has no timeout, so a waiting child is stopped until a human or
	// the orchestrator answers. It outranks a failure on purpose: a failure has
	// finished happening, this one is still costing wall-clock.
	assert.deepEqual(badges(["waiting"]), ["warn:🤖 1"]);
	assert.deepEqual(badges(["waiting", "failed", "running"]), ["warn:🤖 3"]);
	assert.deepEqual(badges(["waiting", "stalled"]), ["warn:🤖 2"]);
});

test("broken work is an error tone, whether it stalled or failed", () => {
	assert.deepEqual(badges(["failed"]), ["error:🤖 1"]);
	assert.deepEqual(badges(["stalled"]), ["error:🤖 1"]);
	// Ahead of merely-running work: something wants investigating.
	assert.deepEqual(badges(["running", "failed"]), ["error:🤖 2"]);
	assert.deepEqual(badges(["running", "stalled"]), ["error:🤖 2"]);
});

test("a spawn that has not started anything yet says wait, not working", () => {
	// A spawn can spend a whole context summarization before its child exists, and
	// `ok` during that window claims work is under way when none is.
	assert.deepEqual(badges(["starting"]), ["pending:🤖 1"]);
	assert.deepEqual(badges(["starting", "starting"]), ["pending:🤖 2"]);
	// Once anything is genuinely running, that is the more useful thing to say.
	assert.deepEqual(badges(["starting", "running"]), ["ok:🤖 2"]);
});

test("a finished agent is information to read; a parked one recedes", () => {
	// The `neutral` / `muted` line from the shared vocabulary. A completed agent
	// still needs a close-or-keep decision; a hibernated one needs nothing.
	assert.deepEqual(badges(["completed"]), ["neutral:🤖 1"]);
	assert.deepEqual(badges(["hibernated"]), ["muted:🤖 1"]);
	assert.deepEqual(badges(["idle"]), ["muted:🤖 1"]);
	assert.deepEqual(badges(["interrupted"]), ["muted:🤖 1"]);
	// Something worth reading beats something worth ignoring.
	assert.deepEqual(badges(["completed", "hibernated"]), ["neutral:🤖 2"]);
});

test("unread earns a second chip, and only while there is any", () => {
	// Not folded into the tone: unread is not a state of the agents, and
	// overwriting "one of these is blocked on you" with "you have mail" would lose
	// the more urgent of the two. Mail drains by itself; a blocked child does not.
	assert.deepEqual(badges(["running"], 0), ["ok:🤖 1"]);
	assert.deepEqual(badges(["running"], 3), ["ok:🤖 1", "neutral:● 3"]);
	assert.deepEqual(badges(["waiting"], 1), ["warn:🤖 1", "neutral:● 1"]);
});

test("the badges and the sentence never disagree about there being nothing", () => {
	// Both forms are built from one set of counts, so "nothing to say" has to mean
	// the same thing in both — otherwise the footer clears while the bar keeps a
	// stale chip, or the reverse.
	for (const statuses of [[], ["closed"], ["closed", "closed"]] as any[]) {
		assert.equal(statusBadges(statuses, 0), undefined);
		assert.equal(formatStatus(statuses, 0), undefined);
	}
	for (const statuses of [["running"], ["waiting", "failed"], ["hibernated"]] as any[]) {
		assert.notEqual(statusBadges(statuses, 0), undefined);
		assert.notEqual(formatStatus(statuses, 0), undefined);
	}
});

/**
 * The child→parent question channel.
 *
 * Two processes and a directory. The parts worth pinning down are the ones that
 * are easy to get subtly wrong: the path cannot escape its directory, a
 * half-written answer must not be read as an answer, and a malformed update must
 * not park an agent in a `waiting` state nobody will ever clear.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	answerPath,
	answersDirectory,
	parseAnswer,
	questionFromUpdate,
	sanitizeQuestionId,
} from "../ask.ts";

// --- paths ----------------------------------------------------------------

test("answers live inside the child's own session directory", () => {
	assert.equal(answersDirectory("/s/agent"), "/s/agent/answers");
	assert.equal(answerPath("/s/agent/answers", "q-1"), "/s/agent/answers/q-1.json");
});

test("a question id can never escape the answers directory", () => {
	// The id crosses a process boundary and lands in a path; treating it as
	// trusted would let either side write anywhere.
	assert.equal(answerPath("/s/answers", "../../etc/passwd"), "/s/answers/etcpasswd.json");
	assert.equal(answerPath("/s/answers", "a/b"), "/s/answers/ab.json");
	assert.equal(sanitizeQuestionId(""), "question");
	assert.equal(sanitizeQuestionId("!!!"), "question");
	assert.equal(sanitizeQuestionId("q-abc_123"), "q-abc_123");
	assert.equal(sanitizeQuestionId("x".repeat(200)).length, 64);
});

// --- the answer file ------------------------------------------------------

test("a complete answer parses", () => {
	const answer = parseAnswer(
		JSON.stringify({ questionId: "q1", answer: "use postgres", answeredAt: 5, answeredBy: "parent" }),
	);
	assert.deepEqual(answer, {
		questionId: "q1",
		answer: "use postgres",
		answeredAt: 5,
		answeredBy: "parent",
	});
});

test("a half-written file is not an answer", () => {
	// The child polls, so it will read a file mid-write unless the parent renames
	// atomically. Even with rename, refusing to parse junk is the safety net.
	assert.equal(parseAnswer('{"questionId":"q1","ans'), undefined);
	assert.equal(parseAnswer(""), undefined);
	assert.equal(parseAnswer("null"), undefined);
	assert.equal(parseAnswer('"a string"'), undefined);
});

test("an answer without answer text is not an answer", () => {
	assert.equal(parseAnswer(JSON.stringify({ questionId: "q1" })), undefined);
	assert.equal(parseAnswer(JSON.stringify({ questionId: "q1", answer: 42 })), undefined);
});

test("an empty answer is still an answer", () => {
	// The parent may deliberately say nothing useful; that is its right, and the
	// child must unblock rather than poll forever.
	assert.equal(parseAnswer(JSON.stringify({ questionId: "q1", answer: "" }))?.answer, "");
});

// --- reading a question off the event stream ------------------------------

const update = (details: unknown, toolName = "ask_parent") => ({
	type: "tool_execution_update",
	toolName,
	partialResult: { details },
});

test("a well-formed ask_parent update becomes a pending question", () => {
	const question = questionFromUpdate(
		update({ questionId: "q-1", question: "postgres or sqlite?", context: "both work" }),
		1_000,
	);
	assert.deepEqual(question, {
		id: "q-1",
		question: "postgres or sqlite?",
		context: "both work",
		askedAt: 1_000,
	});
});

test("details may arrive at the top level as well as under partialResult", () => {
	const question = questionFromUpdate({
		type: "tool_execution_update",
		toolName: "ask_parent",
		details: { questionId: "q-2", question: "which port?" },
	});
	assert.equal(question?.id, "q-2");
});

test("updates from other tools are ignored", () => {
	assert.equal(questionFromUpdate(update({ questionId: "q", question: "?" }, "bash")), undefined);
	assert.equal(questionFromUpdate({ type: "tool_execution_update" }), undefined);
});

test("a malformed update never parks an agent in a waiting state", () => {
	// Without an id there is no file to answer, so a `waiting` status set from
	// this would never be cleared by anything.
	for (const details of [
		undefined,
		null,
		"nope",
		{},
		{ questionId: "q" },
		{ question: "?" },
		{ questionId: "  ", question: "?" },
		{ questionId: "q", question: "   " },
	]) {
		assert.equal(questionFromUpdate(update(details)), undefined, JSON.stringify(details));
	}
});

test("blank context is dropped rather than carried as empty", () => {
	const question = questionFromUpdate(update({ questionId: "q", question: "?", context: "   " }));
	assert.equal(question?.context, undefined);
});

// --- routing: a question is not a report ----------------------------------

import { formatMail, Mailbox } from "../mailbox.ts";
import { countAgents, formatStatus, routeMail, wakesParent } from "../notify.ts";
import { isStalled, stallTransition } from "../stall.ts";

test("a question always wakes the parent, even in notify mode", () => {
	// `onFinish` governs whether *finished work* starts a turn. A blocked child
	// is not finished work, and nobody else is coming to unblock it.
	assert.equal(wakesParent("question", "wake"), true);
	assert.equal(wakesParent("question", "notify"), true);
	assert.equal(wakesParent("report", "wake"), false);
});

test("a question routed at an idle parent wakes it", () => {
	assert.equal(routeMail({ kind: "question", idle: true, onFinish: "notify" }), "wake");
	// A busy parent is STEERED, not left to its next request. This assertion was
	// the other way round until nesting made it wrong: "its next request" means
	// "when a user types", and a blocked child under a headless intermediate
	// parent would have waited for a user who does not exist. `ask_parent` has no
	// timeout, so that is a permanent deadlock rather than a delay.
	assert.equal(routeMail({ kind: "question", idle: false, onFinish: "wake" }), "steer");
});

test("a question card carries the answer affordance, not the close one", () => {
	const text = formatMail(
		[{ sequence: 1, kind: "question", agentId: "a", agentName: "worker", content: "?", createdAt: 0 }],
		"NONCE",
	);
	assert.match(text, /subagent\{action:"answer",name:"worker"/);
	assert.doesNotMatch(text, /action:"close"/);
	assert.match(text, /blocked waiting for your answer/);
	// Same anti-forgery placement as every other affordance.
	assert.ok(text.indexOf('action:"answer"') > text.indexOf("</subagent-NONCE>"));
});

test("questions are never dropped by the mailbox bounds", () => {
	const box = new Mailbox({ maxMessageBytes: 64, maxMessagesPerAgent: 1 });
	box.publish({ kind: "question", agentId: "a", agentName: "a", content: "q".repeat(500) });
	for (let i = 0; i < 5; i += 1) {
		box.publish({ kind: "report", agentId: "a", agentName: "a", content: "r".repeat(200) });
	}
	// A dropped question is a child blocked forever.
	assert.equal(box.peek().filter((e) => e.kind === "question").length, 1);
});

// --- waiting is not stalling ----------------------------------------------

test("a child blocked on a question is never reported as network-stalled", () => {
	const silent = {
		busy: true,
		status: "running",
		lastEventAt: 0,
		now: 10_000_000,
		stallSeconds: 120,
	};
	assert.equal(isStalled(silent), true);
	// Same silence, but explained: blaming the network would send the human to
	// check their wifi when what is needed is an answer.
	assert.equal(isStalled({ ...silent, awaitingAnswer: true }), false);
	assert.equal(stallTransition({ ...silent, awaitingAnswer: true }), undefined);
});

test("answering a long-silent child lets the stall rules apply again", () => {
	const base = { busy: true, status: "running", lastEventAt: 0, now: 10_000_000, stallSeconds: 120 };
	assert.equal(stallTransition({ ...base, awaitingAnswer: true }), undefined);
	assert.equal(stallTransition({ ...base, awaitingAnswer: false }), "stalled");
});

test("waiting agents are counted separately and reported first", () => {
	const counts = countAgents(["waiting", "running", "completed"]);
	assert.equal(counts.waiting, 1);
	assert.equal(counts.running, 1);
	// It leads the line because it is the only state blocked on the human.
	assert.match(formatStatus(["running", "waiting", "completed"], 0)!, /^subagents: 1 waiting for you/);
});

// --- enqueueing is a guarantee, delivery timing is not --------------------
//
// For a child, asking is blocking and unbounded: there is no timeout on
// ask_parent, so the parent's queue is the only thing standing between a
// question and a permanently stuck agent. These tests pin down that a question,
// once published, survives everything.

import { takeMail, returnMail } from "../notify.ts";

test("a question published while the parent is busy is intact at the next drain", () => {
	const box = new Mailbox();
	// Nothing here consults idleness: publishing is unconditional by construction.
	box.publish({
		kind: "question",
		agentId: "a1",
		agentName: "worker",
		questionId: "q-7",
		content: "postgres or sqlite?",
	});
	// The parent stays busy for a while; other traffic comes and goes.
	for (let i = 0; i < 10; i += 1) {
		box.publish({ kind: "report", agentId: "a1", agentName: "worker", content: `note ${i}` });
	}

	const mail = takeMail(box)!;
	const question = mail.events.find((e) => e.kind === "question");
	assert.ok(question, "the question survived the busy period");
	assert.equal(question!.content, "postgres or sqlite?");
	assert.equal(question!.questionId, "q-7");
	assert.match(mail.content, /postgres or sqlite\?/);
	assert.match(mail.content, /subagent\{action:"answer",name:"worker"/);
});

test("bounds pressure from interim reports never evicts a queued question", () => {
	// Deliberately brutal limits: the report bound is what does the evicting, and
	// a question caught by it would block its child forever.
	const box = new Mailbox({ maxMessageBytes: 128, maxMessagesPerAgent: 1 });
	box.publish({
		kind: "question",
		agentId: "a1",
		agentName: "worker",
		questionId: "q-1",
		content: "which port?",
	});
	for (let i = 0; i < 200; i += 1) {
		box.publish({ kind: "report", agentId: "a1", agentName: "worker", content: "x".repeat(500) });
	}

	const questions = box.peek().filter((e) => e.kind === "question");
	assert.equal(questions.length, 1);
	assert.equal(questions[0]!.content, "which port?");
	assert.equal(questions[0]!.questionId, "q-1");
});

test("several children can be blocked at once, each answerable specifically", () => {
	const box = new Mailbox();
	box.publish({ kind: "question", agentId: "a1", agentName: "api", questionId: "q-1", content: "port?" });
	box.publish({ kind: "report", agentId: "a2", agentName: "ui", content: "progress" });
	box.publish({ kind: "question", agentId: "a2", agentName: "ui", questionId: "q-2", content: "theme?" });
	box.publish({ kind: "question", agentId: "a3", agentName: "db", questionId: "q-3", content: "engine?" });

	const mail = takeMail(box)!;
	// Requirement 4: they ride together as distinct entries, none collapsed.
	const questions = mail.events.filter((e) => e.kind === "question");
	assert.deepEqual(questions.map((e) => e.agentName), ["api", "ui", "db"]);
	assert.deepEqual(questions.map((e) => e.questionId), ["q-1", "q-2", "q-3"]);
	// Queue order is preserved across kinds, too.
	assert.deepEqual(mail.events.map((e) => e.agentName), ["api", "ui", "ui", "db"]);
	// Each carries its own answer affordance naming its own agent.
	for (const name of ["api", "ui", "db"]) {
		assert.match(mail.content, new RegExp(`subagent\\{action:"answer",name:"${name}"`));
	}
});

test("a delivery that fails puts every question back, ids intact", () => {
	const box = new Mailbox();
	box.publish({ kind: "question", agentId: "a1", agentName: "api", questionId: "q-1", content: "port?" });
	box.publish({ kind: "question", agentId: "a2", agentName: "ui", questionId: "q-2", content: "theme?" });

	const mail = takeMail(box)!;
	assert.equal(box.size, 0);
	returnMail(box, mail.events); // e.g. sendMessage threw.

	const back = box.peek().filter((e) => e.kind === "question");
	assert.deepEqual(back.map((e) => e.questionId), ["q-1", "q-2"]);
	assert.deepEqual(back.map((e) => e.agentName), ["api", "ui"]);
});

test("answering one child does not disturb another's queued question", () => {
	const box = new Mailbox();
	box.publish({ kind: "question", agentId: "a1", agentName: "api", questionId: "q-1", content: "port?" });
	box.publish({ kind: "question", agentId: "a2", agentName: "ui", questionId: "q-2", content: "theme?" });

	// This is what manager.answer() does: drain only the answered agent's mail.
	box.drain("a1");

	const left = box.peek();
	assert.equal(left.length, 1);
	assert.equal(left[0]!.agentName, "ui");
	assert.equal(left[0]!.questionId, "q-2");
});

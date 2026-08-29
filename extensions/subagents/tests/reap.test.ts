/**
 * Reaping finished children.
 *
 * Two rules, both destructive if wrong: auto-reap ends a conversation to free a
 * slot, and the idle sweep stops a process. They are pure functions precisely so
 * the edges can be argued with here rather than discovered in production.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_IDLE_HIBERNATE_MINUTES,
	type ReapCandidate,
	isReclaimable,
	lastActiveAt,
	selectIdleHibernations,
	selectReapVictim,
	shouldIdleHibernate,
} from "../reap.ts";

const MINUTE = 60_000;
const NOW = 10_000_000;

function candidate(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
	return {
		id: "a",
		name: "a",
		status: "completed",
		busy: false,
		startedAt: NOW - 60 * MINUTE,
		endedAt: NOW - 10 * MINUTE,
		lastEventAt: NOW - 10 * MINUTE,
		hasProcess: true,
		...overrides,
	};
}

// --- what may be reclaimed ------------------------------------------------

test("only finished and already-sleeping agents may be reclaimed", () => {
	assert.equal(isReclaimable(candidate({ status: "completed" })), true);
	assert.equal(isReclaimable(candidate({ status: "hibernated", hasProcess: false })), true);
});

test("work in flight is never reclaimed", () => {
	for (const status of ["running", "starting", "stalled"]) {
		assert.equal(isReclaimable(candidate({ status, busy: true })), false, status);
		// Even a non-busy agent in one of these states is not finished.
		assert.equal(isReclaimable(candidate({ status })), false, `${status} (idle)`);
	}
});

test("a failed agent is kept: its transcript is the only post-mortem", () => {
	assert.equal(isReclaimable(candidate({ status: "failed" })), false);
});

test("an interrupted agent is the human's to resume, not ours to reclaim", () => {
	assert.equal(isReclaimable(candidate({ status: "interrupted" })), false);
});

test("a completed agent that started a new turn is busy again", () => {
	assert.equal(isReclaimable(candidate({ status: "completed", busy: true })), false);
});

// --- which one ------------------------------------------------------------

test("lastActiveAt is the most recent of any activity, not just the finish", () => {
	// Followed up after it finished: that follow-up is what makes it recent.
	assert.equal(
		lastActiveAt(candidate({ endedAt: NOW - 30 * MINUTE, lastEventAt: NOW - MINUTE })),
		NOW - MINUTE,
	);
	// Never produced an event: fall back to when it started.
	assert.equal(
		lastActiveAt({ ...candidate(), lastEventAt: undefined, endedAt: undefined }),
		NOW - 60 * MINUTE,
	);
});

test("the least recently active finished agent is the victim", () => {
	const choice = selectReapVictim([
		candidate({ id: "fresh", lastEventAt: NOW - MINUTE, endedAt: NOW - MINUTE }),
		candidate({ id: "stale", lastEventAt: NOW - 90 * MINUTE, endedAt: NOW - 90 * MINUTE }),
		candidate({ id: "middle", lastEventAt: NOW - 20 * MINUTE, endedAt: NOW - 20 * MINUTE }),
	]);
	assert.equal(choice.victim?.id, "stale");
});

test("an old agent followed up recently is not the stalest one", () => {
	// The whole point of using lastActiveAt: this agent finished long ago but the
	// orchestrator is evidently still using it.
	const choice = selectReapVictim([
		candidate({ id: "revisited", endedAt: NOW - 90 * MINUTE, lastEventAt: NOW - MINUTE }),
		candidate({ id: "forgotten", endedAt: NOW - 20 * MINUTE, lastEventAt: NOW - 20 * MINUTE }),
	]);
	assert.equal(choice.victim?.id, "forgotten");
});

test("running agents are skipped even when they are the stalest thing there", () => {
	const choice = selectReapVictim([
		candidate({ id: "ancient-runner", status: "running", busy: true, lastEventAt: 0, endedAt: undefined }),
		candidate({ id: "done", lastEventAt: NOW - MINUTE, endedAt: NOW - MINUTE }),
	]);
	assert.equal(choice.victim?.id, "done");
});

test("a hibernated agent can be reclaimed to make room", () => {
	const choice = selectReapVictim([
		candidate({ id: "asleep", status: "hibernated", hasProcess: false, lastEventAt: 0, endedAt: 0 }),
		candidate({ id: "done", lastEventAt: NOW, endedAt: NOW }),
	]);
	assert.equal(choice.victim?.id, "asleep");
});

test("closed agents are not candidates: they are already gone", () => {
	const choice = selectReapVictim([candidate({ id: "gone", status: "closed", lastEventAt: 0 })]);
	assert.equal(choice.victim, undefined);
});

test("ties break deterministically so the choice can be reasoned about", () => {
	const same = { lastEventAt: NOW - MINUTE, endedAt: NOW - MINUTE };
	const first = selectReapVictim([candidate({ id: "b", ...same }), candidate({ id: "a", ...same })]);
	const again = selectReapVictim([candidate({ id: "a", ...same }), candidate({ id: "b", ...same })]);
	assert.equal(first.victim?.id, "a");
	assert.equal(again.victim?.id, "a");
});

// --- nothing to reclaim ---------------------------------------------------

test("all slots busy: no victim, and the reason names what is in the way", () => {
	const choice = selectReapVictim([
		candidate({ id: "r1", status: "running", busy: true }),
		candidate({ id: "r2", status: "running", busy: true }),
		candidate({ id: "s1", status: "stalled", busy: true }),
		candidate({ id: "f1", status: "failed" }),
	]);
	assert.equal(choice.victim, undefined);
	const reason = (choice as { reason: string }).reason;
	assert.match(reason, /2 still running/);
	assert.match(reason, /1 stalled/);
	assert.match(reason, /1 failed/);
	// The reason has to be actionable, not just a count.
	assert.match(reason, /post-mortem/);
});

test("an empty roster yields no victim rather than throwing", () => {
	const choice = selectReapVictim([]);
	assert.equal(choice.victim, undefined);
	assert.equal(typeof (choice as { reason: string }).reason, "string");
});

// --- idle hibernation -----------------------------------------------------

test("the default idle threshold is half an hour", () => {
	assert.equal(DEFAULT_IDLE_HIBERNATE_MINUTES, 30);
});

test("a completed agent idle past the threshold hibernates", () => {
	const agent = candidate({ lastEventAt: NOW - 31 * MINUTE, endedAt: NOW - 31 * MINUTE });
	assert.equal(shouldIdleHibernate({ agent, now: NOW, idleHibernateMinutes: 30 }), true);
});

test("a completed agent touched recently is left alone", () => {
	const agent = candidate({ lastEventAt: NOW - 29 * MINUTE, endedAt: NOW - 29 * MINUTE });
	assert.equal(shouldIdleHibernate({ agent, now: NOW, idleHibernateMinutes: 30 }), false);
});

test("only completed agents hibernate on idleness", () => {
	const stale = { lastEventAt: 0, endedAt: 0 };
	for (const status of ["running", "starting", "stalled", "failed", "interrupted", "idle"]) {
		assert.equal(
			shouldIdleHibernate({
				agent: candidate({ status, ...stale }),
				now: NOW,
				idleHibernateMinutes: 30,
			}),
			false,
			status,
		);
	}
});

test("an agent with no process is already asleep", () => {
	const agent = candidate({ status: "hibernated", hasProcess: false, lastEventAt: 0, endedAt: 0 });
	assert.equal(shouldIdleHibernate({ agent, now: NOW, idleHibernateMinutes: 30 }), false);
});

test("a busy agent is not idle, however long ago it last spoke", () => {
	// This is the stall case, not the idle case: it must not be put to sleep.
	const agent = candidate({ status: "completed", busy: true, lastEventAt: 0, endedAt: 0 });
	assert.equal(shouldIdleHibernate({ agent, now: NOW, idleHibernateMinutes: 30 }), false);
});

test("idleHibernateMinutes 0 disables the sweep", () => {
	const agent = candidate({ lastEventAt: 0, endedAt: 0 });
	assert.equal(shouldIdleHibernate({ agent, now: NOW, idleHibernateMinutes: 0 }), false);
	assert.equal(shouldIdleHibernate({ agent, now: NOW, idleHibernateMinutes: -1 }), false);
});

test("the sweep selects every due agent and nothing else", () => {
	const due = selectIdleHibernations(
		[
			candidate({ id: "due-1", lastEventAt: NOW - 40 * MINUTE, endedAt: NOW - 40 * MINUTE }),
			candidate({ id: "fresh", lastEventAt: NOW - MINUTE, endedAt: NOW - MINUTE }),
			candidate({ id: "due-2", lastEventAt: NOW - 90 * MINUTE, endedAt: NOW - 90 * MINUTE }),
			candidate({ id: "running", status: "running", busy: true, lastEventAt: 0 }),
		],
		NOW,
		30,
	);
	assert.deepEqual(due.map((a) => a.id), ["due-1", "due-2"]);
});

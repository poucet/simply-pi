/**
 * Stall detection.
 *
 * The failure being modelled: the laptop's connection drops, a child's provider
 * call hangs or retries in backoff, and the process stays up producing nothing.
 * No exit, no settle — the only observable is elapsed silence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STALL_SECONDS, describeSilence, isStalled, stallTransition } from "../stall.ts";

const base = { busy: true, status: "running", stallSeconds: 120, now: 1_000_000 };

test("the default threshold is two minutes", () => {
	assert.equal(DEFAULT_STALL_SECONDS, 120);
});

test("a busy child that has been silent past the threshold is stalled", () => {
	assert.equal(isStalled({ ...base, lastEventAt: base.now - 120_000 }), true);
	assert.equal(isStalled({ ...base, lastEventAt: base.now - 600_000 }), true);
});

test("a busy child that spoke recently is not stalled", () => {
	assert.equal(isStalled({ ...base, lastEventAt: base.now - 119_999 }), false);
	assert.equal(isStalled({ ...base, lastEventAt: base.now }), false);
});

test("only a child that owes us something can stall", () => {
	const silent = base.now - 3_600_000;
	// Not busy: it is quiet because it has nothing to say.
	assert.equal(isStalled({ ...base, busy: false, lastEventAt: silent }), false);
	for (const status of ["completed", "failed", "interrupted", "hibernated", "closed", "idle"]) {
		assert.equal(isStalled({ ...base, status, lastEventAt: silent }), false, status);
	}
	// Starting counts: a child can hang before it produces its first event.
	assert.equal(isStalled({ ...base, status: "starting", lastEventAt: silent }), true);
});

test("a child that has never produced an event is not judged", () => {
	assert.equal(isStalled({ ...base, lastEventAt: undefined }), false);
});

test("stallSeconds 0 disables detection entirely", () => {
	assert.equal(isStalled({ ...base, stallSeconds: 0, lastEventAt: 0 }), false);
	assert.equal(isStalled({ ...base, stallSeconds: -1, lastEventAt: 0 }), false);
});

// --- transitions ----------------------------------------------------------

test("crossing the threshold reports a stall exactly once", () => {
	const silent = { ...base, lastEventAt: base.now - 200_000 };
	assert.equal(stallTransition(silent), "stalled");
	// Already labelled: the sweep must not re-notify every few seconds.
	assert.equal(stallTransition({ ...silent, status: "stalled" }), undefined);
});

test("events coming back put the agent back to running by itself", () => {
	assert.equal(
		stallTransition({ ...base, status: "stalled", lastEventAt: base.now - 1_000 }),
		"recovered",
	);
});

test("a stalled agent that settles is no longer stalled", () => {
	// busy=false is what agent_settled sets; the sweep must let go of it.
	assert.equal(
		stallTransition({ ...base, busy: false, status: "stalled", lastEventAt: base.now - 999_999 }),
		"recovered",
	);
});

test("a healthy running agent produces no transition", () => {
	assert.equal(stallTransition({ ...base, lastEventAt: base.now - 5_000 }), undefined);
});

// --- formatting -----------------------------------------------------------

test("describeSilence is short and human", () => {
	assert.equal(describeSilence(0), "0s");
	assert.equal(describeSilence(45_000), "45s");
	assert.equal(describeSilence(125_000), "2m05s");
	assert.equal(describeSilence(3_600_000 + 120_000), "1h02m");
	assert.equal(describeSilence(-5), "0s");
});

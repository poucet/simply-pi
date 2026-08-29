/**
 * The shared badge registry.
 *
 * Lives under `extensions/mcp/tests` because that is the suite wired up to a
 * runner; the module it tests is `extensions/shared/border-badges.ts` and has
 * nothing to do with MCP specifically.
 *
 * The properties worth testing here are all about the seam between two
 * extensions that cannot see each other: that they find the same store, that the
 * bar they build from it is stable, and that neither can break the other.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
	flatten,
	hasRenderer,
	publish,
	RECOMMENDED_TOKENS,
	resetForTests,
	setRenderer,
	snapshot,
	subscribe,
	type BadgeTone,
	type StatusBadge,
} from "../../shared/border-badges.ts";

const badge = (text: string, tone: BadgeTone = "neutral"): StatusBadge => ({ text, tone });

// The store deliberately outlives module reloads, which also means it outlives
// individual tests.
beforeEach(() => resetForTests());

test("a published group comes back", () => {
	publish("mcp", [badge("mcp", "label"), badge("2/2", "ok")]);
	assert.deepEqual(snapshot(), [{ source: "mcp", badges: [badge("mcp", "label"), badge("2/2", "ok")] }]);
});

test("groups are ordered by source, not by who published first", () => {
	// The order extensions settle in is decided by the network and the process
	// scheduler, so insertion order would reshuffle the bar between runs — and
	// live, as a slow server finally reports in.
	publish("telegram", [badge("on")]);
	publish("mcp", [badge("2/2", "ok")]);
	publish("subagents", [badge("1 running")]);
	assert.deepEqual(
		snapshot().map((group) => group.source),
		["mcp", "subagents", "telegram"],
	);

	// Same set, published in the opposite order: same bar.
	const first = snapshot();
	resetForTests();
	publish("subagents", [badge("1 running")]);
	publish("mcp", [badge("2/2", "ok")]);
	publish("telegram", [badge("on")]);
	assert.deepEqual(snapshot(), first);
});

test("publishing undefined withdraws that source and leaves the rest", () => {
	publish("mcp", [badge("2/2", "ok")]);
	publish("subagents", [badge("1 running")]);

	publish("mcp", undefined);
	assert.deepEqual(snapshot(), [{ source: "subagents", badges: [badge("1 running")] }]);

	// Withdrawing something that was never there is not an error.
	publish("never-published", undefined);
	assert.equal(snapshot().length, 1);
});

test("flatten gives the renderer one list in source order", () => {
	publish("subagents", [badge("subagents", "label"), badge("1 running", "pending")]);
	publish("mcp", [badge("mcp", "label"), badge("2/2", "ok")]);
	assert.deepEqual(
		flatten().map((b) => b.text),
		["mcp", "2/2", "subagents", "1 running"],
	);
});

test("subscribers are told when something changes, and can stop listening", () => {
	let calls = 0;
	const unsubscribe = subscribe(() => {
		calls += 1;
	});

	publish("mcp", [badge("2/2", "ok")]);
	assert.equal(calls, 1);

	publish("mcp", [badge("1/2", "pending")]);
	assert.equal(calls, 2);

	publish("mcp", undefined);
	assert.equal(calls, 3);

	unsubscribe();
	publish("mcp", [badge("2/2", "ok")]);
	assert.equal(calls, 3, "an unsubscribed listener was still called");
});

test("republishing the same badges notifies nobody", () => {
	// Publishers repaint on every state change and call this far more often than
	// anything actually differs; without this the editor border would redraw on
	// every heartbeat.
	let calls = 0;
	subscribe(() => {
		calls += 1;
	});

	publish("mcp", [badge("2/2", "ok")]);
	publish("mcp", [badge("2/2", "ok")]);
	publish("mcp", [badge("2/2", "ok")]);
	assert.equal(calls, 1);

	// A real change still gets through.
	publish("mcp", [badge("2/2", "ok"), badge("1 off", "muted")]);
	assert.equal(calls, 2);
	// Including one that only changes a tone.
	publish("mcp", [badge("2/2", "error"), badge("1 off", "muted")]);
	assert.equal(calls, 3);
});

test("a throwing subscriber breaks neither the publisher nor the other subscribers", () => {
	// The whole point of the registry is that two extensions who cannot see each
	// other share it. A renderer with a bug must not be able to take MCP down.
	const seen: string[] = [];
	subscribe(() => {
		seen.push("before");
	});
	subscribe(() => {
		throw new Error("renderer is broken");
	});
	subscribe(() => {
		seen.push("after");
	});

	assert.doesNotThrow(() => publish("mcp", [badge("2/2", "ok")]));
	assert.deepEqual(seen, ["before", "after"]);
	assert.equal(snapshot().length, 1, "the publish itself was lost");
});

test("a subscriber may unsubscribe while being notified", () => {
	// Notification iterates a copy for this reason; mutating the live set
	// mid-iteration would skip whoever came next.
	const seen: string[] = [];
	const stop = subscribe(() => {
		seen.push("first");
		stop();
	});
	subscribe(() => {
		seen.push("second");
	});

	publish("mcp", [badge("2/2", "ok")]);
	assert.deepEqual(seen, ["first", "second"]);

	publish("mcp", [badge("1/2", "pending")]);
	assert.deepEqual(seen, ["first", "second", "second"]);
});

test("the publisher's own array cannot mutate what the renderer will draw", () => {
	const mine: StatusBadge[] = [badge("2/2", "ok")];
	publish("mcp", mine);
	mine.push(badge("injected", "error"));
	mine[0]!.text = "tampered";

	assert.deepEqual(snapshot(), [{ source: "mcp", badges: [badge("2/2", "ok")] }]);
});

test("the store lives on globalThis, so separate module instances share it", () => {
	// This is the property the whole design rests on: extensions are loaded
	// through jiti with `moduleCache: false`, so mcp and the extension owning the
	// editor are *not* handed the same instance of this module. A module-scoped
	// singleton would give each of them a private empty registry and the bar
	// would silently stay blank.
	publish("mcp", [badge("2/2", "ok")]);

	const store = (globalThis as unknown as Record<symbol, { entries: Map<string, StatusBadge[]> }>)[
		Symbol.for("pi.border-badges")
	];
	assert.ok(store, "nothing was stored under Symbol.for(\"pi.border-badges\")");
	assert.deepEqual(store.entries.get("mcp"), [badge("2/2", "ok")]);

	// And reads go back through globalThis rather than through a module-local
	// cache: what another instance writes, this instance sees.
	store.entries.set("other-instance", [badge("written elsewhere")]);
	assert.deepEqual(
		snapshot().map((group) => group.source),
		["mcp", "other-instance"],
	);
});

test("a reload reuses the existing store instead of orphaning its badges", () => {
	// `/reload` re-imports every extension, but not necessarily at the same
	// moment. A publisher that has reloaded and a renderer that has not still
	// have to be talking to each other afterwards.
	publish("mcp", [badge("2/2", "ok")]);
	let notified = 0;
	subscribe(() => {
		notified += 1;
	});

	const key = Symbol.for("pi.border-badges");
	const before = (globalThis as unknown as Record<symbol, unknown>)[key];

	// Whatever a re-imported copy of the module does on first use, it must find
	// this store rather than install a new one.
	publish("subagents", [badge("1 running")]);
	assert.equal((globalThis as unknown as Record<symbol, unknown>)[key], before, "the store was replaced");
	assert.equal(notified, 1, "a subscriber registered before the reload stopped being notified");
	assert.equal(snapshot().length, 2);
});

test("a foreign object left under the key is replaced rather than trusted", () => {
	// The other half of the reload story: an object left by an older,
	// incompatible version of this module. Trusting it would throw somewhere far
	// less obvious than here.
	const key = Symbol.for("pi.border-badges");
	(globalThis as unknown as Record<symbol, unknown>)[key] = { entries: "not a map", legacy: true };

	assert.doesNotThrow(() => publish("mcp", [badge("2/2", "ok")]));
	assert.deepEqual(snapshot(), [{ source: "mcp", badges: [badge("2/2", "ok")] }]);
});

test("every tone has a recommended token pair, so the two renderers cannot diverge", () => {
	const tones: BadgeTone[] = ["label", "ok", "pending", "error", "warn", "neutral", "muted"];
	for (const tone of tones) {
		assert.ok(RECOMMENDED_TOKENS[tone], `no recommendation for tone "${tone}"`);
		assert.ok(RECOMMENDED_TOKENS[tone].bg, `tone "${tone}" has no background`);
		assert.ok(RECOMMENDED_TOKENS[tone].fg, `tone "${tone}" has no foreground`);
	}
	assert.deepEqual(Object.keys(RECOMMENDED_TOKENS).sort(), [...tones].sort());

	// `muted` is a distinct tone precisely because it should not look like
	// `neutral`: one is information to read, the other information to skip.
	assert.notDeepEqual(RECOMMENDED_TOKENS.muted, RECOMMENDED_TOKENS.neutral);
	// Same for the pair that is easiest to collapse by accident.
	assert.notDeepEqual(RECOMMENDED_TOKENS.warn, RECOMMENDED_TOKENS.error);
});

// --- renderer presence -----------------------------------------------------

test("nobody is rendering until somebody says so", () => {
	assert.equal(hasRenderer(), false);
	setRenderer(true);
	assert.equal(hasRenderer(), true);
	setRenderer(false);
	assert.equal(hasRenderer(), false);
});

test("presence is counted, so a reload's overlap does not switch the bar off", () => {
	// Across a `/reload` pi can construct the incoming editor before the outgoing
	// one is told to let go. With a boolean the *old* instance's teardown runs
	// last and wins, and every publisher then believes forever that nothing is
	// drawing their badges — the exact failure this counter exists to prevent.
	setRenderer(true); // the editor that is already there
	setRenderer(true); // its replacement, constructed first
	setRenderer(false); // the original, released second
	assert.equal(hasRenderer(), true, "the surviving renderer was voted away by its predecessor");
	setRenderer(false);
	assert.equal(hasRenderer(), false);
});

test("presence never goes negative", () => {
	// A stray release must not put the count into debt, or the next renderer to
	// attach would announce itself and still be invisible.
	setRenderer(false);
	setRenderer(false);
	setRenderer(true);
	assert.equal(hasRenderer(), true);
});

test("a renderer arriving or leaving wakes the publishers", () => {
	// The window this closes: extension load order is arbitrary, so a publisher
	// routinely writes its own status line before the editor has mounted. Without
	// a notification the duplicate stays on screen until a server happens to
	// change state, which for a healthy install is never.
	let woken = 0;
	subscribe(() => woken++);

	setRenderer(true);
	assert.equal(woken, 1);
	setRenderer(false);
	assert.equal(woken, 2);
});

test("a second renderer is not a change worth waking anybody for", () => {
	// Only the transition matters — `hasRenderer()` reads the same either way, and
	// a publisher repainting for a no-op is work nobody asked for.
	setRenderer(true);
	let woken = 0;
	subscribe(() => woken++);
	setRenderer(true);
	assert.equal(woken, 0);
	setRenderer(false);
	assert.equal(woken, 0, "one of two renderers leaving is not a change");
	setRenderer(false);
	assert.equal(woken, 1);
});

test("a store from an older version gains a renderer count instead of being dropped", () => {
	// The shape check must not treat "written before this field existed" as
	// "foreign": replacing the store would silently discard the badges of every
	// publisher that has not reloaded yet, and they have no reason to republish.
	publish("mcp", [badge("mcp", "label")]);
	const key = Symbol.for("pi.border-badges");
	const existing = (globalThis as any)[key];
	delete existing.renderers;

	assert.equal(hasRenderer(), false);
	assert.deepEqual(snapshot(), [{ source: "mcp", badges: [badge("mcp", "label")] }]);
	setRenderer(true);
	assert.equal(hasRenderer(), true);
});

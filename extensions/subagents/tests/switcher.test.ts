import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAIN_ENTRY_ID,
	type StripTheme,
	SwitcherStrip,
	classifyStripKey,
	isPrintable,
	renderStrip,
	shouldEnterStrip,
	stepIndex,
	stripEntries,
} from "../switcher.ts";
import type { ChatHost, ManagedAgent } from "../types.ts";

/** Raw sequences a terminal actually sends, so the classifier is tested honestly. */
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
};

const plainTheme: StripTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => `[${text}]`,
	bold: (text) => text,
};

function host(names: string[], unread: Record<string, number> = {}): ChatHost {
	const agents = names.map((name) => ({ id: `id-${name}`, name }) as ManagedAgent);
	return {
		agents: () => agents,
		unread: (agentId) => unread[agentId] ?? 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async () => {},
	};
}

test("the strip always offers the main chat first", () => {
	const entries = stripEntries(host(["a", "b"]));
	assert.deepEqual(
		entries.map((entry) => entry.id),
		[MAIN_ENTRY_ID, "id-a", "id-b"],
	);
	assert.equal(entries[0]!.label, "main");
});

test("unread counts reach the strip", () => {
	const entries = stripEntries(host(["a"], { "id-a": 2 }));
	assert.equal(entries[1]!.unread, 2);
});

test("selection wraps in both directions", () => {
	assert.equal(stepIndex(0, 1, 3), 1);
	assert.equal(stepIndex(2, 1, 3), 0);
	assert.equal(stepIndex(0, -1, 3), 2);
	// Degenerate strips must not produce NaN or -1 indices.
	assert.equal(stepIndex(0, 1, 0), 0);
	assert.equal(stepIndex(5, -7, 3), 1);
});

test("down only enters the strip from an empty buffer", () => {
	const base = { autocompleteOpen: false, agentCount: 1 };
	assert.equal(shouldEnterStrip({ ...base, text: "" }), true);
	// Non-empty: down is cursor-down / newer history and must stay that way.
	assert.equal(shouldEnterStrip({ ...base, text: "h" }), false);
	assert.equal(shouldEnterStrip({ ...base, text: "two\nlines" }), false);
	// A space is text.
	assert.equal(shouldEnterStrip({ ...base, text: " " }), false);
});

test("down does not enter the strip when it would be invisible or in the way", () => {
	assert.equal(shouldEnterStrip({ text: "", autocompleteOpen: false, agentCount: 0 }), false);
	assert.equal(shouldEnterStrip({ text: "", autocompleteOpen: true, agentCount: 2 }), false);
});

test("strip keys are classified from raw terminal input", () => {
	assert.equal(classifyStripKey(KEYS.left), "previous");
	assert.equal(classifyStripKey(KEYS.shiftTab), "previous");
	assert.equal(classifyStripKey(KEYS.right), "next");
	assert.equal(classifyStripKey(KEYS.tab), "next");
	assert.equal(classifyStripKey(KEYS.enter), "activate");
	assert.equal(classifyStripKey(KEYS.escape), "leave");
	assert.equal(classifyStripKey(KEYS.up), "leave");
	assert.equal(classifyStripKey(KEYS.down), "ignore");
	assert.equal(classifyStripKey("x"), "insert");
	assert.equal(classifyStripKey("héllo"), "insert");
	assert.equal(classifyStripKey("\x03"), "ignore");
});

test("printable means text a human typed", () => {
	assert.equal(isPrintable("a"), true);
	assert.equal(isPrintable(" "), true);
	assert.equal(isPrintable(""), false);
	assert.equal(isPrintable("\t"), false);
	assert.equal(isPrintable("\r"), false);
	assert.equal(isPrintable("\x1b[B"), false);
});

test("the selected entry is highlighted, and only when focused", () => {
	const entries = stripEntries(host(["a"]));
	assert.match(renderStrip(entries, 0, true, plainTheme), /\[ ● main \]/);
	assert.doesNotMatch(renderStrip(entries, 0, false, plainTheme), /\[/);
	assert.match(renderStrip(entries, 1, true, plainTheme), /\[ ◐ a \]/);
});

test("unread agents carry their marker into the strip", () => {
	const entries = stripEntries(host(["a"], { "id-a": 1 }));
	assert.match(renderStrip(entries, 0, false, plainTheme), /◐ a●/);
});

function strip(names: string[], current?: () => string) {
	const opened: string[] = [];
	let renders = 0;
	const instance = new SwitcherStrip(host(names), {
		requestRender: () => {
			renders += 1;
		},
		open: (entryId) => opened.push(entryId),
		current,
	});
	return { instance, opened, renders: () => renders };
}

test("arrows move the selection and wrap around the whole strip", () => {
	const { instance } = strip(["a", "b"]);
	instance.focus();
	assert.equal(instance.selected, 0);
	instance.moveBy(1);
	assert.equal(instance.selected, 1);
	instance.moveBy(1);
	assert.equal(instance.selected, 2);
	instance.moveBy(1);
	assert.equal(instance.selected, 0);
	instance.moveBy(-1);
	assert.equal(instance.selected, 2);
});

test("enter opens the highlighted chat and returns the keyboard", () => {
	const { instance, opened } = strip(["a", "b"]);
	instance.focus();
	instance.handleKey(KEYS.right);
	instance.handleKey(KEYS.enter);
	assert.deepEqual(opened, ["id-a"]);
	assert.equal(instance.focused, false);
});

test("escape and up return to the input without opening anything", () => {
	for (const key of [KEYS.escape, KEYS.up]) {
		const { instance, opened } = strip(["a"]);
		instance.focus();
		instance.handleKey(KEYS.right);
		assert.equal(instance.handleKey(key), "consumed");
		assert.equal(instance.focused, false);
		assert.deepEqual(opened, []);
	}
});

test("typing leaves the strip and hands the character to the editor", () => {
	const { instance, opened } = strip(["a"]);
	instance.focus();
	assert.equal(instance.handleKey("h"), "passThrough");
	assert.equal(instance.focused, false);
	assert.deepEqual(opened, []);
});

test("app keys are never swallowed by a focused strip", () => {
	const { instance } = strip(["a"]);
	instance.focus();
	// ctrl+c and ctrl+d must still reach the app's own handlers.
	assert.equal(instance.handleKey("\x03"), "passThrough");
	assert.equal(instance.handleKey("\x04"), "passThrough");
	// ...without dropping the cursor out of the strip.
	assert.equal(instance.focused, true);
});

test("leaving the strip forgets where the cursor was", () => {
	const { instance } = strip(["a", "b"]);
	instance.focus();
	instance.moveBy(2);
	assert.equal(instance.selected, 2);
	instance.blur();
	instance.focus();
	assert.equal(instance.selected, 0);
});

test("an unfocused strip highlights the chat that is on screen", () => {
	const { instance } = strip(["a", "b"], () => "id-b");
	assert.equal(instance.focused, false);
	assert.equal(instance.selected, 2);
	// Focusing starts from there rather than jumping home.
	instance.focus();
	assert.equal(instance.selected, 2);
});

test("cycling steps from the chat on screen without taking focus", () => {
	const { instance, opened } = strip(["a", "b"], () => "id-a");
	instance.cycle(1);
	assert.deepEqual(opened, ["id-b"]);
	assert.equal(instance.focused, false);
});

test("cycling off either end lands on the main chat", () => {
	const first = strip(["a", "b"], () => "id-a");
	first.instance.cycle(-1);
	assert.deepEqual(first.opened, [MAIN_ENTRY_ID]);

	const last = strip(["a", "b"], () => "id-b");
	last.instance.cycle(1);
	assert.deepEqual(last.opened, [MAIN_ENTRY_ID]);
});

test("a selection whose agent disappeared falls back to the main chat", () => {
	const agents: ManagedAgent[] = [{ id: "id-a", name: "a" } as ManagedAgent];
	const instance = new SwitcherStrip(
		{
			agents: () => agents,
			unread: () => 0,
			statusIcon: () => "◐",
			subscribe: () => () => {},
			send: async () => {},
		},
		{ requestRender: () => {}, open: () => {} },
	);
	instance.focus();
	instance.moveBy(1);
	assert.equal(instance.selected, 1);
	agents.length = 0; // the agent was closed while the strip was open
	assert.equal(instance.selected, 0);
});

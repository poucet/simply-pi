import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { hasRenderer, publish, resetForTests } from "../../shared/border-badges.ts";
import { SubagentsEditor } from "../editor.ts";
import { MAIN_ENTRY_ID, SwitcherStrip } from "../switcher.ts";
import type { ChatHost, ManagedAgent } from "../types.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const ENTER = "\r";

/** Enough TUI for the editor's text handling; nothing here draws. */
function harness(agentNames: string[]) {
	const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
	const theme: any = { borderColor: (text: string) => text, selectList: {} };
	const keybindings: any = { matches: () => false };
	const agents = agentNames.map((name) => ({ id: `id-${name}`, name }) as ManagedAgent);
	const host: ChatHost = {
		agents: () => agents,
		unread: () => 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async () => {},
	};
	const opened: string[] = [];
	const strip = new SwitcherStrip(host, {
		requestRender: () => {},
		open: (entryId) => opened.push(entryId),
	});
	const editor = new SubagentsEditor(tui, theme, keybindings, strip, () => agents.length);
	return { editor, strip, opened, agents };
}

test("down on an empty buffer moves into the strip", () => {
	const { editor, strip } = harness(["a"]);
	editor.handleInput(DOWN);
	assert.equal(strip.focused, true);
	assert.equal(editor.getText(), "");
});

test("down with text in the buffer is left alone", () => {
	const { editor, strip } = harness(["a"]);
	editor.handleInput("h");
	editor.handleInput(DOWN);
	assert.equal(strip.focused, false);
	assert.equal(editor.getText(), "h");
});

test("history browsing still works through the wrapper", () => {
	const { editor, strip } = harness(["a"]);
	editor.addToHistory("older prompt");
	editor.handleInput(UP);
	assert.equal(editor.getText(), "older prompt");
	// The buffer is not empty any more, so down is history-forward, not the strip.
	editor.handleInput(DOWN);
	assert.equal(strip.focused, false);
	assert.equal(editor.getText(), "");
});

test("down does nothing special when there are no subagents", () => {
	const { editor, strip } = harness([]);
	editor.handleInput(DOWN);
	assert.equal(strip.focused, false);
});

test("the strip consumes navigation while it has focus", () => {
	const { editor, strip, opened } = harness(["a", "b"]);
	editor.handleInput(DOWN);
	editor.handleInput(RIGHT);
	editor.handleInput(ENTER);
	assert.deepEqual(opened, ["id-a"]);
	assert.equal(strip.focused, false);
	// Enter reached the strip, not the editor: nothing was submitted.
	assert.equal(editor.getText(), "");
});

test("enter on the main entry just returns to the input", () => {
	const { editor, strip, opened } = harness(["a"]);
	editor.handleInput(DOWN);
	editor.handleInput(ENTER);
	assert.deepEqual(opened, [MAIN_ENTRY_ID]);
	assert.equal(strip.focused, false);
});

test("typing while the strip has focus types into the editor", () => {
	const { editor, strip } = harness(["a"]);
	editor.handleInput(DOWN);
	editor.handleInput("h");
	editor.handleInput("i");
	assert.equal(strip.focused, false);
	assert.equal(editor.getText(), "hi");
});

test("a broken strip can never break the input box", () => {
	const { editor, strip } = harness(["a"]);
	editor.handleInput(DOWN);
	assert.equal(strip.focused, true);
	(strip as unknown as { handleKey(): never }).handleKey = () => {
		throw new Error("boom");
	};
	editor.handleInput("x");
	assert.equal(editor.getText(), "x");
	assert.equal(strip.focused, false);
});

// --- the badge bar ---------------------------------------------------------
//
// Driven through the **real** `Editor.render` rather than a fake of its output.
// The whole mechanism rests on three facts about pi-tui internals — that a
// border is `borderColor("─").repeat(width)`, that a scroll indicator replaces
// one, and that the indicator's exact text is `─── ↑ 3 more ` — and a
// hand-rolled fixture would keep passing after any of those changed, which is
// precisely the failure it needs to catch.

/** Visible width, ignoring escape sequences, the way the terminal counts. */
const columns = (line: string): number => visibleWidth(line);

/** A theme that paints, with the surface `SubagentsEditor` asks pi's Theme for. */
function paintingTheme() {
	return {
		fg: (_token: string, text: string) => `\x1b[38;5;1m${text}\x1b[39m`,
		bg: (_token: string, text: string) => `\x1b[48;5;2m${text}\x1b[49m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
}

/** An editor wired to the real base class, with a theme of the caller's choosing. */
function barHarness(badgeTheme?: () => any, borderColor?: (text: string) => string) {
	const rendered: number[] = [];
	const tui: any = {
		requestRender() {
			rendered.push(Date.now());
		},
		terminal: { rows: 24, columns: 80 },
	};
	// `borderColor` as identity keeps the border a plain run of `─`, so the
	// assertions below are about layout rather than about escape codes. The
	// painted cases are covered separately.
	const theme: any = { borderColor: borderColor ?? ((text: string) => text), selectList: {} };
	const host: ChatHost = {
		agents: () => [],
		unread: () => 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async () => {},
	};
	const strip = new SwitcherStrip(host, { requestRender: () => {}, open: () => {} });
	const editor = new SubagentsEditor(
		tui,
		theme,
		{ matches: () => false } as any,
		strip,
		() => 0,
		badgeTheme ?? (() => undefined),
	);
	return { editor, renders: () => rendered.length, dispose: () => editor.dispose() };
}

/** Walk the cursor to the very top, so the *bottom* border scrolls. */
function cursorToTop(editor: SubagentsEditor): void {
	for (let i = 0; i < 60; i++) editor.handleInput(UP);
}

test("with nothing published the border is pi's own, untouched", (t) => {
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	const lines = h.editor.render(60);
	assert.equal(lines[0], "─".repeat(60));
});

test("published badges land in the top border at exactly the border's width", (t) => {
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [
		{ text: "mcp", tone: "label" },
		{ text: "3/4", tone: "ok" },
	]);
	const lines = h.editor.render(60);
	assert.equal(lines[0], "────────────────────────────────────────────── mcp · 3/4 ───");
	assert.equal(columns(lines[0]!), 60, "the border stopped being exactly one line wide");
	// Only the top border. The bottom rule and the text line are the base class's.
	assert.equal(lines.at(-1), "─".repeat(60));
	assert.equal(lines.length, 3);
});

test("the bar is drawn above the text, not over it", (t) => {
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	h.editor.setText("hello world");
	const lines = h.editor.render(60);
	assert.match(lines[1]!, /hello world/);
	assert.match(lines[0]!, /^─+ mcp ───$/);
});

test("a scrolled bottom border is not a collision: the bar still draws", (t) => {
	// Only one of the two borders can hold an indicator at a time, and the bar only
	// ever wants the top one — so this case is not even a near miss.
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	h.editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
	h.editor.render(60); // establish the scroll state before moving the cursor
	cursorToTop(h.editor);

	const lines = h.editor.render(60);
	assert.match(lines.at(-1)!, /↓ \d+ more/, "expected the bottom border to be scrolled");
	assert.match(lines[0]!, /^─+ mcp ───$/);
	assert.equal(columns(lines[0]!), 60);
});

test("a scrolled top border keeps its indicator and its badges", (t) => {
	// The collision that used to suppress the bar. "3 more" is the only sign the
	// user's own text continues above the fold, and it is anchored hard left; the
	// badges are anchored hard right, so both fit and neither is a trade.
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	// `setText` leaves the cursor at the end, so the first render is already
	// scrolled: everything above the last few lines is hidden.
	h.editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));

	const first = h.editor.render(60)[0]!;
	assert.match(first, /^─── ↑ \d+ more ─+ mcp ───$/, `indicator and badges did not share the line: ${first}`);
	assert.equal(columns(first), 60, "the shared border stopped being exactly one line wide");
});

test("no room beside the indicator and the indicator keeps the whole line", (t) => {
	// The bail-out that has to survive: a border too narrow for both is the
	// indicator's, untouched. Losing "3 more" is worse than losing badges.
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	h.editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));

	const first = h.editor.render(24)[0]!;
	assert.match(first, /↑ \d+ more/, "expected the top border to be scrolled");
	assert.ok(!first.includes("mcp"), "the bar crowded the scroll indicator");
	assert.equal(columns(first), 24);
});

test("a themed scroll indicator is re-painted, never sliced", (t) => {
	// The case the whole `lead` design exists for. pi paints the indicator with one
	// `borderColor` call, so preserving it by cutting the rendered string at a
	// column boundary would mean cutting inside an escape sequence — which produces
	// a line that measures right and draws as garbage. Instead the plain text is
	// recovered, and the same `borderColor` is applied to it again.
	resetForTests();
	const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
	const h = barHarness(undefined, dim);
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	h.editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));

	const first = h.editor.render(60)[0]!;
	assert.equal(columns(first), 60, "escape sequences were counted as columns");
	assert.ok(first.length > 60, "expected the border to carry escape sequences");
	// Every escape in the line is a complete one: no `\x1b[` left dangling, and no
	// stray fragment of `2m`/`22m` loose in the text.
	assert.match(stripTerminalSequences(first), /^─── ↑ \d+ more ─+ mcp ───$/);
	// …and the indicator is still themed as one whole run, rather than having been
	// re-emitted bare or cut halfway through its opening sequence.
	assert.match(first, /^\x1b\[2m─── ↑ \d+ more \x1b\[22m/, `the indicator lost its colour: ${JSON.stringify(first)}`);
});

test("a painted theme produces coloured chips of the right visible width", (t) => {
	resetForTests();
	const h = barHarness(() => paintingTheme());
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [
		{ text: "mcp", tone: "label" },
		{ text: "1 failed", tone: "error" },
	]);
	const first = h.editor.render(60)[0]!;
	assert.equal(columns(first), 60, "escape sequences were counted as columns");
	assert.ok(first.length > 60, "expected the line to carry escape sequences");
	// The chips are there, each padded inside its own background.
	// Bold inside, padding outside, colour around the lot — the same nesting
	// `extensions/mcp` uses, so one badge cannot drift away from the other.
	assert.match(first, /\x1b\[48;5;2m\x1b\[38;5;1m \x1b\[1mmcp\x1b\[22m \x1b\[39m/);
	assert.match(first, / 1 failed /);
});

test("publishing repaints, and a disposed editor stops asking", (t) => {
	// The repaint mechanism: `subscribe` → `tui.requestRender()`. Not a timer —
	// badges change when servers change, which is rare and unpredictable.
	resetForTests();
	const h = barHarness();
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	const before = h.renders();
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	assert.equal(h.renders(), before + 1, "a publish did not ask for a repaint");

	// Republishing the same badges changes nothing, so it must not repaint —
	// otherwise a chatty publisher redraws the editor on every heartbeat.
	publish("mcp", [{ text: "mcp", tone: "label" }]);
	assert.equal(h.renders(), before + 1, "an unchanged republish repainted anyway");

	h.dispose();
	publish("mcp", [{ text: "mcp", tone: "ok" }]);
	assert.equal(h.renders(), before + 1, "a disposed editor is still asking a dead TUI to draw");
});

test("mounting announces a renderer and disposing takes it back, once", (t) => {
	// What publishers read to decide whether they still need their own status
	// line. `dispose` must be idempotent: `index.ts` calls it both when a
	// replacement is created and at shutdown, and a double decrement would vote
	// away a peer that is genuinely still drawing.
	resetForTests();
	t.after(() => resetForTests());
	assert.equal(hasRenderer(), false);

	const h = barHarness();
	assert.equal(hasRenderer(), true);
	h.dispose();
	assert.equal(hasRenderer(), false);

	const other = barHarness();
	h.dispose(); // the already-disposed one must not speak again
	assert.equal(hasRenderer(), true, "a second dispose voted away a live renderer");
	other.dispose();
	assert.equal(hasRenderer(), false);
});

test("a badge that throws costs the bar, never the input box", (t) => {
	// A theme missing one of the tokens is the realistic case. The editor must
	// still hand back a usable frame.
	resetForTests();
	const exploding = {
		fg: (_t: string, s: string) => `\x1b[1m${s}\x1b[0m`,
		bg: () => {
			throw new Error("no such token");
		},
		bold: (s: string) => s,
	};
	const h = barHarness(() => exploding as any);
	t.after(() => {
		h.dispose();
		resetForTests();
	});
	publish("mcp", [{ text: "mcp", tone: "label" }]);

	const lines = h.editor.render(60);
	assert.equal(lines.length, 3);
	assert.equal(columns(lines[0]!), 60);
	// The facts survive; only the colour is lost.
	assert.match(lines[0]!, /mcp/);
});

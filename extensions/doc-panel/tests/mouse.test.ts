/**
 * The mouse moving keyboard focus between the doc panel and the chat, against
 * pi-tui's real fullscreen renderer, its real editor and the real panel. The
 * terminal's mouse reports are fed in as bytes, the way pi-tui reads them, so
 * these tests hold pi-tui to what the panel relies on: a click reaches a
 * non-capturing overlay, `focus: true` focuses it, and a press in the chat
 * reaches the split's root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type MarkdownTheme, ScrollView, stripTerminalSequences, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { DocPanel } from "../panel.ts";
import { installSplit, panelWidth } from "../split.ts";

const identity = (text: string) => text;
const plainTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: identity } as unknown as Theme;
const plainMarkdown = new Proxy({}, { get: () => identity }) as MarkdownTheme;
const editorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

const COLUMNS = 100;
const ROWS = 12;

function fakeTerminal(): any {
	const noop = () => {};
	return {
		columns: COLUMNS,
		rows: ROWS,
		write: noop,
		start: noop,
		stop: noop,
		hideCursor: noop,
		showCursor: noop,
		setProgress: noop,
		clear: noop,
		on: noop,
		off: noop,
	};
}

/** SGR mouse reports, 0-based cell; the terminal counts from 1. */
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const wheelDown = (x: number, y: number) => `\x1b[<65;${x + 1};${y + 1}M`;

/**
 * pi's fullscreen chat (a transcript above the editor, the editor focused) with
 * the doc panel shown beside it, wired the way the controller wires it.
 */
function harness(docs: string[] = ["A.md"]) {
	const tui: any = new (TuiAltScreen as any)(fakeTerminal());
	const lines = Array.from({ length: 40 }, (_, i) => `chat ${i}`);
	const transcript = new ScrollView({ render: () => lines, invalidate() {} }, { follow: "end", primary: true });
	const editor = new Editor(tui, editorTheme);
	tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, editor]));
	tui.altScreenActive = true; // what start() sets, without a real terminal
	tui.setFocus(editor);

	let handle: any;
	const panel = new DocPanel({
		theme: plainTheme,
		markdownTheme: () => plainMarkdown,
		rows: () => ROWS,
		isFocused: () => handle.isFocused(),
		unfocus: () => handle.unfocus(),
		hide: () => handle.setHidden(true),
		closeTab: () => {},
		requestRender: () => {},
		keys: { cycle: "ctrl+]" },
	});
	const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n");
	for (const name of docs) panel.open(`/d/${name}`, name, body);
	panel.select(0);
	handle = tui.showOverlay(panel, {
		anchor: "right-center",
		width: panelWidth(COLUMNS),
		maxHeight: "100%",
		nonCapturing: true,
	});
	installSplit(tui, (w) => (handle.isHidden() ? 0 : panelWidth(w)), {
		onChatPress: () => handle.isFocused() && handle.unfocus(),
	});

	/** Draw a frame (pi-tui hit-tests against the last one), then feed `data`. */
	const input = (...data: string[]) => {
		for (const d of data) {
			tui.doRender();
			tui.handleTerminalInput(d);
		}
	};
	const click = (x: number, y: number) => input(press(x, y), release(x, y));
	const panelX = COLUMNS - panelWidth(COLUMNS) + 10;
	// The editor's top border: the first rule in the chat's columns.
	const editorRow = () =>
		(tui.getScreenLines() as string[]).findIndex((l) =>
			stripTerminalSequences(l).slice(0, COLUMNS - panelWidth(COLUMNS)).includes("─"),
		);
	return { tui, editor, panel, handle, input, click, panelX, editorRow };
}

test("a click on the shown panel gives it the keyboard; keys then scroll it, not the editor", () => {
	const { handle, editor, panel, click, input, panelX } = harness();
	assert.equal(handle.isFocused(), false, "shown, not focused");
	click(panelX, 5);
	assert.equal(handle.isFocused(), true, "pi-tui focuses a non-capturing overlay that answers focus: true");
	assert.equal(editor.focused, false);
	const before = panel.render(panelWidth(COLUMNS)).join("\n");
	input("j");
	assert.notEqual(panel.render(panelWidth(COLUMNS)).join("\n"), before, "j scrolled the panel");
	assert.equal(editor.getText(), "", "and never reached the editor");
});

test("a click in the transcript while the panel is focused hands the keyboard back, for good", () => {
	const { handle, editor, click, input, panelX } = harness();
	click(panelX, 5);
	assert.equal(handle.isFocused(), true);
	click(5, 2);
	assert.equal(handle.isFocused(), false, "the panel let go");
	assert.equal(editor.focused, true, "the editor has the keyboard");
	assert.equal(handle.isHidden(), false, "and the panel stays shown");
	input("a");
	assert.equal(editor.getText(), "a", "the next key goes to the editor; focus does not bounce back");
	assert.equal(handle.isFocused(), false);
});

test("a click on the editor while the panel is focused hands the keyboard back, for good", () => {
	const { tui, handle, editor, click, input, panelX, editorRow } = harness();
	click(panelX, 5);
	tui.doRender();
	const row = editorRow() + 1; // the editor's text line
	assert.ok(row > 0, "found the editor");
	click(5, row);
	assert.equal(handle.isFocused(), false);
	input("b");
	assert.equal(editor.getText(), "b", "pi-tui would otherwise hand focus back to the panel on this key");
	assert.equal(handle.isFocused(), false);
});

test("a click in the chat while the panel is not focused changes nothing", () => {
	const { handle, editor, click, input } = harness();
	click(5, 2);
	assert.equal(handle.isFocused(), false);
	input("c");
	assert.equal(editor.getText(), "c");
});

test("the wheel scrolls the panel without taking the keyboard", () => {
	const { handle, panel, input, panelX } = harness();
	const before = panel.render(panelWidth(COLUMNS)).join("\n");
	input(wheelDown(panelX, 5));
	assert.notEqual(panel.render(panelWidth(COLUMNS)).join("\n"), before);
	assert.equal(handle.isFocused(), false);
});

test("a click on a tab's name in the panel's top border switches to it and focuses the panel", () => {
	const { handle, panel, click } = harness(["A.md", "B.md", "C.md"]);
	const left = COLUMNS - panelWidth(COLUMNS);
	// "╭─  A.md  B.md  C.md ─…": the strip starts at column 3, each name padded by a space.
	click(left + 3 + 6 + 2, 0);
	assert.equal(panel.currentIndex, 1, "B.md");
	assert.equal(handle.isFocused(), true);
	click(left + 3 + 12 + 2, 0);
	assert.equal(panel.currentIndex, 2, "C.md");
	click(left + 40, 0);
	assert.equal(panel.currentIndex, 2, "the border past the tabs only focuses");
});

test("a drag across the panel selects text rather than focusing it", () => {
	const { handle, input, panelX } = harness();
	input(press(panelX, 4), `\x1b[<32;${panelX + 6};5M`, release(panelX + 5, 4));
	assert.equal(handle.isFocused(), false, "only a press released where it started is a click");
});

// --- selection stays in the pane the drag started in ------------------------

const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;

/**
 * The harness above, plus what the controller adds for selection: the panel
 * copies into `copied`, and the split masks the panel's overlay around pi's
 * `hasOverlay()`. Chat and doc lines are told apart by their words.
 */
function selectionHarness(docs: string[] = ["A.md"]) {
	const tui: any = new (TuiAltScreen as any)(fakeTerminal());
	const lines = Array.from({ length: 40 }, (_, i) => `chat ${i} ${"c".repeat(40)}`);
	const transcript = new ScrollView({ render: () => lines, invalidate() {} }, { follow: "end", primary: true });
	const editor = new Editor(tui, editorTheme);
	tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, editor]));
	tui.altScreenActive = true;
	tui.setFocus(editor);

	let handle: any;
	let masked = false;
	const copied: string[] = [];
	const panel = new DocPanel({
		theme: plainTheme,
		markdownTheme: () => plainMarkdown,
		rows: () => ROWS,
		isFocused: () => handle.isFocused(),
		unfocus: () => handle.unfocus(),
		hide: () => handle.setHidden(true),
		closeTab: () => {},
		requestRender: () => {},
		keys: { cycle: "ctrl+]" },
		copy: (text) => copied.push(text),
	});
	for (const name of docs) {
		const body = Array.from({ length: 60 }, (_, i) => `${name} doc ${i}`).join("\n\n");
		panel.open(`/d/${name}`, name, body);
	}
	panel.select(0);
	handle = tui.showOverlay(panel, {
		anchor: "right-center",
		width: panelWidth(COLUMNS),
		maxHeight: "100%",
		nonCapturing: true,
		visible: () => !masked,
	});
	const split = installSplit(tui, (w) => (handle.isHidden() ? 0 : panelWidth(w)), {
		onChatPress: () => handle.isFocused() && handle.unfocus(),
		maskPane: (m) => {
			masked = m;
		},
	});
	const input = (...data: string[]) => {
		for (const d of data) {
			tui.doRender();
			tui.handleTerminalInput(d);
		}
	};
	const left = COLUMNS - panelWidth(COLUMNS);
	/** pi's own selection, as it would copy it. */
	const piSelection = (): string | undefined => tui.getActiveSelectionText();
	return { tui, panel, handle, split, input, left, copied, piSelection };
}

test("a drag in the transcript selects only the transcript's columns, never the panel beside it", () => {
	const { input, left, piSelection, panel } = selectionHarness();
	// From row 2 down to row 5, ending far to the right, over the panel.
	input(press(2, 2), drag(left + 20, 5));
	const text = piSelection();
	assert.ok(text, "pi selected something");
	assert.match(text!, /chat \d+/);
	assert.doesNotMatch(text!, /doc|│/, "no panel text and no panel border");
	for (const line of text!.split("\n")) assert.ok(line.length <= left, `stays in the chat's ${left} columns: ${line}`);
	input(release(left + 20, 5));
	assert.equal(panel.selectionText(), undefined, "the panel selected nothing");
});

test("a drag in the panel selects and copies only the current tab's text, and pi selects nothing", () => {
	const { input, left, piSelection, copied, handle } = selectionHarness();
	// Body rows start at panel row 1; text at panel column 2. Body line 0 is
	// "A.md doc 0", line 1 is blank, line 2 is "A.md doc 1".
	input(press(left + 2, 1), drag(left + 6, 3));
	assert.equal(piSelection(), undefined, "pi's selection never started");
	input(release(left + 6, 3));
	assert.deepEqual(copied, ["A.md doc 0\n\nA.md"]);
	assert.equal(handle.isFocused(), false, "a drag does not take the keyboard");
});

test("a drag from the panel into the chat stays in the panel's columns", () => {
	const { input, left, copied, piSelection } = selectionHarness();
	input(press(left + 7, 1), drag(3, 3), release(3, 3));
	assert.equal(piSelection(), undefined);
	// Clamped to column 0 of body line 2: from "doc 0" to the start of line 2.
	assert.deepEqual(copied, ["doc 0\n\n"]);
	assert.doesNotMatch(copied[0]!, /chat/);
});

test("the panel's selection is painted on its text and stays on it while the panel scrolls", () => {
	const { tui, input, left, panel } = selectionHarness();
	input(press(left + 2, 1), release(left + 12, 1)); // "A.md doc 0"
	const frame = () => panel.render(panelWidth(COLUMNS));
	assert.ok(frame()[1]!.includes("\x1b[7mA.md doc 0"), frame()[1]);
	input(wheelDown(left + 5, 5), wheelDown(left + 5, 5));
	assert.ok(!frame().some((l) => l.includes("\x1b[7m")), "scrolled off the top, nothing painted");
	assert.equal(panel.selectionText(), "A.md doc 0", "still the same text");
	panel.scrollTo(0);
	tui.doRender();
	assert.ok(frame()[1]!.includes("\x1b[7mA.md doc 0"), "back on the same text");
});

test("a selection belongs to its tab", () => {
	const { input, left, panel } = selectionHarness(["A.md", "B.md"]);
	input(press(left + 2, 1), release(left + 12, 1));
	assert.equal(panel.selectionText(), "A.md doc 0");
	panel.select(1);
	assert.equal(panel.selectionText(), undefined, "B has none");
	assert.ok(!panel.render(panelWidth(COLUMNS)).some((l) => l.includes("\x1b[7m")));
	panel.select(0);
	assert.equal(panel.selectionText(), "A.md doc 0", "A kept its own");
});

test("a click on the panel still focuses it and clears its selection; a drag past the body scrolls it", () => {
	const { input, left, panel, handle, copied } = selectionHarness();
	input(press(left + 2, 1), release(left + 12, 1));
	input(press(left + 5, 4), release(left + 5, 4));
	assert.equal(handle.isFocused(), true);
	assert.equal(panel.selectionText(), undefined);
	assert.equal(copied.length, 1, "the click copied nothing");
	// Drag below the body (the bottom border is row ROWS - 1): one line per move.
	input(press(left + 2, 1), drag(left + 5, ROWS - 1), drag(left + 5, ROWS - 1), release(left + 5, ROWS - 1));
	assert.match(panel.render(panelWidth(COLUMNS)).at(-1)!, /3–/, "scrolled two lines");
	assert.match(copied.at(-1)!, /^A\.md doc 0\n/);
});

test("another overlay still counts as covering the chat; the panel only while not masked", () => {
	const { tui, handle, split } = selectionHarness();
	assert.equal(tui.hasOverlay(), false, "the panel alone does not cover the chat");
	assert.equal(handle.isHidden(), false, "and it is still shown");
	assert.ok(tui.getScreenLines().length >= 0);
	const modal = tui.showOverlay({ render: () => ["modal"], invalidate() {} }, { anchor: "center", width: 10 });
	assert.equal(tui.hasOverlay(), true, "a real overlay does");
	modal.hide();
	split!.remove();
	assert.equal(tui.hasOverlay(), true, "without the split, pi's own answer: the panel counts");
	assert.equal(Object.prototype.hasOwnProperty.call(tui, "hasOverlay"), false, "and the instance is as it was");
});

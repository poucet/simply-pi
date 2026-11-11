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

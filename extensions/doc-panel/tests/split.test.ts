/**
 * The chat split, against pi-tui's real renderers: the fullscreen one
 * (`TuiAltScreen`, laid out from a root) and the regular one (`TuiMainScreen`,
 * rendered straight down). Each test draws a frame and reads it back as the
 * terminal would show it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Component,
	ScrollView,
	stripTerminalSequences,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { installSplit, panelWidth } from "../split.ts";

function fakeTerminal(columns = 100, rows = 12): any {
	return {
		columns,
		rows,
		write() {},
		start() {},
		stop() {},
		hideCursor() {},
		showCursor() {},
		setProgress() {},
		clear() {},
		on() {},
		off() {},
	};
}

/** A line of `ch` exactly as wide as it is given, so a row shows who got which columns. */
const fill = (ch: string): Component => ({ render: (w) => [ch.repeat(w)], invalidate() {} });

/** The doc panel stand-in: `P` across its width, the terminal's height. */
function panel(tui: any): Component {
	return { render: (w) => Array.from({ length: tui.terminal.rows }, () => "P".repeat(w)), invalidate() {} };
}

/** The overlay options the controller uses, with the width read live. */
function overlayOptions(tui: any) {
	return {
		anchor: "right-center" as const,
		get width() {
			return panelWidth(tui.terminal.columns);
		},
		maxHeight: "100%" as const,
		nonCapturing: true,
	};
}

/** Draw one frame and return it as plain text rows. */
function frameAlt(tui: any): string[] {
	tui.doRender();
	return tui.getScreenLines().map((l: string) => stripTerminalSequences(l));
}

function frameMain(tui: any): string[] {
	const lines = tui.compositeOverlays(tui.render(tui.terminal.columns), tui.terminal.columns, tui.terminal.rows);
	return lines.map((l: string) => stripTerminalSequences(l));
}

function altHarness(columns = 100) {
	const tui: any = new (TuiAltScreen as any)(fakeTerminal(columns));
	const transcript = new ScrollView(fill("t"), { follow: "end", primary: true });
	const root = new VStack([{ component: transcript, basis: 0, grow: 1 }, fill("E")]);
	tui.setLayoutRoot(root);
	tui.altScreenActive = true; // what start() sets, without a real terminal
	return { tui, root };
}

function mainHarness(columns = 100) {
	const tui: any = new (TuiMainScreen as any)(fakeTerminal(columns));
	tui.addChild(fill("t"));
	tui.addChild(fill("E"));
	return { tui };
}

const editorRow = (rows: string[]) => rows.find((r) => r.includes("E"))!;

test("panelWidth: half the terminal, at least 40 while the chat keeps 30", () => {
	assert.equal(panelWidth(200), 100);
	assert.equal(panelWidth(100), 50);
	assert.equal(panelWidth(70), 40);
	assert.equal(panelWidth(60), 30);
	assert.equal(panelWidth(40), 20);
});

test("fullscreen: the editor ends where the panel starts, and nothing is covered", () => {
	const { tui, root } = altHarness(100);
	let shown = true;
	const handle = tui.showOverlay(panel(tui), overlayOptions(tui));
	const split = installSplit(tui, (w) => (shown ? panelWidth(w) : 0));
	assert.equal(split?.kind, "layout");

	const row = editorRow(frameAlt(tui));
	assert.equal(row, `${"E".repeat(50)}${"P".repeat(50)}`);

	// Hidden: the chat has the full width again.
	shown = false;
	handle.setHidden(true);
	assert.equal(editorRow(frameAlt(tui)), "E".repeat(100));

	// Shown again, after a resize: the split follows the new width.
	shown = true;
	handle.setHidden(false);
	tui.terminal.columns = 160;
	assert.equal(editorRow(frameAlt(tui)), `${"E".repeat(80)}${"P".repeat(80)}`);

	split!.remove();
	assert.equal(tui.layoutRoot, root, "pi's own root is back");
});

test("fullscreen: the transcript still scrolls inside the narrowed column", () => {
	const tui: any = new (TuiAltScreen as any)(fakeTerminal(100, 6));
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
	const transcript = new ScrollView({ render: () => lines, invalidate() {} }, { follow: "end", primary: true });
	tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, fill("E")]));
	tui.altScreenActive = true;
	tui.showOverlay(panel(tui), overlayOptions(tui));
	installSplit(tui, (w) => panelWidth(w));

	const before = frameAlt(tui);
	assert.match(before.at(-2)!, /^line 29 +P{50}$/);
	transcript.scrollBy(-5);
	assert.match(frameAlt(tui).at(-2)!, /^line 24 +P{50}$/);
});

test("regular screen: the editor ends where the panel starts; remove restores the full width", () => {
	const { tui } = mainHarness(100);
	let shown = true;
	tui.showOverlay(panel(tui), overlayOptions(tui));
	const split = installSplit(tui, (w) => (shown ? panelWidth(w) : 0));
	assert.equal(split?.kind, "render");

	assert.equal(editorRow(frameMain(tui)), `${"E".repeat(50)}${"P".repeat(50)}`);
	shown = false;
	assert.equal(tui.render(100)[1], "E".repeat(100), "a zero reserve is the full width");

	shown = true;
	split!.remove();
	assert.equal(tui.render(100)[1], "E".repeat(100), "removed: the full width, whatever the reserve says");
});

test("fails safe: a reserve that throws, or a render that throws narrow, draws full width", () => {
	const { tui } = mainHarness(100);
	installSplit(tui, () => {
		throw new Error("boom");
	});
	assert.equal(tui.render(100)[1], "E".repeat(100));

	const alt = altHarness(100);
	alt.tui.showOverlay(panel(alt.tui), overlayOptions(alt.tui));
	installSplit(alt.tui, () => Number.NaN);
	assert.equal(editorRow(frameAlt(alt.tui)).slice(0, 50), "E".repeat(50));
	assert.equal(editorRow(frameAlt(alt.tui)).length, 100);

	const flaky: any = new (TuiMainScreen as any)(fakeTerminal(100));
	flaky.addChild({
		render: (w: number) => {
			if (w < 100) throw new Error("too narrow");
			return ["E".repeat(w)];
		},
		invalidate() {},
	});
	installSplit(flaky, (w) => panelWidth(w));
	assert.equal(flaky.render(100)[0], "E".repeat(100));
});

test("a TUI with no render and no layout root is left alone", () => {
	const fake: any = { terminal: { columns: 100, rows: 10 }, requestRender() {} };
	assert.equal(installSplit(fake, () => 10), undefined);
	assert.equal(fake.render, undefined);
});

test("installing twice replaces the first split instead of stacking", () => {
	const { tui, root } = altHarness(100);
	tui.showOverlay(panel(tui), overlayOptions(tui));
	installSplit(tui, (w) => panelWidth(w));
	const second = installSplit(tui, (w) => panelWidth(w));
	assert.equal(editorRow(frameAlt(tui)), `${"E".repeat(50)}${"P".repeat(50)}`);
	second!.remove();
	assert.equal(tui.layoutRoot, root);
});

/**
 * The stable TUI reference pi hands extensions: a Proxy onto whichever renderer
 * is current (pi-coding-agent's `createInteractiveTuiReference`, not exported,
 * so its get/set behaviour is copied here). Methods come back as fresh closures
 * bound to the renderer; sets land on the renderer.
 */
function piReference(getTui: () => any): any {
	return new Proxy(
		{},
		{
			get: (_t, p) => {
				const tui = getTui();
				const value = Reflect.get(tui, p, tui);
				return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, tui, args) : value;
			},
			set: (_t, p, v) => Reflect.set(getTui(), p, v, getTui()),
			has: (_t, p) => Reflect.has(getTui(), p),
			getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
		},
	);
}

test("through pi's TUI reference, both renderers split and restore", () => {
	const alt = altHarness(100);
	alt.tui.showOverlay(panel(alt.tui), overlayOptions(alt.tui));
	const altSplit = installSplit(piReference(() => alt.tui), (w) => panelWidth(w));
	assert.equal(altSplit?.kind, "layout");
	assert.equal(editorRow(frameAlt(alt.tui)), `${"E".repeat(50)}${"P".repeat(50)}`);
	altSplit!.remove();
	assert.equal(alt.tui.layoutRoot, alt.root);

	const main = mainHarness(100);
	main.tui.showOverlay(panel(main.tui), overlayOptions(main.tui));
	const mainSplit = installSplit(piReference(() => main.tui), (w) => panelWidth(w));
	assert.equal(mainSplit?.kind, "render");
	assert.equal(editorRow(frameMain(main.tui)), `${"E".repeat(50)}${"P".repeat(50)}`);
	mainSplit!.remove();
	assert.equal(main.tui.render(100)[1], "E".repeat(100));
});

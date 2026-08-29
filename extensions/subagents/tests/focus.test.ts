/**
 * Overlay focus regressions.
 *
 * The bug these pin down: pi's transcript scroller is a TUI *input listener*
 * (tui-alt-screen.js:85), so it runs before any component's `handleInput`
 * (tui.js:560 vs tui.js:616). It yields to an overlay only via
 * `shouldDeferViewportInputToOverlay()` === `isOverlayFocused()`. When something
 * steals focus to the editor, `pageUp` is consumed by the scroller and the MAIN
 * transcript scrolls under our pane — the user sees the wrong history.
 *
 * These tests drive the real `TuiAltScreen`, not a mock, because the whole
 * question is what pi's own machinery does with focus.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { keepFocus } from "../chat-view.ts";

const PAGE_UP = "\x1b[5~";

function fakeTerminal(): any {
	return {
		columns: 80,
		rows: 24,
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

function harness() {
	const tui: any = new (TuiAltScreen as any)(fakeTerminal());
	const view: any = { render: () => ["pane"], handleInput() { view.keys += 1; }, focused: false, keys: 0 };
	const editor: any = { render: () => ["editor"], handleInput() { editor.keys += 1; }, focused: false, keys: 0 };
	const handle = tui.showOverlay(view, { anchor: "top-left", width: "100%", maxHeight: "100%" });
	return { tui, view, editor, handle };
}

const focused = (tui: any) => tui.getFocus?.() ?? tui.focusedComponent;

test("showOverlay focuses the pane, so pi's scroller defers to it", () => {
	const { tui, view } = harness();
	assert.ok(focused(tui) === view);
	assert.equal(tui.isOverlayFocused(), true);
});

test("BUG: an editor swap steals focus and the scroller eats pageUp", () => {
	const { tui, view, editor } = harness();
	// This is exactly what `setCustomEditorComponent` does at its last line
	// (interactive-mode.js:2106), and what ~24 other pi call sites do.
	tui.setFocus(editor);

	tui.handleTerminalInput(PAGE_UP);

	// The pane never sees the key: the alt-screen listener consumed it upstream.
	// Claiming keys inside the pane's `handleInput` therefore cannot fix this.
	assert.equal(view.keys, 0, "pane must not receive pageUp once focus is lost");
	assert.equal(editor.keys, 0, "the scroller consumed it before any component ran");
	assert.equal(tui.isOverlayFocused(), false);
});

test("keepFocus restores focus after an editor swap, and the pane gets pageUp", () => {
	const { tui, view, editor } = harness();
	const release = keepFocus(tui, view);
	try {
		tui.setFocus(editor);
		// The next keypress reasserts focus before dispatch...
		tui.handleTerminalInput(PAGE_UP);
		assert.ok(focused(tui) === view, "focus must come back to the pane");

		// ...so the following key reaches the pane rather than the scroller.
		view.keys = 0;
		tui.handleTerminalInput(PAGE_UP);
		assert.equal(view.keys, 1, "pane must receive pageUp once focus is held");
		assert.equal(tui.isOverlayFocused(), true);
	} finally {
		release();
	}
});

test("keepFocus holds focus across repeated steals", () => {
	const { tui, view, editor } = harness();
	const release = keepFocus(tui, view);
	try {
		for (let i = 0; i < 5; i += 1) {
			tui.setFocus(editor);
			tui.handleTerminalInput(PAGE_UP);
			assert.ok(focused(tui) === view, `steal ${i} must be corrected`);
		}
	} finally {
		release();
	}
});

test("keepFocus yields to a real modal stacked on top of the pane", () => {
	const { tui, view } = harness();
	const release = keepFocus(tui, view);
	try {
		// A confirm() dialog is itself an overlay: it is entitled to the keyboard.
		const dialog: any = { render: () => ["dialog"], handleInput() {}, focused: false };
		tui.showOverlay(dialog, { anchor: "center", width: 40 });
		assert.ok(focused(tui) === dialog);

		tui.handleTerminalInput(PAGE_UP);
		assert.ok(focused(tui) === dialog, "must not steal focus back from a modal");
	} finally {
		release();
	}
});

test("releasing keepFocus stops it reasserting", () => {
	const { tui, view, editor } = harness();
	const release = keepFocus(tui, view);
	release();
	tui.setFocus(editor);
	tui.handleTerminalInput(PAGE_UP);
	assert.ok(focused(tui) === editor, "a released guard must not fight the app");
	assert.ok(focused(tui) !== view);
});

test("keepFocus survives a TUI that lacks the internals it prefers", () => {
	const component: any = { render: () => [], handleInput() {} };
	// No addInputListener, no overlayStack, and a setFocus that throws: a future
	// pi could reshape any of these. None of it may take the pane down.
	const bare: any = {
		setFocus() {
			throw new Error("no focus here");
		},
	};
	const release = keepFocus(bare, component);
	release();
});

test("keepFocus removes its listener on release and stops reasserting", () => {
	const component: any = { render: () => [], handleInput() {} };
	let calls = 0;
	const tui: any = {
		focusedComponent: undefined,
		inputListeners: new Set<any>(),
		// A mounted overlay is in the stack. Without this the guard correctly
		// concludes the component is not live and releases immediately — holding
		// focus for a disposed component is what froze the human's terminal.
		overlayStack: [{ component }],
		setFocus() {
			calls += 1;
		},
		addInputListener(listener: any) {
			tui.inputListeners.add(listener);
			return () => tui.inputListeners.delete(listener);
		},
	};
	const release = keepFocus(tui, component);
	for (const listener of [...tui.inputListeners]) listener("x");
	const before = calls;
	assert.ok(before > 0, "should try to take focus while mounted");

	release();
	assert.equal(tui.inputListeners.size, 0, "listener must be removed on release");
	for (const listener of [...tui.inputListeners]) listener("x");
	assert.equal(calls, before, "a released guard must never call setFocus again");
});

test("repeated open/close cycles do not accumulate input listeners", () => {
	const { tui, view } = harness();
	const baseline = tui.inputListeners.size;
	for (let i = 0; i < 5; i += 1) keepFocus(tui, view)();
	assert.equal(tui.inputListeners.size, baseline, "listener chain must be left as found");
});

test("switching chats never leaves a hold on a disposed pane", () => {
	// The reported freeze: open pane A, switch to pane B, return to main. The
	// close of A resolves *after* B opens, so two holds overlap; A's release then
	// restored a listener set B had already rebuilt, and A's poll kept focusing a
	// disposed component. Every keystroke went to something that no longer
	// rendered, and the terminal had to be killed.
	const paneA: any = { render: () => [], handleInput() {} };
	const paneB: any = { render: () => [], handleInput() {} };
	const editor: any = { render: () => [], handleInput() {} };
	const scroller = () => undefined;

	const tui: any = {
		focusedComponent: editor,
		overlayStack: [] as Array<{ component: unknown }>,
		inputListeners: new Set<any>([scroller]),
		setFocus(c: unknown) {
			tui.focusedComponent = c;
		},
		getFocus() {
			return tui.focusedComponent;
		},
		addInputListener(listener: any) {
			tui.inputListeners.add(listener);
			return () => tui.inputListeners.delete(listener);
		},
	};
	const pristine = [...tui.inputListeners];

	tui.overlayStack.push({ component: paneA });
	const releaseA = keepFocus(tui, paneA);

	// Switch: B opens before A's close resolves.
	tui.overlayStack.push({ component: paneB });
	const releaseB = keepFocus(tui, paneB);
	// The order that actually breaks: A's hold is still installed and A is still
	// in the stack when B takes focus, so A's observer steals it straight back.
	for (const listener of [...tui.inputListeners]) listener("x");
	assert.equal(
		tui.focusedComponent,
		paneB,
		"the newly opened pane must keep focus; the previous hold must not steal it back",
	);

	tui.overlayStack = tui.overlayStack.filter((e: any) => e.component !== paneA);
	releaseA();

	// Back to main: B closes too.
	tui.overlayStack = [];
	releaseB();

	assert.deepEqual(
		[...tui.inputListeners],
		pristine,
		"the listener set must be exactly what it was before any overlay opened",
	);

	tui.setFocus(editor);
	for (const listener of [...tui.inputListeners]) listener("x");
	assert.equal(tui.focusedComponent, editor, "focus must stay with the editor once every pane is gone");
});

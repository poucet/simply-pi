/**
 * Keymap regressions for the subagent pane.
 *
 * These drive the real component with raw terminal input and read the switcher
 * strip back out of the rendered frame, which is the only way to be sure the
 * pane and the below-editor widget agree about what is selected.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatPaneRegistry } from "../chat-pane.ts";
import { SubagentChatView, TextOverlay, captureWheel, switcherLines } from "../chat-view.ts";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { parseMouseReport } from "../mouse-selection.ts";
import { SwitcherStrip, nestedEntryId } from "../switcher.ts";
import type { ChatHost, ManagedAgent } from "../types.ts";

const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

/** Marks up the two highlights so a frame can be asserted on as plain text. */
const theme: any = {
	fg: (color: string, text: string) => (color === "accent" ? `<${text}>` : text),
	bg: (_color: string, text: string) => `[${text}]`,
	bold: (text: string) => text,
};

/** A flat theme for the scroll-contract tests (no markup in the frame). */
const flatTheme: any = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function agent(id: string, name: string): ManagedAgent {
	return {
		id,
		name,
		task: "task",
		cwd: "/tmp",
		sessionFile: `/tmp/does-not-exist-${id}.jsonl`,
		status: "running",
		contextMode: "fresh",
		usage: { cost: 0, turns: 1 },
		activity: [],
		startedAt: Date.now(),
	} as unknown as ManagedAgent;
}

function pane(onClose: () => void, startAgentId = "id-a") {
	const tui: any = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
	const agents = [agent("id-a", "alpha"), agent("id-b", "beta")];
	const host: ChatHost = {
		agents: () => agents,
		unread: () => 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async () => {},
	};
	const registry = new ChatPaneRegistry(tui, host.subscribe, () => {});
	const view = new SubagentChatView(tui, theme, host, registry, onClose, startAgentId);
	// The strip is the second-to-last line of the frame.
	return { view, host, strip: () => view.render(80).slice(-2)[0]!.trim() };
}

test("the pane highlights the chat it is showing", () => {
	const { strip } = pane(() => {});
	assert.equal(strip(), "● main │< ◐ alpha >│ ◐ beta");
});

test("tab cycles chats and wraps past the end to the main chat", () => {
	let closed = 0;
	const { view, strip } = pane(() => {
		closed += 1;
	});
	view.handleInput(TAB);
	assert.equal(strip(), "● main │ ◐ alpha │< ◐ beta >");
	view.handleInput(TAB);
	assert.equal(closed, 1);
});

test("bare arrows switch chats while the input box is empty", () => {
	const { view, strip } = pane(() => {});
	view.handleInput(RIGHT);
	assert.equal(strip(), "● main │ ◐ alpha │< ◐ beta >");
	view.handleInput(LEFT);
	assert.equal(strip(), "● main │< ◐ alpha >│ ◐ beta");
});

test("ctrl+arrows no longer switch chats (macOS eats them)", () => {
	let closed = 0;
	const { view, strip } = pane(() => {
		closed += 1;
	});
	view.handleInput(CTRL_LEFT);
	view.handleInput(CTRL_RIGHT);
	assert.equal(closed, 0);
	assert.equal(strip(), "● main │< ◐ alpha >│ ◐ beta");
});

test("down moves into the strip, enter opens the highlighted chat", () => {
	const { view, strip } = pane(() => {});
	view.handleInput(DOWN);
	assert.equal(strip(), "● main │[ ◐ alpha ]│ ◐ beta");
	view.handleInput(RIGHT);
	assert.equal(strip(), "● main │ ◐ alpha │[ ◐ beta ]");
	view.handleInput(ENTER);
	assert.equal(strip(), "● main │ ◐ alpha │< ◐ beta >");
});

test("escape leaves the strip first, and only then closes the pane", () => {
	let closed = 0;
	const { view, strip } = pane(() => {
		closed += 1;
	});
	view.handleInput(DOWN);
	view.handleInput(ESC);
	assert.equal(closed, 0);
	assert.equal(strip(), "● main │< ◐ alpha >│ ◐ beta");
	view.handleInput(ESC);
	assert.equal(closed, 1);
});

test("the widget under the main editor shows the same strip", () => {
	const { host } = pane(() => {});
	const strip = new SwitcherStrip(host, { requestRender: () => {}, open: () => {} });
	const lines = switcherLines(host, theme, strip, 120);
	// One detail line per agent, then the strip, then the hint.
	assert.equal(lines.length, 4);
	assert.equal(lines[2]!.trim(), "< ● main >│ ◐ alpha │ ◐ beta");
	assert.match(lines[3]!, /↓ switcher/);
	strip.focus();
	assert.equal(switcherLines(host, theme, strip, 120)[2]!.trim(), "[ ● main ]│ ◐ alpha │ ◐ beta");
});

// --- blocked children must be visible even to a long-busy parent ----------

test("the widget banners how many children are blocked on an answer", () => {
	const blocked = agent("id-a", "alpha");
	(blocked as any).pendingQuestion = { id: "q-1", question: "postgres or sqlite?", askedAt: 0 };
	const agents = [blocked, agent("id-b", "beta")];
	const host: ChatHost = {
		agents: () => agents,
		unread: () => 0,
		statusIcon: () => "?",
		subscribe: () => () => {},
		send: async () => {},
	};
	const strip = new SwitcherStrip(host, { requestRender() {}, open() {} });
	const text = switcherLines(host, theme, strip).join("\n");

	// The parent can be mid-turn for minutes; the blockage must not need a
	// careful read of every row to notice.
	assert.match(text, /1 subagent blocked on your answer: alpha/);
	// And the blocked agent's own row says what it is waiting for, rather than
	// showing the tool call it made before asking, which reads as progress.
	assert.match(text, /asks: postgres or sqlite\?/);
});

test("the banner names every blocked child and is absent when none are", () => {
	const one = agent("id-a", "alpha");
	const two = agent("id-b", "beta");
	(one as any).pendingQuestion = { id: "q-1", question: "a?", askedAt: 0 };
	(two as any).pendingQuestion = { id: "q-2", question: "b?", askedAt: 0 };
	const agents = [one, two];
	const host: ChatHost = {
		agents: () => agents,
		unread: () => 0,
		statusIcon: () => "?",
		subscribe: () => () => {},
		send: async () => {},
	};
	const strip = new SwitcherStrip(host, { requestRender() {}, open() {} });
	assert.match(
		switcherLines(host, theme, strip).join("\n"),
		/2 subagents blocked on your answer: alpha, beta/,
	);

	delete (one as any).pendingQuestion;
	delete (two as any).pendingQuestion;
	assert.doesNotMatch(switcherLines(host, theme, strip).join("\n"), /blocked on your answer/);
});

// --- scrollback: the overlay must own its viewport --------------------------

const PAGE_UP = "\x1b[5~";
const UP = "\x1b[A";
/** SGR wheel: button 64 = wheel up, 65 = wheel down. */
const WHEEL_UP = "\x1b[<64;10;10M";
const WHEEL_DOWN = "\x1b[<65;10;10M";
/** Legacy X10 wheel up: ESC [ M then three bytes offset by 32. */
const X10_WHEEL_UP = "\x1b[M" + String.fromCharCode(32 + 64, 32 + 10, 32 + 10);
/** An SGR left-click, so we can prove clicks are consumed harmlessly. */
const CLICK = "\x1b[<0;10;10M";

/**
 * A view over a pane whose content is `lines` rows tall, on a terminal of
 * `rows` rows that records everything written to it.
 */
/** What `captureWheel` writes: button and drag reporting, SGR-encoded, and the reverse. */
const ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

function scrollHarness(rows: number, contentLines = 0) {
	const writes: string[] = [];
	const tui: any = {
		mode: "regular",
		requestRender() {},
		terminal: { rows, columns: 80, write: (data: string) => writes.push(data) },
	};
	const agents = [agent("id-a", "alpha")];
	const host: ChatHost = {
		agents: () => agents,
		unread: () => 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async () => {},
	};
	const registry = new ChatPaneRegistry(tui, host.subscribe, () => {});
	const view = new SubagentChatView(tui, flatTheme, host, registry, () => {}, "id-a");
	const pane = registry.get(agents[0]!);
	// Enough content that the pane can genuinely scroll.
	for (let i = 0; i < contentLines; i++) pane.content.addChild({ render: () => [`line ${i}`] });
	return { tui, view, pane, writes };
}

test("the frame is exactly as tall as the terminal, whatever the content", () => {
	// A long conversation, a short one and an empty one must all paint every
	// row: any row the overlay does not paint is a row of main chat showing
	// through the composite (the original bug report).
	assert.equal(scrollHarness(24, 100).view.render(80).length, 24);
	assert.equal(scrollHarness(24, 3).view.render(80).length, 24);
	assert.equal(scrollHarness(24, 0).view.render(80).length, 24);
	// A taller or shorter terminal after a resize must be covered too.
	const tall = scrollHarness(24, 100);
	tall.tui.terminal.rows = 40;
	assert.equal(tall.view.render(80).length, 40);
	tall.tui.terminal.rows = 12;
	assert.equal(tall.view.render(80).length, 12);
	// Below the floor the frame stays 8 rows (the compositor clamps it).
	assert.equal(scrollHarness(5, 100).view.render(80).length, 8);
});

test("scroll keys at the top are consumed and never scroll past the beginning", () => {
	const { view, pane } = scrollHarness(24, 100);
	// PageUp by more than the content: clamped at zero, not negative.
	view.handleInput(PAGE_UP);
	view.handleInput(PAGE_UP);
	assert.equal(pane.scrollTop, 0);
	// The up arrow with an empty input box is a scroll key too.
	view.handleInput(UP);
	assert.equal(pane.scrollTop, 0);
	// And the wheel at the top does not go negative either.
	view.handleInput(WHEEL_UP);
	assert.equal(pane.scrollTop, 0);
});

test("the wheel scrolls the pane, in both SGR and legacy encodings", () => {
	const { view, pane } = scrollHarness(24, 100);
	view.handleInput(WHEEL_DOWN);
	view.handleInput(WHEEL_DOWN);
	assert.equal(pane.scrollTop, 2);
	assert.equal(pane.followEnd, false);
	view.handleInput(WHEEL_UP);
	assert.equal(pane.scrollTop, 1);
	view.handleInput(X10_WHEEL_UP);
	assert.equal(pane.scrollTop, 0);
});

test("mouse reports other than the wheel are consumed without side effects", () => {
	const { view } = scrollHarness(24, 100);
	view.handleInput(CLICK);
	assert.equal(view.render(80).length, 24, "a click must not disturb the frame");
	// The click sequence must not have been typed into the editor either.
	view.handleInput("x");
	assert.ok(view.render(80).some((line) => line.includes("x")), "the typed x must be in the frame");
});

test("captureWheel owns the mouse in regular mode and gives it back on release", () => {
	const { tui, writes } = scrollHarness(24);
	const release = captureWheel(tui);
	assert.deepEqual(writes, [ON]);
	release();
	// Idempotent: a double release writes the reset once.
	release();
	assert.deepEqual(writes, [ON, OFF]);
});

test("captureWheel never touches the mouse in fullscreen mode or unknown TUIs", () => {
	// The alt screen owns mouse reporting for the whole session; resetting it
	// from an overlay would break the session's input.
	const fullscreen: any = { mode: "fullscreen", terminal: { write() {} } };
	captureWheel(fullscreen)();
	const unknown: any = { terminal: { write() {} } };
	captureWheel(unknown)();
	// A TUI without a writable terminal must not crash either.
	captureWheel({ mode: "regular" })();
});

test("switching chats never leaves two wheel captures fighting over the mouse", () => {
	// Same overlap as the focus hold: pane B opens before pane A's close
	// resolves, so A's release runs after B's capture. The second capture must
	// release the first rather than leaving two writers on the DECSETs.
	const { tui, writes } = scrollHarness(24);
	const releaseA = captureWheel(tui);
	const releaseB = captureWheel(tui);
	assert.deepEqual(writes, [
		ON, // A captures
		OFF, // A is released by B's capture
		ON, // B captures
	]);
	releaseA(); // already stopped: must not reset B's capture
	assert.deepEqual(writes, [ON, OFF, ON]);
	releaseB();
	assert.deepEqual(writes.at(-1), OFF);
});

test("the notes overlay wheels too, and never scrolls above its first line", () => {
	const tui: any = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
	const overlay = new TextOverlay(tui, flatTheme, "notes", "line one\nline two\nline three");
	const before = overlay.render(80).length;
	overlay.handleInput(X10_WHEEL_UP);
	overlay.handleInput(X10_WHEEL_UP);
	// Clamped at the top: the frame must be unchanged rather than revealing
	// anything beneath, and a click must be consumed without effect.
	assert.equal(overlay.render(80).length, before);
	overlay.handleInput(CLICK);
	assert.equal(overlay.render(80).length, before);
});

// --- fullscreen: the alt screen routes the wheel through handleMouse ----------

/**
 * The real fullscreen renderer, on a terminal that only records what it is sent.
 *
 * In fullscreen mode the wheel never reaches `handleInput`: `TuiAltScreen`
 * parses it and dispatches it to the overlay under the pointer as a
 * `handleMouse` event, and scrolls the main transcript when the overlay does
 * not handle it. Only the real dispatch can prove the pane is the one moving.
 */
function altScreenHarness() {
	let send: (data: string) => void = () => {};
	const terminal: any = {
		start(onInput: (data: string) => void) {
			send = onInput;
		},
		stop() {},
		drainInput: async () => {},
		write() {},
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	const tui: any = new TuiAltScreen(terminal);
	tui.start();
	const lead = agent("id-a", "alpha");
	(lead as any).sessionId = "s-a";
	const nested: any = {
		sessionId: "s-n",
		parentSessionId: "s-a",
		parentName: "alpha",
		name: "grand",
		status: "running",
		icon: "◐",
		depth: 1,
		startedAt: Date.now(),
		turns: 1,
		cost: 0,
		activity: "",
		sessionFile: "/tmp/does-not-exist-nested.jsonl",
		cwd: "/tmp",
	};
	const host: ChatHost = {
		agents: () => [lead],
		descendants: () => [{ ...nested }],
		unread: () => 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async () => {},
	};
	const registry = new ChatPaneRegistry(tui, host.subscribe, () => {});
	const fill = (pane: { content: { addChild(c: unknown): void } }) => {
		for (let i = 0; i < 100; i++) pane.content.addChild({ render: () => [`line ${i}`], invalidate() {} });
		return pane;
	};
	const live = fill(registry.get(lead));
	const transcript = fill(
		registry.transcript({ id: nestedEntryId("s-n"), name: "grand", cwd: "/tmp", sessionFile: nested.sessionFile }),
	);
	/** Open `entryId` as the overlay and paint it once, as pi does. */
	const open = (entryId: string) => {
		const view = new SubagentChatView(tui, flatTheme, host, registry, () => {}, entryId);
		tui.showOverlay(view, { anchor: "top-left", width: "100%", maxHeight: "100%" });
		tui.renderNow?.() ?? tui.doRender?.();
		return view;
	};
	return { tui, send, live, transcript, open, stop: () => tui.stop() };
}

for (const kind of ["live", "read-only"] as const) {
	test(`in fullscreen mode the wheel scrolls a ${kind} pane, not the hidden main transcript`, () => {
		const h = altScreenHarness();
		try {
			const pane = kind === "live" ? h.live : h.transcript;
			h.open(kind === "live" ? "id-a" : nestedEntryId("s-n"));
			const bottom = pane.scrollTop;
			assert.ok(bottom > 0, "the pane opened at its end");
			h.send(WHEEL_UP);
			assert.ok(pane.scrollTop < bottom, `wheel up moves the pane (was ${bottom}, now ${pane.scrollTop})`);
			assert.equal(pane.followEnd, false, "and stops following the end");
			const scrolled = pane.scrollTop;
			h.send(WHEEL_DOWN);
			assert.ok(pane.scrollTop > scrolled, "wheel down moves it back");
		} finally {
			h.stop();
		}
	});
}

// --- mouse selection: drag to select, copy on release -----------------------

/** SGR reports at 1-based screen cell (x, y): press, drag (motion bit 32), release. */
const press = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
const release = (x: number, y: number) => `\x1b[<0;${x};${y}m`;
/** The text an OSC 52 write puts on the clipboard. */
const clipboard = (writes: string[]) =>
	writes
		.map((w) => /^\x1b\]52;c;([A-Za-z0-9+/=]*)\x07$/.exec(w)?.[1])
		.filter((b): b is string => b !== undefined)
		.map((b) => Buffer.from(b, "base64").toString("utf8"));
const REVERSE = "\x1b[7m";
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("SGR and X10 mouse reports parse into one zero-based shape", () => {
	assert.deepEqual(parseMouseReport("\x1b[<0;5;3M"), { type: "press", button: "left", x: 4, y: 2 });
	assert.deepEqual(parseMouseReport("\x1b[<32;6;3M"), { type: "drag", button: "left", x: 5, y: 2 });
	assert.deepEqual(parseMouseReport("\x1b[<0;6;3m"), { type: "release", button: "left", x: 5, y: 2 });
	assert.deepEqual(parseMouseReport("\x1b[<35;1;1M"), { type: "move", button: "none", x: 0, y: 0 });
	assert.deepEqual(parseMouseReport("\x1b[<2;1;1M"), { type: "press", button: "right", x: 0, y: 0 });
	assert.deepEqual(parseMouseReport("\x1b[<64;1;1M"), { type: "wheel", button: "none", x: 0, y: 0, wheelDelta: -1 });
	assert.deepEqual(parseMouseReport("\x1b[<65;1;1M"), { type: "wheel", button: "none", x: 0, y: 0, wheelDelta: 1 });
	// Horizontal wheel is a wheel that moves nothing.
	assert.equal(parseMouseReport("\x1b[<66;1;1M")?.wheelDelta, 0);
	// Modifier bits (shift 4, alt 8, ctrl 16) do not change the button.
	assert.equal(parseMouseReport("\x1b[<4;1;1M")?.button, "left");
	const x10 = (code: number, x: number, y: number) =>
		`\x1b[M${String.fromCharCode(32 + code, 32 + x, 32 + y)}`;
	assert.deepEqual(parseMouseReport(x10(0, 3, 4)), { type: "press", button: "left", x: 2, y: 3 });
	assert.deepEqual(parseMouseReport(x10(3, 3, 4)), { type: "release", button: "none", x: 2, y: 3 });
	assert.equal(parseMouseReport("x"), undefined);
	assert.equal(parseMouseReport("\x1b[A"), undefined);
});

test("a drag selects through the scroll offset and copies plain text on release", () => {
	const { view, pane, writes } = scrollHarness(24, 100);
	view.render(80);
	pane.scrollTop = 10;
	pane.followEnd = false;
	view.render(80);
	// Row 1 is the header, so screen row 2 is the first body line: content line 10.
	// From column 6 of "line 11" to column 4 of "line 13" (exclusive).
	view.handleInput(press(6, 3));
	view.handleInput(drag(10, 4));
	view.handleInput(drag(5, 5));
	assert.deepEqual(clipboard(writes), [], "nothing is copied before the release");
	view.handleInput(release(5, 5));
	assert.deepEqual(clipboard(writes), ["11\nline 12\nline"]);
});

test("the selection is painted in reverse video and follows the content when scrolled", () => {
	const { view, pane } = scrollHarness(24, 100);
	pane.scrollTop = 10;
	pane.followEnd = false;
	view.render(80);
	view.handleInput(press(1, 2)); // content line 10, column 0
	view.handleInput(release(5, 2)); // to column 4: "line"
	let frame = view.render(80);
	assert.ok(frame[1]!.includes(`${REVERSE}line`), frame[1]);
	assert.ok(!frame[2]!.includes(REVERSE), "only the selected line is painted");
	// Scroll down two lines: content line 10 is now off the top, nothing painted.
	view.handleInput(WHEEL_DOWN);
	view.handleInput(WHEEL_DOWN);
	frame = view.render(80);
	assert.ok(!frame.some((line) => line.includes(REVERSE)));
	// Back up: it is painted on the same text again.
	view.handleInput(WHEEL_UP);
	view.handleInput(WHEEL_UP);
	frame = view.render(80);
	assert.ok(frame[1]!.includes(`${REVERSE}line`) && plain(frame[1]!).startsWith("line 10"));
});

test("a drag that scrolls with the wheel keeps its anchor on the text it started on", () => {
	const { view, pane, writes } = scrollHarness(24, 100);
	pane.scrollTop = 10;
	pane.followEnd = false;
	view.render(80);
	view.handleInput(press(1, 2)); // line 10
	view.handleInput(WHEEL_DOWN); // now line 11 is on row 2
	view.render(80);
	view.handleInput(release(80, 3)); // row 3 is line 12, past its end
	assert.deepEqual(clipboard(writes), ["line 10\nline 11\nline 12"]);
});

test("a click without a drag clears the selection and copies nothing", () => {
	const { view, writes } = scrollHarness(24, 100);
	view.render(80);
	view.handleInput(press(1, 2));
	view.handleInput(release(4, 2));
	assert.equal(clipboard(writes).length, 1);
	view.handleInput(press(3, 5));
	view.handleInput(release(3, 5));
	assert.equal(clipboard(writes).length, 1, "a click copies nothing");
	assert.ok(!view.render(80).some((line) => line.includes(REVERSE)), "and leaves nothing painted");
});

test("a drag that leaves the body clamps to it; a press outside the body selects nothing", () => {
	const { view, pane, writes } = scrollHarness(24, 100);
	pane.scrollTop = 0;
	pane.followEnd = false;
	view.render(80);
	// Press on the header row: no selection, the drag after it does nothing.
	view.handleInput(press(1, 1));
	view.handleInput(drag(5, 3));
	view.handleInput(release(5, 3));
	assert.deepEqual(clipboard(writes), []);
	// Press in the body, drag up over the header: clamped to the first body row.
	view.handleInput(press(7, 3)); // line 1, column 6
	view.handleInput(release(1, 1)); // clamped to line 0, column 0
	assert.deepEqual(clipboard(writes), ["line 0\nline 1"]);
});

test("the fullscreen handleMouse path captures the drag and scrolls with the wheel", () => {
	const { view, pane, writes } = scrollHarness(24, 100);
	pane.scrollTop = 5;
	pane.followEnd = false;
	view.render(80);
	const at = (type: string, x: number, y: number, extra = {}) =>
		view.handleMouse({ type, button: type === "wheel" ? "none" : "left", x, y, ...extra } as any);
	assert.deepEqual(at("press", 0, 1), { capture: true });
	at("drag", 3, 1);
	at("release", 3, 1);
	assert.deepEqual(clipboard(writes), ["lin"]);
	assert.equal(at("click", 3, 1), undefined, "a click is not ours to claim");
	assert.deepEqual(at("wheel", 0, 1, { wheelDelta: 3 }), { handled: true });
	assert.equal(pane.scrollTop, 8);
});

test("styled lines copy without escapes and keep their style after the highlight", () => {
	const { view, pane, writes } = scrollHarness(24, 0);
	pane.content.addChild({ render: () => ["\x1b[31mred\x1b[0m plain \x1b[32mgreen\x1b[0m   "] });
	view.render(80);
	view.handleInput(press(5, 2));
	view.handleInput(release(80, 2));
	assert.deepEqual(clipboard(writes), ["plain green"]);
	const painted = view.render(80)[1]!;
	// Reverse opens at the range and is re-asserted after the green inside it.
	assert.ok(painted.startsWith(`\x1b[31mred\x1b[0m ${REVERSE}plain \x1b[32m${REVERSE}green`), painted);
	assert.equal(plain(painted), "red plain green   ");
});

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
import { SubagentChatView, switcherLines } from "../chat-view.ts";
import { SwitcherStrip } from "../switcher.ts";
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

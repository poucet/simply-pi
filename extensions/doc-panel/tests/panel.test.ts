/**
 * The panel's rendering and keys, with a theme that paints nothing so the
 * output can be read as plain text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { DocPanel, type DocPanelOptions, borderLine } from "../panel.ts";

const identity = (text: string) => text;
const plainTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: identity } as unknown as Theme;
const plainMarkdown: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function makePanel({ rows = 12, focused = false, ...overrides }: Partial<Omit<DocPanelOptions, "rows">> & { rows?: number; focused?: boolean } = {}) {
	const calls = { unfocus: 0, hide: 0, renders: 0 };
	const panel = new DocPanel({
		theme: plainTheme,
		markdownTheme: () => plainMarkdown,
		rows: () => rows,
		isFocused: () => focused,
		unfocus: () => calls.unfocus++,
		hide: () => calls.hide++,
		requestRender: () => calls.renders++,
		keys: { focus: "alt+l", toggle: "alt+h" },
		...overrides,
	});
	return { panel, calls };
}

const DOC = [
	"# Steps for Chris",
	"",
	"1. Open the **settings** file and look for the `extensions` key, which lists everything loaded at start.",
	"2. Run the command below.",
	"",
	"```sh",
	"pi --version",
	"```",
	"",
	...Array.from({ length: 30 }, (_, i) => `- item ${i + 1}`),
].join("\n");

for (const width of [100, 40, 12]) {
	test(`every line is exactly ${width} columns and there are exactly rows lines`, () => {
		const { panel } = makePanel({ rows: 15 });
		panel.setDoc("STEPS.md", DOC);
		const lines = panel.render(width);
		assert.equal(lines.length, 15);
		for (const line of lines) assert.equal(visibleWidth(line), width, JSON.stringify(line));
	});
}

test("the border names the file and the scroll position", () => {
	const { panel } = makePanel({ rows: 10 });
	panel.setDoc("STEPS.md", DOC);
	const lines = panel.render(60);
	// The chip pads its own text, so the name sits two spaces in from the rule.
	assert.match(lines[0]!, /^╭─ {2}STEPS\.md {2}─+╮$/);
	assert.match(lines.at(-1)!, /1–8\/\d+/);
	assert.match(lines.at(-1)!, /alt\+l scroll/);
	assert.match(lines[1]!, /│ Steps for Chris/);
});

test("focused, the hints change to the scroll keys", () => {
	const { panel } = makePanel({ rows: 10, focused: true });
	panel.setDoc("STEPS.md", DOC);
	assert.match(panel.render(80).at(-1)!, /esc back/);
});

test("keys scroll, clamp at both ends, and Esc gives focus back", () => {
	const { panel, calls } = makePanel({ rows: 10 });
	panel.setDoc("STEPS.md", DOC);
	const total = Number(/\/(\d+)/.exec(panel.render(60).at(-1)!)![1]);
	panel.handleInput("j");
	assert.match(panel.render(60).at(-1)!, /2–9\//);
	panel.handleInput("k");
	panel.handleInput("k");
	assert.match(panel.render(60).at(-1)!, /1–8\//);
	panel.handleInput("G");
	assert.match(panel.render(60).at(-1)!, new RegExp(`${total - 7}–${total}/${total}`));
	panel.handleInput("\x1b[6~"); // PgDn past the end
	assert.match(panel.render(60).at(-1)!, new RegExp(`–${total}/${total}`));
	panel.handleInput("g");
	assert.match(panel.render(60).at(-1)!, /1–8\//);
	panel.handleInput("\x1b");
	assert.equal(calls.unfocus, 1);
	assert.equal(calls.hide, 0);
});

test("a reload keeps the scroll position, a new doc goes to the top", () => {
	const { panel } = makePanel({ rows: 10 });
	panel.setDoc("STEPS.md", DOC);
	panel.render(60);
	panel.scrollBy(5);
	panel.setContent(`${DOC}\n- one more`);
	assert.match(panel.render(60).at(-1)!, /6–13\//);
	panel.setDoc("OTHER.md", DOC);
	assert.match(panel.render(60).at(-1)!, /1–8\//);
});

test("a deleted file keeps its text and says so in the border", () => {
	const { panel } = makePanel({ rows: 10 });
	panel.setDoc("STEPS.md", DOC);
	panel.setState({ kind: "missing" });
	const lines = panel.render(60);
	assert.match(lines[0]!, /deleted/);
	assert.match(lines[1]!, /Steps for Chris/);
});

test("the border drops low-priority pieces before truncating the name", () => {
	const rule = identity;
	assert.equal(borderLine(20, "╭", "╮", ["a", "b"], rule), "╭─ a ─ b ──────────╮");
	const narrow = borderLine(13, "╭", "╮", ["name.md", "deleted"], rule);
	assert.equal(narrow, "╭─ name.md ─╮");
	const tiny = borderLine(9, "╭", "╮", ["name.md"], rule);
	assert.equal(visibleWidth(tiny), 9);
	assert.match(tiny, /…/);
});

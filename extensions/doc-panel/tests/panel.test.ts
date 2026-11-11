/**
 * The panel's rendering and keys, with a theme that paints nothing so the
 * output can be read as plain text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { DocPanel, type DocPanelOptions, borderLine, layoutTabStrip, tabStrip } from "../panel.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
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
	const calls = { unfocus: 0, hide: 0, renders: 0, closed: [] as number[] };
	const panel = new DocPanel({
		theme: plainTheme,
		markdownTheme: () => plainMarkdown,
		rows: () => rows,
		isFocused: () => focused,
		unfocus: () => calls.unfocus++,
		hide: () => calls.hide++,
		closeTab: (index) => {
			calls.closed.push(index);
			panel.remove(index);
		},
		requestRender: () => calls.renders++,
		keys: { cycle: "ctrl+]" },
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
		panel.open("/d/STEPS.md", "STEPS.md", DOC);
		const lines = panel.render(width);
		assert.equal(lines.length, 15);
		for (const line of lines) assert.equal(visibleWidth(line), width, JSON.stringify(line));
	});
}

test("the border names the file and the scroll position", () => {
	const { panel } = makePanel({ rows: 10 });
	panel.open("/d/STEPS.md", "STEPS.md", DOC);
	const lines = panel.render(60);
	// The chip pads its own text, so the name sits two spaces in from the rule.
	assert.match(lines[0]!, /^╭─ {2}STEPS\.md {2}─+╮$/);
	assert.match(lines.at(-1)!, /1–8\/\d+/);
	assert.match(lines.at(-1)!, /ctrl\+\] focus/);
	assert.match(lines[1]!, /│ Steps for Chris/);
});

test("focused, the hints change to the scroll keys", () => {
	const { panel } = makePanel({ rows: 10, focused: true });
	panel.open("/d/STEPS.md", "STEPS.md", DOC);
	const bottom = panel.render(120).at(-1)!;
	assert.match(bottom, /esc back/);
	assert.match(bottom, /x close/);
	assert.match(bottom, /ctrl\+\] hide/);
	assert.doesNotMatch(bottom, /tab\/1–9/, "one tab: nothing to switch to");
	panel.open("/d/B.md", "B.md", "# B");
	assert.match(panel.render(140).at(-1)!, /tab\/1–9 switch/);
});

test("keys scroll, clamp at both ends, and Esc gives focus back", () => {
	const { panel, calls } = makePanel({ rows: 10 });
	panel.open("/d/STEPS.md", "STEPS.md", DOC);
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
	panel.open("/d/STEPS.md", "STEPS.md", DOC);
	panel.render(60);
	panel.scrollBy(5);
	panel.update("/d/STEPS.md", `${DOC}\n- one more`);
	assert.match(panel.render(60).at(-1)!, /6–13\//);
	panel.open("/d/OTHER.md", "OTHER.md", DOC);
	assert.match(panel.render(60).at(-1)!, /1–8\//);
});

test("a deleted file keeps its text and says so in the border", () => {
	const { panel } = makePanel({ rows: 10 });
	panel.open("/d/STEPS.md", "STEPS.md", DOC);
	panel.update("/d/STEPS.md", undefined, { kind: "missing" });
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

test("each tab keeps its own scroll; tab, shift+tab and digits switch, wrapping", () => {
	const { panel } = makePanel({ rows: 10, focused: true });
	panel.open("/d/A.md", "A.md", DOC);
	panel.open("/d/B.md", "B.md", `# Bravo\n\n${DOC}`);
	panel.open("/d/C.md", "C.md", "# Charlie");
	assert.equal(panel.currentIndex, 2, "a new doc becomes the current tab");
	panel.handleInput("1");
	assert.equal(panel.currentIndex, 0);
	panel.render(60);
	panel.scrollBy(4);
	assert.match(panel.render(60).at(-1)!, /5–12\//);
	panel.handleInput("\t");
	assert.equal(panel.currentIndex, 1);
	assert.match(panel.render(60)[1]!, /Bravo/);
	assert.match(panel.render(60).at(-1)!, /1–8\//, "B has its own scroll");
	panel.handleInput("\t");
	panel.handleInput("\t");
	assert.equal(panel.currentIndex, 0, "tab wraps past the last");
	assert.match(panel.render(60).at(-1)!, /5–12\//, "A kept its scroll");
	panel.handleInput("\x1b[Z"); // shift+tab
	assert.equal(panel.currentIndex, 2, "shift+tab wraps past the first");
	panel.handleInput("\x1b[9;2u"); // shift+tab, kitty protocol
	assert.equal(panel.currentIndex, 1);
	panel.handleInput("9");
	assert.equal(panel.currentIndex, 1, "a digit past the last tab does nothing");
	panel.open("/d/A.md", "A.md", DOC);
	assert.equal(panel.docs.length, 3, "an open path is not opened twice");
	assert.equal(panel.currentIndex, 0);
	assert.match(panel.render(60).at(-1)!, /5–12\//, "and switching to it keeps its scroll");
});

test("x closes the current tab and selects its neighbour", () => {
	const { panel, calls } = makePanel({ rows: 10, focused: true });
	panel.open("/d/A.md", "A.md", "# A");
	panel.open("/d/B.md", "B.md", "# B");
	panel.open("/d/C.md", "C.md", "# C");
	panel.select(1);
	panel.handleInput("x");
	assert.deepEqual(calls.closed, [1]);
	assert.deepEqual(panel.docs.map((d) => d.name), ["A.md", "C.md"]);
	assert.equal(panel.docs[panel.currentIndex]!.name, "C.md", "the right-hand neighbour");
	panel.handleInput("x");
	assert.equal(panel.docs[panel.currentIndex]!.name, "A.md", "closing the last tab selects the new last");
	panel.select(0);
	panel.open("/d/D.md", "D.md", "# D");
	panel.select(1);
	panel.remove(0);
	assert.equal(panel.docs[panel.currentIndex]!.name, "D.md", "removing a tab before the current keeps the current");
});

test("the cycle key, if it ever reaches the focused panel, hides it", () => {
	const { panel, calls } = makePanel({ rows: 10, focused: true });
	panel.open("/d/A.md", "A.md", "# A");
	panel.handleInput("\x1d");
	assert.equal(calls.hide, 1);
	assert.equal(calls.unfocus, 0);
});

test("the tab strip shows every name when they fit, highlighting the current", () => {
	const { panel } = makePanel({ rows: 6 });
	for (const n of ["alpha", "beta", "gamma"]) panel.open(`/d/${n}.md`, `${n}.md`, `# ${n}`);
	panel.select(1);
	assert.match(panel.render(60)[0]!, /^╭─  alpha\.md  beta\.md  gamma\.md  ─+╮$/);
	const marked = tabStrip(["a", "b", "c"], 1, 40, (n) => `[${n}]`, (t) => t);
	assert.equal(marked, " a [b] c ");
});

test("on a narrow panel the strip keeps the current tab, its nearest neighbours and a count", () => {
	const names = ["one.md", "two.md", "three.md", "four.md", "five.md"];
	const paint = (n: string) => `[${n}]`;
	const plain = (t: string) => t;
	// All five need 6+6+8+7+7 + 10 padding = 44 columns.
	assert.equal(tabStrip(names, 2, 44, paint, plain), " one.md  two.md [three.md] four.md  five.md ");
	assert.equal(tabStrip(names, 2, 32, paint, plain), " two.md [three.md] four.md  3/5 ");
	assert.equal(tabStrip(names, 2, 30, paint, plain), "[three.md] four.md  3/5 ", "right-hand neighbour first");
	assert.equal(tabStrip(names, 4, 30, paint, plain), " four.md [five.md] 5/5 ");
	assert.equal(tabStrip(names, 0, 16, paint, plain), "[one.md] 1/5 ");
	const cut = tabStrip(["a-very-long-document-name.md", "b.md"], 0, 14, paint, plain);
	assert.match(stripAnsi(cut), /^\[a-very…\] 1\/2 $/);
	assert.ok(visibleWidth(cut) <= 14);
	assert.match(tabStrip(["a-very-long-document-name.md", "b.md"], 0, 6, paint, plain), /^\[.*…(\x1b\[0m)?\]$/, "no room for the count: the name alone");
	for (const room of [1, 3, 8, 12, 20, 33]) {
		for (let current = 0; current < names.length; current++) {
			const strip = tabStrip(names, current, room, (n) => ` ${n} `, plain);
			assert.ok(visibleWidth(strip) <= room, `room ${room}, current ${current}: ${JSON.stringify(strip)}`);
		}
	}
});

test("the strip says where each tab it shows landed, so a click maps back to the tab", () => {
	const names = ["one.md", "two.md", "three.md", "four.md", "five.md"];
	const paint = (n: string) => `[${n}]`;
	const plain = (t: string) => t;
	const { text, spans } = layoutTabStrip(names, 2, 32, paint, plain);
	assert.equal(text, " two.md [three.md] four.md  3/5 ");
	assert.deepEqual(
		spans.map((s) => [names[s.index], text.slice(s.start, s.end)]),
		[["two.md", " two.md "], ["three.md", "[three.md]"], ["four.md", " four.md "]],
		"the count is no tab",
	);
	assert.deepEqual(layoutTabStrip(names, 0, 6, paint, plain).spans.map((s) => s.index), [0], "a cut name alone");
	assert.deepEqual(layoutTabStrip([], 0, 40, paint, plain), { text: "", spans: [] });
});

for (const width of [100, 40, 24, 12]) {
	test(`with many tabs and a deleted file, the top border is exactly ${width} columns and names the current doc`, () => {
		const { panel } = makePanel({ rows: 6 });
		for (let i = 1; i <= 12; i++) panel.open(`/d/doc-${i}.md`, `doc-${i}.md`, "# x");
		panel.select(6);
		panel.update("/d/doc-7.md", undefined, { kind: "missing" });
		const top = panel.render(width)[0]!;
		assert.equal(visibleWidth(top), width, top);
		if (width >= 24) assert.match(top, /doc-7\.md/);
		if (width >= 24) assert.match(top, /7\/12/);
		if (width >= 100) assert.match(top, /deleted/);
	});
}

/**
 * The doc renderer: markdown with its syntax gone, and images placed (or
 * replaced by a placeholder) according to what the terminal can draw. Painted
 * with a theme that paints nothing, so the output reads as plain text.
 */

import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	type MarkdownTheme,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	setImageTranscoder,
	stripTerminalSequences,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { cropKitty, ImageStore, resolveImage } from "../images.ts";
import { DocPanel } from "../panel.ts";
import { renderDoc } from "../render.ts";

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

const KITTY = "\x1b_G";

function caps(images: "kitty" | "iterm2" | null, hyperlinks = false): void {
	setCapabilities({ images, trueColor: true, hyperlinks });
}

afterEach(() => resetCapabilitiesCache());

/** A directory with a PNG and a JPEG header in it: enough for their sizes, which is all that is read. */
function fixtures(png = { width: 90, height: 180 }) {
	const dir = mkdtempSync(join(tmpdir(), "doc-render-"));
	writeFileSync(join(dir, "shot.png"), pngHeader(png.width, png.height));
	const jpeg = Buffer.alloc(32);
	Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40]).copy(jpeg);
	writeFileSync(join(dir, "photo.jpg"), jpeg);
	writeFileSync(join(dir, "notes.txt"), "not an image");
	return dir;
}

function pngHeader(width: number, height: number): Buffer {
	const buf = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buf);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

function render(text: string, width = 60, { dir = tmpdir(), maxImageRows = 10, images = new ImageStore() } = {}) {
	return renderDoc(text, width, { theme: plainTheme, md: plainMarkdown, baseDir: dir, images, maxImageRows });
}

function plain(text: string, width = 60): string[] {
	return render(text, width).lines.map(stripTerminalSequences);
}

test("a paragraph's own line breaks are joined and the text rewrapped; a hard break still breaks", () => {
	assert.deepEqual(plain("one two\nthree four\nfive", 60), ["one two three four five"]);
	assert.deepEqual(plain("one two  \nthree", 60), ["one two", "three"]);
});

test("headings show their text with no # at any level", () => {
	const lines = plain("# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six");
	for (const word of ["One", "Two", "Three", "Four", "Six"]) assert.ok(lines.includes(word), `${word} in ${JSON.stringify(lines)}`);
	assert.ok(!lines.some((line) => line.includes("#")), JSON.stringify(lines));
});

test("heading levels are told apart by style", () => {
	const md = { ...plainMarkdown, bold: (t: string) => `<b>${t}</b>`, underline: (t: string) => `<u>${t}</u>`, heading: (t: string) => `<h>${t}</h>` };
	const theme = { ...plainTheme, fg: (c: string, t: string) => `<${c}>${t}</${c}>` } as unknown as Theme;
	const { lines } = renderDoc("# A\n\n## B\n\n### C\n\n#### D", 40, { theme, md, baseDir: tmpdir(), images: new ImageStore(), maxImageRows: 5 });
	const styled = lines.filter(Boolean);
	assert.deepEqual(styled, ["<h><b><u>A</u></b></h>", "<h><b>B</b></h>", "<b>C</b>", "<muted><b>D</b></muted>"]);
});

test("code blocks have no fences, a bar down the side, and keep their indentation", () => {
	const lines = plain("Run:\n\n```sh\npi --version\n  indented\n```\n\nDone.");
	assert.ok(!lines.some((line) => line.includes("```")), JSON.stringify(lines));
	assert.ok(lines.includes("▎ pi --version"), JSON.stringify(lines));
	assert.ok(lines.includes("▎   indented"), JSON.stringify(lines));
});

test("code blocks use the theme's highlighter when it has one", () => {
	const md = { ...plainMarkdown, highlightCode: (code: string, lang?: string) => code.split("\n").map((l) => `${lang}:${l}`) };
	const { lines } = renderDoc("```js\nlet a\n```", 40, { theme: plainTheme, md, baseDir: tmpdir(), images: new ImageStore(), maxImageRows: 5 });
	assert.deepEqual(lines, ["▎ js:let a"]);
});

test("bullets, numbers and task boxes replace the list markers", () => {
	const lines = plain("- one\n  - nested\n    - deeper\n- two\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo");
	assert.deepEqual(lines, ["• one", "  ◦ nested", "    ▪ deeper", "• two", "", "3. three", "4. four", "", "☑ done", "☐ todo"]);
});

test("a wrapped list item continues under its text, not its bullet", () => {
	const lines = plain("- a long item that has to wrap onto a second line", 20);
	assert.equal(lines[0], "• a long item that");
	assert.ok(lines[1]!.startsWith("  "), JSON.stringify(lines));
});

test("emphasis, strong, strikethrough and code spans show no markers", () => {
	const [line] = plain("some *em*, **strong**, ~~gone~~ and `code` here");
	assert.equal(line, "some em, strong, gone and code here");
});

test("a link shows its text, and its URL only when the terminal can't make it clickable", () => {
	caps(null, false);
	assert.deepEqual(plain("see [the docs](https://example.com/docs)"), ["see the docs (https://example.com/docs)"]);
	caps(null, true);
	const [raw] = render("see [the docs](https://example.com/docs)").lines;
	assert.ok(raw!.includes("\x1b]8;;https://example.com/docs"), "an OSC 8 hyperlink");
	assert.equal(stripTerminalSequences(raw!), "see the docs");
});

test("tables are drawn with box lines, quotes with a bar, rules across the width", () => {
	const lines = plain("| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---", 30);
	assert.ok(lines.includes("┌───┬───┐"), JSON.stringify(lines));
	assert.ok(!lines.some((line) => /\|\s*-+\s*\|/.test(line)), "no markdown delimiter row");
	assert.ok(lines.includes("│ quoted"), JSON.stringify(lines));
	assert.ok(lines.includes("─".repeat(30)), JSON.stringify(lines));
});

test("no line is wider than asked", () => {
	const doc = "# A heading that is much too long for the width\n\n```\na code line that is much too long\n```\n\n- an item that is much too long\n\n> a quote that is much too long";
	for (const line of render(doc, 16).lines) assert.ok(visibleWidth(line) <= 16, JSON.stringify(line));
});

test("html comments are hidden", () => {
	assert.deepEqual(plain("before <!-- hidden --> after\n\n<!-- block -->\n\nlast"), ["before  after", "", "last"]);
});

test("resolveImage: relative to the doc, absolute, file:// and percent-encoded; remote stays remote", () => {
	assert.deepEqual(resolveImage("img/a.png", "/docs"), { kind: "file", path: "/docs/img/a.png" });
	assert.deepEqual(resolveImage("/abs/a.png", "/docs"), { kind: "file", path: "/abs/a.png" });
	assert.deepEqual(resolveImage("file:///abs/a%20b.png", "/docs"), { kind: "file", path: "/abs/a b.png" });
	assert.deepEqual(resolveImage("my%20shot.png", "/docs"), { kind: "file", path: "/docs/my shot.png" });
	assert.deepEqual(resolveImage("https://x.io/a.png", "/docs"), { kind: "remote", url: "https://x.io/a.png" });
});

test("without an image protocol an image is a one-line placeholder with its path", () => {
	caps(null);
	const dir = fixtures();
	const out = render("![the shot](shot.png)", 60, { dir });
	assert.deepEqual(out.images, []);
	assert.deepEqual(out.lines.map(stripTerminalSequences), ["🖼 the shot · shot.png"]);
});

test("iTerm2 gets the placeholder too: its images can't be drawn inside an overlay", () => {
	caps("iterm2");
	const dir = fixtures();
	const out = render("![the shot](shot.png)", 60, { dir });
	assert.deepEqual(out.images, []);
	assert.equal(out.lines.length, 1);
});

test("a remote image is a placeholder, on any terminal", () => {
	caps("kitty");
	const out = render("![logo](https://example.com/logo.png)");
	assert.deepEqual(out.images, []);
	assert.deepEqual(out.lines.map(stripTerminalSequences), ["🖼 logo · https://example.com/logo.png"]);
});

test("on Kitty, a missing, non-image or unconvertible file says why it isn't drawn", () => {
	caps("kitty");
	const dir = fixtures();
	const say = (md: string) => render(md, 80, { dir }).lines.map(stripTerminalSequences).join("\n");
	assert.match(say("![gone](nope.png)"), /🖼 gone · nope\.png \(not found\)/);
	assert.match(say("![txt](notes.txt)"), /\(not a PNG, JPEG, GIF, WebP or SVG\)/);
	// No PNG transcoder is registered in tests, and Kitty takes only PNG.
	assert.match(say("![photo](photo.jpg)"), /\(can't convert it to PNG for this terminal\)/);
});

test("on Kitty, a PNG takes rows of blank lines and a placement no wider than the text", () => {
	caps("kitty");
	const dir = fixtures({ width: 900, height: 1800 });
	const out = render("Above\n\n![tall](shot.png)\n\nBelow", 30, { dir, maxImageRows: 8 });
	assert.equal(out.images.length, 1);
	const mark = out.images[0]!;
	assert.equal(mark.rows, 8, "capped at maxImageRows");
	assert.equal(out.lines[0], "Above");
	assert.deepEqual(out.lines.slice(mark.row, mark.row + mark.rows), Array(8).fill(""));
	assert.equal(out.lines[mark.row + mark.rows + 1], "Below");
	const seq = mark.sequence(0, mark.rows);
	assert.ok(seq.startsWith(KITTY));
	const columns = Number(/c=(\d+)/.exec(seq)?.[1]);
	assert.ok(columns >= 1 && columns <= 30, `c=${columns}`);
	assert.match(seq, /r=8/);
	assert.match(seq, /C=1/, "the cursor stays put, so the line can go on");
});

test("an image in a list item sits after the bullet", () => {
	caps("kitty");
	const dir = fixtures();
	const out = render("- ![shot](shot.png)", 30, { dir });
	const mark = out.images[0]!;
	assert.equal(out.lines[mark.row], "• ");
	assert.equal(out.lines[mark.row + 1], "  ");
});

test("a JPEG on Kitty goes through pi's PNG transcoder, also when it registers after the first render", () => {
	caps("kitty");
	const dir = fixtures();
	const images = new ImageStore();
	const doc = "![photo](photo.jpg)";
	assert.deepEqual(render(doc, 40, { dir, images }).images, [], "no transcoder yet: placeholder");
	let calls = 0;
	setImageTranscoder((_data, mime) => {
		calls++;
		assert.equal(mime, "image/jpeg");
		return pngHeader(64, 32).toString("base64");
	});
	try {
		const out = render(doc, 40, { dir, images });
		assert.equal(out.images.length, 1, "drawn once the transcoder is there");
		assert.equal(calls, 1);
		assert.ok(out.images[0]!.sequence(0, out.images[0]!.rows).includes("f=100"), "sent as PNG");
	} finally {
		setImageTranscoder(undefined);
	}
});

test("invalidate redraws images at the terminal's real cell size", () => {
	caps("kitty");
	const dir = fixtures({ width: 900, height: 900 });
	const images = new ImageStore();
	const rows = () => render("![sq](shot.png)", 40, { dir, images, maxImageRows: 100 }).images[0]!.rows;
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	try {
		const before = rows();
		setCellDimensions({ widthPx: 9, heightPx: 9 });
		assert.equal(rows(), before, "cached until invalidated");
		images.invalidate();
		assert.ok(rows() > before, "square cells: more rows for the same picture");
	} finally {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	}
});

test("cropKitty cuts the source rectangle and the rows; whole images are left alone", () => {
	const seq = `${KITTY}a=T,f=100,q=2,C=1,c=10,r=8,i=7;AAAA\x1b\\`;
	assert.equal(cropKitty(seq, 8, 160, 0, 8), seq);
	const top = cropKitty(seq, 8, 160, 3, 5);
	assert.match(top, /y=60,h=100,r=5;AAAA/);
	assert.match(top, /i=7/);
	const bottom = cropKitty(seq, 8, 160, 0, 2);
	assert.match(bottom, /y=0,h=40,r=2;/);
});

test("an image file is read again only when its mtime or size changes", () => {
	caps("kitty");
	const dir = fixtures({ width: 90, height: 90 });
	const path = join(dir, "shot.png");
	const store = new ImageStore();
	const rowsOf = () => {
		const placed = store.place(path, 0, 40, 40);
		assert.notEqual(typeof placed, "string");
		return (placed as { rows: number }).rows;
	};
	const before = rowsOf();
	// Same size, same mtime, different picture: the cached one is used.
	const stamp = new Date(Date.now() - 60_000);
	writeFileSync(path, pngHeader(90, 900));
	utimesSync(path, stamp, stamp);
	const cachedStore = new ImageStore();
	writeFileSync(path, pngHeader(90, 90));
	utimesSync(path, stamp, stamp);
	cachedStore.place(path, 0, 40, 40);
	writeFileSync(path, pngHeader(90, 900));
	utimesSync(path, stamp, stamp);
	assert.equal((cachedStore.place(path, 0, 40, 40) as { rows: number }).rows, before, "unchanged mtime: not re-read");
	// A new mtime: read again.
	utimesSync(path, new Date(), new Date());
	assert.ok((cachedStore.place(path, 0, 40, 40) as { rows: number }).rows > before, "new mtime: re-read");
});

test("two uses of one image get their own Kitty ids; a re-render keeps them", () => {
	caps("kitty");
	const dir = fixtures();
	const images = new ImageStore();
	const ids = () =>
		render("![a](shot.png)\n\n![b](shot.png)", 40, { dir, images }).images.map((m) => /i=(\d+)/.exec(m.sequence(0, m.rows))?.[1]);
	const first = ids();
	assert.equal(first.length, 2);
	assert.notEqual(first[0], first[1]);
	assert.deepEqual(ids(), first);
});

function newPanel(rows: () => number) {
	return new DocPanel({
		theme: plainTheme,
		markdownTheme: () => plainMarkdown,
		rows,
		isFocused: () => true,
		unfocus: () => {},
		hide: () => {},
		closeTab: () => {},
		requestRender: () => {},
		keys: { cycle: "ctrl+shift+d" },
	});
}

const IMAGE_DOC = ["# Title", "", "line a", "", "![tall](shot.png)", "", ...Array.from({ length: 20 }, (_, i) => `after ${i + 1}  `)].join("\n");

/** A panel over a doc with a tall image in the middle; the tab's key is its path, so images resolve beside it. */
function imagePanel(rows: number) {
	caps("kitty");
	const dir = fixtures({ width: 900, height: 1800 });
	const panel = newPanel(() => rows);
	panel.open(join(dir, "DOC.md"), "DOC.md", IMAGE_DOC);
	return panel;
}

const rowsOf = (line: string) => Number(/r=(\d+)/.exec(line)?.[1]);

test("panel: the image goes on its first row, every line stays the panel's width", () => {
	const panel = imagePanel(20);
	const lines = panel.render(40);
	assert.equal(lines.length, 20);
	for (const line of lines) assert.equal(visibleWidth(line), 40, JSON.stringify(stripTerminalSequences(line)));
	const anchors = lines.filter((line) => line.includes(KITTY));
	assert.equal(anchors.length, 1);
	// Title, blank, "line a", blank: the image starts on body row 5, frame line 5.
	assert.ok(lines[5]!.includes(KITTY));
	assert.ok(lines[5]!.startsWith("│ "), "inside the border");
	// 18 body rows, two thirds of it.
	assert.equal(rowsOf(lines[5]!), 12);
	assert.ok(lines.at(-1)!.includes("1–18/"), stripTerminalSequences(lines.at(-1)!));
});

test("panel: scrolled past the image's top, it is cut and moved to the first body line", () => {
	const panel = imagePanel(20);
	panel.render(40);
	panel.scrollBy(7); // image rows 4..15; rows 4..6 scrolled off
	const lines = panel.render(40);
	const anchor = lines[1]!;
	assert.ok(anchor.includes(KITTY), "first body line carries the image");
	assert.equal(rowsOf(anchor), 9);
	assert.match(anchor, /y=\d+,h=\d+/);
	assert.equal(lines.filter((line) => line.includes(KITTY)).length, 1);
	assert.ok(lines.at(-1)!.includes("8–25/"), stripTerminalSequences(lines.at(-1)!));
});

test("panel: an image running off the bottom is cut at the border", () => {
	const panel = imagePanel(10); // 8 body rows, image capped at 5
	const lines = panel.render(40);
	const at = lines.findIndex((line) => line.includes(KITTY));
	assert.equal(at, 5);
	assert.equal(rowsOf(lines[at]!), 4, "rows 5..8 of the body: 4 rows, not the image's 5");
});

test("panel: scrolled past the whole image, no placement is drawn", () => {
	const panel = imagePanel(20);
	panel.render(40);
	panel.scrollBy(16);
	assert.ok(!panel.render(40).some((line) => line.includes(KITTY)));
});

test("panel: the placement survives being composited into a chat line at the panel's column", () => {
	const panel = imagePanel(20);
	const anchor = panel.render(40)[5]!;
	const chat = "chat text on the left ".repeat(4);
	const composited = compositeTuiLine(chat, anchor, 40, 40, 80);
	const seq = anchor.slice(anchor.indexOf(KITTY), anchor.indexOf("\x1b\\", anchor.indexOf(KITTY)) + 2);
	assert.ok(composited.includes(seq), "the Kitty sequence is intact");
	// What is printed before it is exactly the chat's 40 columns and the panel's "│ ".
	assert.equal(visibleWidth(composited.slice(0, composited.indexOf(KITTY))), 42);
	assert.equal(visibleWidth(composited), 80);
});

const idsIn = (lines: readonly string[]) => lines.flatMap((line) => [...line.matchAll(/\x1b_G[^;]*\bi=(\d+)/g)].map((m) => m[1]));

test("tabs: the same image in two tabs gets two Kitty ids, and only the current tab draws", () => {
	caps("kitty");
	const dir = fixtures({ width: 900, height: 1800 });
	const panel = newPanel(() => 20);
	panel.open(join(dir, "A.md"), "A.md", IMAGE_DOC);
	panel.open(join(dir, "B.md"), "B.md", IMAGE_DOC);
	const b = idsIn(panel.render(40));
	panel.select(0);
	const a = idsIn(panel.render(40));
	assert.equal(a.length, 1);
	assert.equal(b.length, 1);
	assert.notEqual(a[0], b[0]);
});

/** A terminal that records what is written to it. */
function recordingTerminal(columns: number, rows: number) {
	const written: string[] = [];
	const terminal: any = {
		columns,
		rows,
		write: (data: string) => written.push(data),
		start() {},
		stop() {},
		hideCursor() {},
		showCursor() {},
		setProgress() {},
		clear() {},
		on() {},
		off() {},
	};
	return { terminal, written };
}

for (const kind of ["regular", "fullscreen"] as const) {
	test(`tabs (${kind} screen): switching to a doc without images deletes the old tab's placement`, () => {
		caps("kitty");
		const dir = fixtures({ width: 900, height: 1800 });
		const { terminal, written } = recordingTerminal(80, 20);
		const tui: any = kind === "regular" ? new (TuiMainScreen as any)(terminal) : new (TuiAltScreen as any)(terminal);
		if (kind === "fullscreen") {
			tui.altScreenActive = true; // what start() sets, without a real terminal
			tui.imageProtocol = "kitty";
		}
		tui.addChild({ render: (w: number) => Array.from({ length: 20 }, (_, i) => `chat ${i}`.padEnd(w)), invalidate() {} });
		const panel = newPanel(() => 20);
		panel.open(join(dir, "IMG.md"), "IMG.md", IMAGE_DOC);
		panel.open(join(dir, "TXT.md"), "TXT.md", "# Text only\n\nno pictures here");
		panel.select(0);
		tui.showOverlay(panel, { anchor: "right-center", width: 40, maxHeight: "100%", nonCapturing: true });
		tui.doRender();
		const drawn = written.join("");
		const [id] = idsIn([drawn]);
		assert.ok(id, "the image tab drew its image");

		written.length = 0;
		panel.select(1);
		tui.doRender();
		const after = written.join("");
		// regular screen: that image is deleted by id; fullscreen: every placement is cleared and redrawn.
		const deleted = kind === "regular" ? after.includes(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`) : after.includes("\x1b_Ga=d,d=a,q=2\x1b\\");
		assert.ok(deleted, JSON.stringify(after.slice(0, 200)));
		assert.ok(!/\x1b_Ga=[Tp]/.test(after), "nothing is placed again");
	});
}

test("svg: placeholder while converting, then the converted PNG; failures say why", async () => {
	caps("kitty");
	const dir = fixtures();
	writeFileSync(join(dir, "d.svg"), "<svg/>");
	writeFileSync(join(dir, "bad.svg"), "<svg/>");
	const png = pngHeader(100, 50).toString("base64");
	let converted = 0;
	const store = new ImageStore(
		() => converted++,
		async (path) => {
			if (path.endsWith("bad.svg")) throw new Error("boom");
			return png;
		},
	);
	const say = () => render("![d](d.svg)\n\n![bad](bad.svg)", 60, { dir, images: store });
	const first = say().lines.map(stripTerminalSequences).join("\n");
	assert.match(first, /🖼 d · d\.svg \(rendering/);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(converted, 2);
	const second = say();
	assert.ok(second.images.length === 1, "the converted svg is placed");
	assert.match(second.lines.map(stripTerminalSequences).join("\n"), /🖼 bad · bad\.svg \(svg: failed/);
});

test("svg: no converter on PATH says so", async () => {
	caps("kitty");
	const dir = fixtures();
	writeFileSync(join(dir, "d.svg"), "<svg/>");
	const store = new ImageStore(undefined, async () => {
		throw new Error("no converter");
	});
	render("![d](d.svg)", 60, { dir, images: store });
	await new Promise((r) => setTimeout(r, 10));
	assert.match(render("![d](d.svg)", 60, { dir, images: store }).lines.map(stripTerminalSequences).join("\n"), /svg: no converter/);
});

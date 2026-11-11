/**
 * The side panel: markdown files, one tab each, the current one rendered in a
 * bordered box the height of the terminal.
 *
 * It is shown as a **non-capturing** overlay, so it never takes the keyboard by
 * itself; the extension hands it focus on a shortcut and it gives focus back on
 * Esc. Each tab keeps its own text, file state and scroll position; the panel
 * knows nothing of files, and the controller feeds it text. Everything it
 * needs from pi is injected (the theme, the markdown theme,
 * the terminal height, whether it has focus), so it renders to plain lines in a
 * test with no terminal at all.
 *
 * Layout, for a panel `width` columns wide and `rows` tall:
 *
 *     ╭─ A.md  B.md  C.md ─ deleted ───╮     top border: tab strip (current one
 *     │ rendered markdown, scrolled    │     highlighted), current file's state
 *     │ …                              │     rows - 2 body lines, 1 column of
 *     │                                │     padding inside each side
 *     ╰─ 12–40/120 ─ … focus ──────────╯     bottom border: position, key hints
 *
 * Every line is exactly `width` columns: an overlay line that is short lets the
 * chat underneath show through, and one that is long gets cut mid-escape.
 *
 * An image (see `render.ts`) covers several body lines. Its placement goes at
 * the start of the first of them that is on screen, cut to the rows that are,
 * so it never draws over the border when scrolled half out of view. Each tab
 * has its own image store, so two tabs never share a Kitty image id; a tab that
 * is not current puts no placement in the frame, and pi-tui deletes the
 * placements of lines that change, so switching tabs leaves no image behind.
 */

import { dirname } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeyId,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { RECOMMENDED_TOKENS, type BadgeTone } from "../shared/border-badges.ts";
import { ImageStore } from "./images.ts";
import { type RenderedDoc, renderDoc } from "./render.ts";

/** What the panel shows, apart from the text itself. */
export type DocState =
	| { kind: "ok" }
	/** The file is gone (deleted, or mid-rename). The last text stays on screen. */
	| { kind: "missing" }
	/** Reading or watching failed. The last text stays on screen. */
	| { kind: "error"; message: string };

/** The keys the panel answers to, named once so the border hints can't drift from the handlers. */
export interface PanelKeys {
	/** Global: step the panel hidden → shown → focused → hidden. */
	cycle: KeyId;
}

/** One open doc. `key` identifies it to the controller (its absolute path); `name` is what the tab says. */
export interface DocTab {
	readonly key: string;
	readonly name: string;
}

interface Tab extends DocTab {
	text: string;
	state: DocState;
	/** First visible body line. Clamped at render time, since the height can change under it. */
	scroll: number;
	/** Rendered body for the last inner width and image height; cleared when the text or theme changes. */
	body?: { width: number; imageRows: number; doc: RenderedDoc };
	/** This doc's images, with Kitty ids of their own. */
	images: ImageStore;
}

export interface DocPanelOptions {
	theme: Theme;
	/** Called on construction and on every `invalidate()`, so a theme change reaches the markdown. */
	markdownTheme: () => MarkdownTheme;
	/** Terminal height; the panel renders exactly this many lines. */
	rows: () => number;
	isFocused: () => boolean;
	/** Give focus back to whatever had it before (the editor). */
	unfocus: () => void;
	/** Hide the panel without closing it. */
	hide: () => void;
	/** Close tab `index` (the `x` key). The controller owns the file watch, so it removes the tab. */
	closeTab: (index: number) => void;
	requestRender: () => void;
	keys: PanelKeys;
}

/** Lines of padding between the border and the text, each side. */
const PAD = 1;

/** An image is at most this share of the body's height, so the text around it stays in view. */
const IMAGE_HEIGHT_SHARE = 2 / 3;

const NO_BODY: RenderedDoc = { lines: [], images: [] };

export class DocPanel implements Component {
	private tabs: Tab[] = [];
	private current = 0;
	/** Body height of the last render, for page-sized scrolling between renders. */
	private bodyHeight = 1;
	private frameCache?: { key: string; lines: string[] };

	constructor(private readonly options: DocPanelOptions) {}

	/** The open docs, in tab order. */
	get docs(): readonly DocTab[] {
		return this.tabs;
	}

	/** Index of the current tab; meaningless while there are none. */
	get currentIndex(): number {
		return this.current;
	}

	/** The tab showing `key`, or -1. */
	indexOf(key: string): number {
		return this.tabs.findIndex((tab) => tab.key === key);
	}

	/**
	 * Show `key` and make it the current tab: a new tab at the end, or, if it is
	 * already open, its tab with the new text (scroll kept, as for a reload).
	 * Returns its index.
	 */
	open(key: string, name: string, text: string, state: DocState = { kind: "ok" }): number {
		let index = this.indexOf(key);
		if (index < 0) {
			// A converted image arriving later invalidates this tab's rendered body.
			const tab: Tab = { key, name, text, state, scroll: 0, images: new ImageStore(() => {
				tab.body = undefined;
				this.frameCache = undefined;
				this.options.requestRender();
			}) };
			this.tabs.push(tab);
			index = this.tabs.length - 1;
		} else {
			this.update(key, text, state);
		}
		this.select(index);
		return index;
	}

	/**
	 * New text and state for an open doc (a reload); `text` undefined keeps the
	 * last text and changes only what the border says about the file. The
	 * scroll position is kept, so a doc that is being written does not jump
	 * back to the top on every save. Unknown keys are ignored.
	 */
	update(key: string, text: string | undefined, state: DocState = { kind: "ok" }): void {
		const tab = this.tabs[this.indexOf(key)];
		if (!tab) return;
		if (text !== undefined) {
			tab.text = text;
			// Rendered again even when the text is the same: a save is also when
			// an image the doc shows gets looked at again.
			tab.body = undefined;
		}
		tab.state = state;
		this.changed();
	}

	/** Make tab `index` current; out of range is ignored. */
	select(index: number): void {
		if (index < 0 || index >= this.tabs.length) return;
		this.current = index;
		this.changed();
	}

	/** Step to the next (`1`) or previous (`-1`) tab, wrapping. */
	step(delta: number): void {
		const count = this.tabs.length;
		if (count > 1) this.select((((this.current + delta) % count) + count) % count);
	}

	/** Drop tab `index`. The current tab stays current; closing it selects its right-hand neighbour, or the new last. */
	remove(index: number): void {
		if (index < 0 || index >= this.tabs.length) return;
		this.tabs.splice(index, 1);
		if (index < this.current || this.current >= this.tabs.length) this.current = Math.max(0, this.current - 1);
		this.changed();
	}

	invalidate(): void {
		// A theme change: the markdown theme holds colour functions, so it is
		// asked for again on the next render. Images are drawn again too: pi
		// invalidates when it learns the terminal's cell size.
		for (const tab of this.tabs) {
			tab.body = undefined;
			tab.images.invalidate();
		}
		this.frameCache = undefined;
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.options.rows());
		const focused = this.options.isFocused();
		const tab = this.tabs[this.current];
		const bodyHeight = Math.max(0, rows - 2);
		const imageRows = Math.max(1, Math.floor(bodyHeight * IMAGE_HEIGHT_SHARE));
		const body = tab && width > 2 * (1 + PAD) ? this.body(tab, width - 2 * (1 + PAD), imageRows) : NO_BODY;
		this.bodyHeight = Math.max(1, bodyHeight);
		const scroll = tab ? (tab.scroll = clamp(tab.scroll, 0, Math.max(0, body.lines.length - bodyHeight))) : 0;

		const key = `${width}|${rows}|${focused}|${scroll}`;
		if (this.frameCache?.key === key) return this.frameCache.lines;

		const lines = this.frame(width, rows, focused, body, bodyHeight, scroll);
		this.frameCache = { key, lines };
		return lines;
	}

	handleInput(data: string): void {
		const { keys } = this.options;
		if (matchesKey(data, Key.escape)) {
			this.options.unfocus();
			return;
		}
		// The cycle key is taken before any component sees it (see index.ts), so
		// this only runs if that failed; focused → hidden is its step either way.
		if (matchesKey(data, keys.cycle)) {
			this.options.hide();
			return;
		}
		if (matchesKey(data, Key.tab)) return this.step(1);
		if (matchesKey(data, Key.shift("tab"))) return this.step(-1);
		if (/^[1-9]$/.test(data)) return this.select(Number(data) - 1);
		if (data === "x") {
			if (this.tabs.length > 0) this.options.closeTab(this.current);
			return;
		}
		const page = Math.max(1, this.bodyHeight - 1);
		if (matchesKey(data, Key.up) || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+b") || data === "b") this.scrollBy(-page);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+f") || data === " ") this.scrollBy(page);
		else if (matchesKey(data, Key.home) || data === "g") this.scrollTo(0);
		else if (matchesKey(data, Key.end) || data === "G") this.scrollTo(Number.MAX_SAFE_INTEGER);
		// Anything else is swallowed: typing into a focused panel should not leak
		// into some other component, and Esc is always one key away.
	}

	/** Wheel scrolling, in fullscreen mode (the only mode that reports the mouse). Never takes focus. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollBy(event.wheelDelta);
		return { handled: true };
	}

	scrollBy(lines: number): void {
		const tab = this.tabs[this.current];
		if (tab) this.scrollTo(tab.scroll + lines);
	}

	scrollTo(line: number): void {
		const tab = this.tabs[this.current];
		if (!tab) return;
		// Clamped against the last render; render() clamps again for the real height.
		const total = tab.body?.doc.lines.length ?? 0;
		const next = clamp(line, 0, Math.max(0, total - this.bodyHeight));
		if (next === tab.scroll) return;
		tab.scroll = next;
		this.options.requestRender();
	}

	private changed(): void {
		this.frameCache = undefined;
		this.options.requestRender();
	}

	/**
	 * The body of one doc, rendered `width` columns wide with images at most
	 * `imageRows` tall: the one seam between the frame and the markdown. Relative
	 * image paths start at the doc's directory (a tab's key is its path).
	 */
	private body(tab: Tab, width: number, imageRows: number): RenderedDoc {
		const cached = tab.body;
		if (cached?.width === width && cached.imageRows === imageRows) return cached.doc;
		const { theme } = this.options;
		const doc =
			tab.text.trim() === ""
				? { lines: [theme.fg("muted", "(empty file)")], images: [] }
				: renderDoc(tab.text, width, {
						theme,
						md: this.options.markdownTheme(),
						baseDir: dirname(tab.key),
						images: tab.images,
						maxImageRows: imageRows,
					});
		tab.body = { width, imageRows, doc };
		return doc;
	}

	private frame(width: number, rows: number, focused: boolean, body: RenderedDoc, bodyHeight: number, scroll: number): string[] {
		const { theme, keys } = this.options;
		const rule = (text: string) => theme.fg(focused ? "borderAccent" : "border", text);
		if (width < 4) return Array.from({ length: rows }, () => " ".repeat(width));
		const tab = this.tabs[this.current];
		const hint = (text: string) => theme.fg("dim", text);

		// Top border: the tab strip first, so the current doc's name is the last
		// thing to go; then what is wrong with the current file, if anything.
		const state = tab?.state ?? { kind: "ok" };
		const stateChip =
			state.kind === "missing"
				? this.chip("deleted · waiting", "warn")
				: state.kind === "error"
					? this.chip(state.message, "error")
					: undefined;
		// borderLine spends 4 columns on rules around a lone piece, 3 more per extra one.
		const room = width - 2 - 4;
		const stripRoom = (reserve: number) =>
			tabStrip(
				this.tabs.map((t) => t.name),
				this.current,
				room - reserve,
				(name) => this.chip(name, "label"),
				hint,
			);
		// The state chip yields its room if keeping it would cut the current name.
		const reserve = stateChip ? visibleWidth(stateChip) + 3 : 0;
		const needed = tab ? visibleWidth(tab.name) + 2 + (this.tabs.length > 1 ? `${this.tabs.length}`.length * 2 + 3 : 0) : 0;
		const strip = stripRoom(room - reserve >= needed ? reserve : 0);
		const top = [strip || this.chip("doc", "label")];
		if (stateChip) top.push(stateChip);

		// Bottom border: position, then what the keys do in this focus state.
		const total = body.lines.length;
		const first = total === 0 ? 0 : scroll + 1;
		const last = Math.min(total, scroll + bodyHeight);
		const bottom: string[] = [this.chip(`${first}–${last}/${total}`, "neutral")];
		if (focused) {
			// "esc back" first: on a narrow panel it is the hint that must survive.
			bottom.push(hint("esc back"), hint("↑↓ j/k · PgUp/PgDn · g/G"));
			if (this.tabs.length > 1) bottom.push(hint("tab/1–9 switch"));
			bottom.push(hint("x close"), hint(`${keys.cycle} hide`));
		} else {
			bottom.push(hint(`${keys.cycle} focus`));
		}

		const inner = width - 2 * (1 + PAD);
		const side = rule("│") + " ".repeat(PAD);
		const sideEnd = " ".repeat(PAD) + rule("│");
		const lines = [borderLine(width, "╭", "╮", top, rule)];
		const end = scroll + bodyHeight;
		for (let row = scroll; row < end; row++) lines.push(side + fit(bodyRow(body, row, scroll, end), inner) + sideEnd);
		if (rows >= 2) lines.push(borderLine(width, "╰", "╯", bottom, rule));
		return lines.slice(0, rows);
	}

	/** A badge painted the way the editor's badge bar paints one, so the two read alike. */
	private chip(text: string, tone: BadgeTone): string {
		const { theme } = this.options;
		const style = RECOMMENDED_TOKENS[tone];
		try {
			const body = style.bold ? theme.bold(text) : text;
			return theme.bg(
				style.bg as Parameters<Theme["bg"]>[0],
				theme.fg(style.fg as Parameters<Theme["fg"]>[0], ` ${body} `),
			);
		} catch {
			// A theme without one of the shared tokens costs the chip its colour, never the border.
			return ` ${text} `;
		}
	}
}

/**
 * The tab strip, at most `room` columns: every name if they all fit, else the
 * current tab and as many neighbours as fit, nearest first, followed by an
 * `n/m` count. The current name is the last thing to go; it is truncated
 * before it is dropped. One tab is just its name, as a panel with one doc
 * always looked. Names arrive raw; `current` and `other` paint them, and every
 * tab is padded with a space each side.
 */
export function tabStrip(
	names: readonly string[],
	current: number,
	room: number,
	paintCurrent: (name: string) => string,
	paintOther: (text: string) => string,
): string {
	// Below 3 columns not even "…" fits between the padding.
	if (names.length === 0 || room < 3) return "";
	const cell = (i: number) => (i === current ? paintCurrent(names[i]!) : paintOther(` ${names[i]} `));
	const widths = names.map((name) => visibleWidth(name) + 2);
	const total = widths.reduce((sum, w) => sum + w, 0);
	if (total <= room) return names.map((_, i) => cell(i)).join("");

	const count = paintOther(` ${current + 1}/${names.length} `);
	const countWidth = visibleWidth(count);
	let left = room - countWidth;
	// No room for the count beside even a cut name: the name alone.
	if (left < Math.min(widths[current]!, 4)) {
		return paintCurrent(truncateToWidth(names[current]!, Math.max(1, room - 2), "…"));
	}
	if (widths[current]! > left) return paintCurrent(truncateToWidth(names[current]!, left - 2, "…")) + count;

	let from = current;
	let to = current;
	left -= widths[current]!;
	for (let grew = true; grew; ) {
		grew = false;
		if (to + 1 < names.length && widths[to + 1]! <= left) {
			left -= widths[++to]!;
			grew = true;
		}
		if (from > 0 && widths[from - 1]! <= left) {
			left -= widths[--from]!;
			grew = true;
		}
	}
	let strip = "";
	for (let i = from; i <= to; i++) strip += cell(i);
	return strip + count;
}

/**
 * Body line `row` of a frame showing rows `scroll`..`end - 1`. An image's
 * placement goes on its first row on screen, cut to the rows on screen.
 */
function bodyRow(body: RenderedDoc, row: number, scroll: number, end: number): string {
	const line = body.lines[row] ?? "";
	const image = body.images.find((m) => row === Math.max(m.row, scroll) && row < m.row + m.rows);
	return image ? line + image.sequence(row - image.row, Math.min(image.row + image.rows, end) - row) : line;
}

/** Exactly `width` columns: cut with an ellipsis if long, padded with spaces if short. */
export function fit(line: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(line, width, "…", true);
}

/**
 * A border line `width` wide: `╭─ a ─ b ───╮`.
 *
 * `pieces` are painted already and given in priority order. Low-priority ones
 * are dropped whole until the rest fit; the first one is truncated rather than
 * dropped, because a border that doesn't say which file it is has lost its job.
 */
export function borderLine(
	width: number,
	left: string,
	right: string,
	pieces: readonly string[],
	rule: (text: string) => string,
): string {
	const inner = width - 2;
	if (inner <= 0) return fit(rule(left + right), width);
	// "─ " before the first piece, " ─ " between, " " after the last, then rule to the end.
	const cost = (kept: readonly string[]) =>
		kept.length === 0 ? 0 : 1 + kept.reduce((sum, piece) => sum + visibleWidth(piece) + 2, 0) + (kept.length - 1);
	let kept = [...pieces];
	while (kept.length > 1 && cost(kept) > inner - 1) kept.pop();
	if (kept.length === 1 && cost(kept) > inner - 1) {
		const room = inner - 4; // "─ " + piece + " " + at least one "─"
		kept = room >= 1 ? [truncateToWidth(kept[0]!, room, "…")] : [];
	}
	let line = "";
	kept.forEach((piece, i) => {
		line += rule(i === 0 ? "─ " : " ─ ") + piece;
	});
	if (kept.length > 0) line += " ";
	line += rule("─".repeat(Math.max(0, inner - visibleWidth(line))));
	return rule(left) + line + rule(right);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

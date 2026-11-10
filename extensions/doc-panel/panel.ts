/**
 * The side panel: one markdown file, rendered, in a bordered box the height of
 * the terminal.
 *
 * It is shown as a **non-capturing** overlay, so it never takes the keyboard by
 * itself; the extension hands it focus on a shortcut and it gives focus back on
 * Esc. Everything it needs from pi is injected (the theme, the markdown theme,
 * the terminal height, whether it has focus), so it renders to plain lines in a
 * test with no terminal at all.
 *
 * Layout, for a panel `width` columns wide and `rows` tall:
 *
 *     ╭─ NAME ─ deleted ───────────────╮     top border: file name, file state
 *     │ rendered markdown, scrolled    │     rows - 2 body lines, 1 column of
 *     │ …                              │     padding inside each side
 *     ╰─ 12–40/120 ─ alt+l scroll ─────╯     bottom border: position, key hints
 *
 * Every line is exactly `width` columns: an overlay line that is short lets the
 * chat underneath show through, and one that is long gets cut mid-escape.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeyId,
	Markdown,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { RECOMMENDED_TOKENS, type BadgeTone } from "../shared/border-badges.ts";

/** What the panel shows, apart from the text itself. */
export type DocState =
	| { kind: "ok" }
	/** The file is gone (deleted, or mid-rename). The last text stays on screen. */
	| { kind: "missing" }
	/** Reading or watching failed. The last text stays on screen. */
	| { kind: "error"; message: string };

/** The keys the panel answers to, named once so the border hints can't drift from the handlers. */
export interface PanelKeys {
	/** Global: focus the panel (and, while focused, give focus back). */
	focus: KeyId;
	/** Global: hide or show the panel. */
	toggle: KeyId;
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
	requestRender: () => void;
	keys: PanelKeys;
}

/** Lines of padding between the border and the text, each side. */
const PAD = 1;

export class DocPanel implements Component {
	private name = "";
	private text = "";
	private state: DocState = { kind: "ok" };
	private markdown: Markdown;
	/** First visible body line. Clamped at render time, since the height can change under it. */
	private scroll = 0;
	/** Body height of the last render, for page-sized scrolling between renders. */
	private bodyHeight = 1;
	/** Rendered markdown for the last inner width; cleared when the text or theme changes. */
	private bodyCache?: { width: number; lines: string[] };
	private frameCache?: { key: string; lines: string[] };

	constructor(private readonly options: DocPanelOptions) {
		this.markdown = this.makeMarkdown();
	}

	/** Show a different file. Scroll goes back to the top. */
	setDoc(name: string, text: string, state: DocState = { kind: "ok" }): void {
		this.name = name;
		this.scroll = 0;
		this.setContent(text, state);
	}

	/**
	 * New text and state for the same file (a reload). The scroll position is
	 * kept, so a doc that is being written does not jump back to the top on
	 * every save.
	 */
	setContent(text: string, state: DocState = { kind: "ok" }): void {
		if (text !== this.text) {
			this.text = text;
			this.markdown.setText(text);
			this.bodyCache = undefined;
		}
		this.state = state;
		this.frameCache = undefined;
		this.options.requestRender();
	}

	/** Keep the text, change only what the border says about the file. */
	setState(state: DocState): void {
		this.setContent(this.text, state);
	}

	invalidate(): void {
		// A theme change: the markdown theme holds colour functions, so it is
		// rebuilt rather than trusted.
		this.markdown = this.makeMarkdown();
		this.bodyCache = undefined;
		this.frameCache = undefined;
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.options.rows());
		const focused = this.options.isFocused();
		const body = width > 2 * (1 + PAD) ? this.bodyLines(width - 2 * (1 + PAD)) : [];
		const bodyHeight = Math.max(0, rows - 2);
		this.bodyHeight = Math.max(1, bodyHeight);
		this.scroll = clamp(this.scroll, 0, Math.max(0, body.length - bodyHeight));

		const key = `${width}|${rows}|${focused}|${this.scroll}`;
		if (this.frameCache?.key === key) return this.frameCache.lines;

		const lines = this.frame(width, rows, focused, body, bodyHeight);
		this.frameCache = { key, lines };
		return lines;
	}

	handleInput(data: string): void {
		const { keys } = this.options;
		if (matchesKey(data, Key.escape) || matchesKey(data, keys.focus)) {
			this.options.unfocus();
			return;
		}
		if (matchesKey(data, keys.toggle)) {
			this.options.hide();
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
		this.scrollTo(this.scroll + lines);
	}

	scrollTo(line: number): void {
		// Clamped against the last render; render() clamps again for the real height.
		const total = this.bodyCache?.lines.length ?? 0;
		const next = clamp(line, 0, Math.max(0, total - this.bodyHeight));
		if (next === this.scroll) return;
		this.scroll = next;
		this.options.requestRender();
	}

	private makeMarkdown(): Markdown {
		return new Markdown(this.text, 0, 0, this.options.markdownTheme());
	}

	private bodyLines(width: number): string[] {
		if (this.bodyCache?.width === width) return this.bodyCache.lines;
		const lines = this.text.trim() === "" ? [this.options.theme.fg("muted", "(empty file)")] : this.markdown.render(width);
		this.bodyCache = { width, lines };
		return lines;
	}

	private frame(width: number, rows: number, focused: boolean, body: string[], bodyHeight: number): string[] {
		const { theme, keys } = this.options;
		const rule = (text: string) => theme.fg(focused ? "borderAccent" : "border", text);
		if (width < 4) return Array.from({ length: rows }, () => " ".repeat(width));

		// Top border: the file name first, so it is the last thing to go.
		const top: string[] = [this.chip(this.name || "doc", "label")];
		if (this.state.kind === "missing") top.push(this.chip("deleted · waiting", "warn"));
		if (this.state.kind === "error") top.push(this.chip(this.state.message, "error"));

		// Bottom border: position, then what the keys do in this focus state.
		const first = body.length === 0 ? 0 : this.scroll + 1;
		const last = Math.min(body.length, this.scroll + bodyHeight);
		const bottom: string[] = [this.chip(`${first}–${last}/${body.length}`, "neutral")];
		const hint = (text: string) => theme.fg("dim", text);
		if (focused) {
			// "esc back" first: on a narrow panel it is the hint that must survive.
			bottom.push(hint("esc back"), hint("↑↓ j/k · PgUp/PgDn · g/G"));
		} else {
			bottom.push(hint(`${keys.focus} scroll`), hint(`${keys.toggle} hide`));
		}

		const inner = width - 2 * (1 + PAD);
		const side = rule("│") + " ".repeat(PAD);
		const sideEnd = " ".repeat(PAD) + rule("│");
		const lines = [borderLine(width, "╭", "╮", top, rule)];
		for (let i = 0; i < bodyHeight; i++) {
			const line = body[this.scroll + i] ?? "";
			lines.push(side + fit(line, inner) + sideEnd);
		}
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

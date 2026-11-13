/**
 * Mouse reports and text selection for panes that select for themselves.
 *
 * A pane that owns the mouse (the subagent chat, so the wheel scrolls it) or
 * that sits beside pi's chat (the doc panel, where pi's own selection would
 * run across both) cannot use the terminal's or pi's selection: it tracks a
 * left-button drag itself, paints the range and copies its plain text. The
 * helpers are pure, bar {@link copyToSystemClipboard}, so a pane keeps only the
 * wiring.
 *
 * Positions are in *content* coordinates — a line of the rendered transcript
 * and a visible column in it — never screen rows, so a selection stays on the
 * same text while the pane scrolls or streams underneath it.
 */

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	type TuiMouseEvent,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";

/**
 * A mouse report in the shape pi's fullscreen TUI hands to `handleMouse`, so a
 * regular-mode report parsed from raw input runs through the same handler.
 * Coordinates are zero-based cells.
 */
export type MouseReport = Pick<TuiMouseEvent, "type" | "button" | "x" | "y" | "wheelDelta">;

function decodeButton(code: number): MouseReport["button"] {
	switch (code & 3) {
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return "none";
	}
}

function report(code: number, x: number, y: number, release: boolean): MouseReport {
	if ((code & 64) !== 0) {
		// Wheel buttons: 0 is up (content moves up a line), 1 is down; 2 and 3 are
		// horizontal, which the pane has no use for.
		const direction = code & 3;
		const wheelDelta = direction === 0 ? -1 : direction === 1 ? 1 : 0;
		return { type: "wheel", button: "none", x, y, wheelDelta };
	}
	const button = decodeButton(code);
	if (release) return { type: "release", button, x, y };
	if ((code & 32) !== 0) return { type: button === "none" ? "move" : "drag", button, x, y };
	return { type: "press", button, x, y };
}

/**
 * Parse one mouse report, SGR (`ESC [ < b ; x ; y M|m`) or legacy X10
 * (`ESC [ M` and three raw bytes). `undefined` means the input is not a mouse
 * report at all.
 */
export function parseMouseReport(data: string): MouseReport | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgr) {
		const code = Number.parseInt(sgr[1]!, 10);
		const x = Number.parseInt(sgr[2]!, 10) - 1;
		const y = Number.parseInt(sgr[3]!, 10) - 1;
		return report(code, x, y, sgr[4] === "m");
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const code = data.charCodeAt(3) - 32;
		// X10 has no release flag: a release is "button 3" without motion.
		const release = (code & 64) === 0 && (code & 32) === 0 && (code & 3) === 3;
		return report(code, data.charCodeAt(4) - 33, data.charCodeAt(5) - 33, release);
	}
	return undefined;
}

/** A position in rendered content: a line index and a visible column. */
export interface TextPoint {
	line: number;
	col: number;
}

/** A selection in reading order; `end.col` is exclusive. */
export interface TextRange {
	start: TextPoint;
	end: TextPoint;
}

/** Order a drag's two ends; `undefined` when they coincide (a click, not a selection). */
export function orderRange(anchor: TextPoint, focus: TextPoint): TextRange | undefined {
	if (anchor.line === focus.line && anchor.col === focus.col) return undefined;
	const anchorFirst = anchor.line < focus.line || (anchor.line === focus.line && anchor.col < focus.col);
	return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/**
 * The columns of `line` a range covers, `[start, end)`, or `undefined` if the
 * line is outside it. Linewise in between: only the first and last lines are cut.
 */
export function rangeColumns(range: TextRange, line: number): [number, number] | undefined {
	if (line < range.start.line || line > range.end.line) return undefined;
	const start = line === range.start.line ? range.start.col : 0;
	const end = line === range.end.line ? range.end.col : Number.POSITIVE_INFINITY;
	return [start, end];
}

/** What a range copies: plain text, styles stripped, trailing pad trimmed. */
export function selectedText(lines: readonly string[], range: TextRange): string {
	const out: string[] = [];
	for (let line = range.start.line; line <= range.end.line && line < lines.length; line++) {
		const text = lines[line] ?? "";
		const [start, end] = rangeColumns(range, line)!;
		const width = Math.min(end, visibleWidth(text)) - start;
		out.push(width > 0 ? stripTerminalSequences(sliceByColumn(text, start, width, true)).trimEnd() : "");
	}
	return out.join("\n");
}

/** One terminal escape: CSI (SGR included), OSC (links) or APC (pi's cursor marker). */
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/y;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Paint columns `[start, end)` of a styled line in reverse video.
 *
 * The line is cut by column with every escape kept in order, so styles that
 * open before the range still apply after it; reverse is re-asserted after
 * each escape inside the range, since a reset there would otherwise end it.
 */
export function highlightColumns(line: string, start: number, end: number): string {
	let before = "";
	let middle = "";
	let after = "";
	let col = 0;
	const put = (piece: string, escape: boolean): void => {
		if (col < start) before += piece;
		else if (col < end) middle += escape ? `${piece}\x1b[7m` : piece;
		else after += piece;
	};
	let i = 0;
	while (i < line.length) {
		ESCAPE.lastIndex = i;
		const escape = ESCAPE.exec(line);
		if (escape) {
			put(escape[0], true);
			i += escape[0].length;
			continue;
		}
		let next = line.indexOf("\x1b", i + 1);
		if (next < 0) next = line.length;
		for (const { segment } of graphemes.segment(line.slice(i, next))) {
			put(segment, false);
			col += visibleWidth(segment);
		}
		i = next;
	}
	return middle ? `${before}\x1b[7m${middle}\x1b[27m${after}` : line;
}

/** The OSC 52 sequence that puts `text` on the system clipboard. */
export function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** How long a failed copy's message stays up; pi's fullscreen selection uses the same. */
const COPY_ERROR_FLASH_MS = 5000;

/** The part of a TUI a copy reports to: pi's fullscreen renderer has `flash`, the regular one has not. */
interface CopyReporter {
	flash?: (message: string, durationMs?: number) => void;
}

/**
 * Put `text` on the system clipboard the way pi copies its own fullscreen
 * selection: pi's `copyToClipboard` (the native clipboard or a platform tool,
 * OSC 52 only where nothing better exists), then "Copied!" or the error in the
 * renderer's flash, where it has one. Resolves to whether it copied; never
 * rejects. `copy` is for tests.
 */
export async function copyToSystemClipboard(
	tui: unknown,
	text: string,
	copy: (text: string) => Promise<void> = copyToClipboard,
): Promise<boolean> {
	if (!text) return false;
	const flash = (tui as CopyReporter | undefined)?.flash;
	const report = (message: string, durationMs?: number): void => {
		try {
			if (typeof flash === "function") flash.call(tui, message, durationMs);
		} catch {
			// A torn-down renderer cannot show the message; the copy stands.
		}
	};
	try {
		await copy(text);
		report("Copied!");
		return true;
	} catch (error) {
		report(error instanceof Error ? error.message : String(error), COPY_ERROR_FLASH_MS);
		return false;
	}
}

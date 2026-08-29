/**
 * Laying badges into the editor's top border.
 *
 * The footer status line is one line shared by every extension, and it was
 * filling up. The editor already draws a horizontal rule around the input box,
 * that rule is otherwise empty, and it is *closer to where the eye already is* —
 * so that is where the badges go.
 *
 * Of the four corners of that box the badges take the **top right**, and both
 * halves of that are deliberate:
 *
 *   - **Top**, because the bottom rule is the last thing between the input and
 *     the footer, and stacking two rows of status information there rebuilds the
 *     crowding this was meant to relieve. The top rule separates the input from
 *     the transcript, so a bar there reads as a header for the box rather than
 *     as more footer.
 *   - **Right**, because the left edge of the box is where the text starts and
 *     where the eye tracks while typing — and because pi's own scroll indicator
 *     is anchored hard left. Putting the badges at the far end means the two
 *     want different columns, which is what lets them share a line at all (see
 *     {@link borderSlot}).
 *
 * Only the extension that owns `ctx.ui.setEditorComponent()` can draw there (it
 * is a single slot; the last caller silently wins), so publishers put badges in
 * `shared/border-badges.ts` and this module turns them into a line. Everything
 * here is pure: it takes a `BarPainter` of plain string functions rather than a
 * theme or a TUI, so every layout decision below is testable without a terminal.
 *
 * ## The alignment maths
 *
 * One line, `width` columns, laid out right to left:
 *
 * ```
 * │←──────────── leading ────────────→│   │←── used ──→│   │←TRAIL_RULE→│
 *  ─────────────────────────────────── ␠  « mcp » « 2/2 » ␠ ───
 *                                    SIDE_GAP↑        SIDE_GAP↑
 * ```
 *
 * `leading` is the only free variable, and it is *derived* rather than chosen:
 *
 * ```
 * leading = width - SIDE_GAP*2 - used - TRAIL_RULE
 * ```
 *
 * so the four terms sum back to `width` by construction. The fitting loop keeps
 * `used` inside `budget = width - MIN_LEAD_RULE - SIDE_GAP*2 - TRAIL_RULE`, which
 * is the same statement rearranged into `leading >= MIN_LEAD_RULE`: there is
 * always a visible run of rule before the first chip, never a bar that starts in
 * the corner and reads as a line of output rather than a border.
 *
 * ## Wide glyphs, and which way the error leans
 *
 * Badge text is not ASCII — `🤖` is East Asian Wide and occupies two cells — so
 * every measurement here goes through `BarPainter.width` (`visibleWidth` in
 * practice) and never `.length`. That `🤖` happens to have `.length === 2` as well
 * is a coincidence of it being a bare surrogate pair, and it does not generalise:
 * an emoji with a variation selector or a ZWJ sequence has a `.length` several
 * times its width, and `❓` is `.length` 1 and two cells wide.
 *
 * The residual risk is a terminal that disagrees with Unicode and advances `🤖`
 * by one cell. Nothing in this process can detect that, so the layout is arranged
 * so the error can only lean the safe way. Right alignment does not change the
 * conclusion, but it does change the argument, so it is re-derived here rather
 * than inherited from the left-aligned version this replaced:
 *
 *   - `visibleWidth` reports the Unicode **maximum** (2), so `used` is an
 *     *over*-estimate of the columns the chips will really occupy.
 *   - `leading` is `width - … - used - …`, i.e. `used` enters it negatively, so
 *     over-estimating `used` makes `leading` **smaller**. The filler moving from
 *     the right of the chips to their left does not flip that sign — both
 *     layouts derive their filler by subtracting `used` from `width`.
 *   - So the line comes out *short*: the leading rule and the trailing `───` are
 *     drawn exactly as computed, the chips between them take fewer columns than
 *     reserved, and the row ends one column before the terminal's edge. A ragged
 *     right edge, and nothing more.
 *   - The opposite error, a line one column too **long**, is the one that wraps
 *     and corrupts every frame after it. Reserving the maximum is what makes it
 *     unreachable, and {@link MIN_LEAD_RULE} leaves slack on top.
 *
 * `tests/badge-bar.test.ts` pins `visibleWidth("🤖") === 2`, so a pi-tui upgrade
 * that changed the answer would fail loudly here rather than quietly skew a
 * border nobody is measuring.
 *
 * ## Finding the border, and sharing it with the scroll indicator
 *
 * pi's editor renders `[topBorder, ...visibleLines, bottomBorder, ...autocomplete]`,
 * so the top border is `lines[0]` today — but that is an implementation detail of
 * a class outside this repo, and the tail of that array already grows a
 * completion menu. {@link borderSlot} therefore *matches* the border rather than
 * indexing to it, from whichever end it was asked for.
 *
 * The interesting case is pi replacing a border with `─── ↑ 3 more ─────` when
 * the input is taller than the box. That indicator is anchored left and the bar
 * is anchored right, so unlike the left-aligned version of this bar the two do
 * not want the same columns: `borderSlot` hands back the indicator as a `lead`
 * to preserve, the bar composes into the columns after it, and both survive. If
 * the residual width is too small for even one chip the composer returns
 * `undefined` and the indicator is left exactly as pi drew it — losing "3 more"
 * is a far worse trade than losing a badge row.
 */

import type { BadgeGroup, StatusBadge } from "../shared/border-badges.ts";

/**
 * Rule characters after the last badge.
 *
 * Three, because that is what pi's own scroll indicator puts *before* its
 * content (`─── ↓ 3 more `) and this is the same border, mirrored: a bar that
 * ran to the last column would read as a different kind of thing from the
 * indicator it shares the line with.
 */
export const TRAIL_RULE = 3;

/**
 * Rule characters that must survive before the first badge.
 *
 * Without a few, a full-width bar stops looking like a border and starts looking
 * like a line of output that happens to be above the input box. It is also what
 * guarantees a gap when the bar shares its line with a scroll indicator: the
 * indicator can never be closer than `MIN_LEAD_RULE + SIDE_GAP` columns to the
 * first chip, so "bail before they touch" needs no separate check.
 */
export const MIN_LEAD_RULE = 4;

/**
 * Blank columns between the rule and the badges, on each side.
 *
 * pi's own indicator reads `─── ↓ 3 more ───`, with the content held off the rule
 * by a space at each end, and the bar is drawn in the same border by the same
 * logic. Without it the first chip's background butts straight into the rule and
 * the two read as one smeared glyph — and with colour switched off it is worse
 * still: `───mcp · 3/4───` has no visible boundary at all.
 */
const SIDE_GAP = 1;

/**
 * pi's scroll indicator, with the theming taken off.
 *
 * `createScrollBorder` (pi-tui `components/editor.js`) builds exactly
 * `` `─── ${direction} ${hiddenLineCount} more ` `` and pads the remainder with
 * rule characters, so the capture group is the run that must be preserved. The
 * `─*$` tail is what makes this safe to run over ordinary content lines while
 * scanning: pi pads those with **spaces** to the content width, so a line of the
 * user's own text cannot match unless they typed the indicator verbatim *and*
 * filled the rest of the row with box-drawing characters.
 *
 * When the border is too narrow for even the indicator, pi truncates it and ends
 * the line with `...`; that does not match, so the bar stays away — which is the
 * right answer anyway, since there is no room for it there.
 */
const SCROLL_INDICATOR = /^(─── [↑↓] \d+ more )─*$/;

/** Which of the editor's two horizontal rules to look for. */
export type BorderEnd = "top" | "bottom";

/** Everything the composer needs from a theme, as plain string functions. */
export interface BarPainter {
	/** Paint border rule characters. `Editor.borderColor` in practice. */
	rule(text: string): string;
	/**
	 * Paint one badge, **including whatever padding it wants inside its own
	 * background**. Returns the text unchanged when the theme cannot paint.
	 *
	 * The split is the one `StatusBadge.text` already describes: a publisher's text
	 * is unpadded, and how much whitespace survives around a chip depends on where
	 * it is drawn. So the composer owns the space *between* chips and the painter
	 * owns the space *inside* them — which is also what lets this renderer produce
	 * a chip byte-identical to the one `extensions/mcp` draws on the status line.
	 */
	chip(badge: StatusBadge): string;
	/**
	 * Visible width of a themed string, ignoring escape sequences.
	 *
	 * Injected rather than imported so the pure tests can use `.length` on
	 * unthemed strings, and so this module needs no pi-tui import.
	 */
	width(text: string): number;
	/**
	 * Whether `chip` actually paints.
	 *
	 * When it does not — a theme with colour compiled out, a stub — the chips have
	 * no backgrounds to separate them, and ` mcp  2/2  91 tools ` collapses into a
	 * run of words. So the composer joins with a visible `·` instead. The editor
	 * border has no whitespace-collapsing rule (pi's footer does), which is why
	 * this fallback can be nicer here than the sentence `extensions/mcp` falls
	 * back to on the status line.
	 */
	paints: boolean;
}

/** Where the bar may draw, and what it must draw around. */
export interface BorderSlot {
	/** Index into the lines the editor returned. */
	readonly index: number;
	/**
	 * Plain text that has to survive at the head of that line, or `""` when the
	 * whole line is the bar's to use.
	 *
	 * Non-empty only for pi's scroll indicator. It is handed back **unthemed** on
	 * purpose: the caller owns `borderColor` and re-paints it, so this module
	 * never has to slice inside an escape sequence — the single most likely way to
	 * corrupt a frame while trying to decorate one.
	 */
	readonly lead: string;
}

/**
 * Where to put the bar on one of the editor's borders, or `undefined` to leave
 * the frame alone.
 *
 * `plainRule` is the exact string the editor pushes for an unscrolled border —
 * `borderColor("─").repeat(width)`, note per-character theming, which is why
 * that has to be an exact comparison rather than a regex over the stripped text.
 *
 * Each end scans from its own side and stops one line short of the far end of
 * the array, which is what keeps the two rules apart even in a one-line editor
 * where they are adjacent and identical strings. Scanning rather than indexing
 * also means:
 *
 *   - the completion menu, drawn *after* the bottom border, is skipped by a
 *     `"bottom"` search;
 *   - a `"top"` search still finds the top rule if pi ever prepends a line, and
 *     in practice matches at index 0 on the first comparison, because pi's top
 *     border is always either the plain rule or the indicator.
 *
 * `plainText` strips terminal escapes; it is only consulted for the scroll
 * indicator, since the plain-rule test is an exact match on the themed string.
 * It defaults to the identity function so the pure tests can pass unthemed lines.
 *
 * The one way to fool this is a theme whose `borderColor` is the identity
 * function *and* a user whose input happens to be a full row of `─` with padding
 * switched off. The cost is one frame of badges over one line of their text,
 * which is not worth defending against with anything more elaborate.
 */
export function borderSlot(
	lines: readonly string[],
	plainRule: string,
	end: BorderEnd,
	plainText: (line: string) => string = (line) => line,
): BorderSlot | undefined {
	if (plainRule.length === 0) return undefined;
	const last = lines.length - 1;
	const top = end === "top";
	const stop = top ? last - 1 : 1;
	const step = top ? 1 : -1;
	for (let index = top ? 0 : last; top ? index <= stop : index >= stop; index += step) {
		const line = lines[index];
		if (line === undefined) continue;
		if (line === plainRule) return { index, lead: "" };
		const scrolled = SCROLL_INDICATOR.exec(plainText(line));
		if (scrolled) return { index, lead: scrolled[1]! };
	}
	return undefined;
}

/**
 * The badge bar as one line exactly `width` visible columns wide.
 *
 * Returns `undefined` when there is nothing to draw or no room to draw it in,
 * which the caller treats as "leave the border alone" — never as an error. When
 * the bar is sharing its line with a scroll indicator, `width` is the *residual*
 * width after that indicator, and `undefined` is how "they would touch" is
 * reported: the fitting budget below is what makes room for both or for neither.
 *
 * ## What is dropped when it does not fit
 *
 * Badges go in publisher order and are dropped **from the end**, with a `…`
 * marking the truncation. That order is not arbitrary: every publisher leads
 * with a `label` chip naming itself and follows it with its headline, and by
 * `status.ts`'s own rule the headline chip already carries the worst news in its
 * tone. So a narrow terminal loses the detail (`1 failed`) but keeps the chip
 * that is coloured *because* something failed. Dropping from the front would
 * lose both the subject and the alarm and keep the trivia.
 *
 * Note that dropping from the end survives the move to right alignment
 * unchanged: what the reader loses is still the least urgent chip, and the `…`
 * still sits where the dropped badges would have been.
 */
export function composeBar(
	groups: readonly BadgeGroup[],
	width: number,
	painter: BarPainter,
): string | undefined {
	if (width <= 0) return undefined;

	// Flattened with a gap marker between publishers. Two spaces rather than one,
	// so that `mcp 3/4 27 tools` and the next extension's chips do not read as one
	// long run — the `label` tone anchors each group, and the wider gap is what
	// makes the anchor visible at a glance.
	const items: Array<{ badge: StatusBadge; gapBefore: number }> = [];
	for (const group of groups) {
		for (const [index, badge] of group.badges.entries()) {
			items.push({ badge, gapBefore: index === 0 && items.length > 0 ? 2 : items.length > 0 ? 1 : 0 });
		}
	}
	if (items.length === 0) return undefined;

	// A theme that paints nothing has no backgrounds to separate the chips, so the
	// separator has to be visible. See `BarPainter.paints`.
	const separator = painter.paints ? " " : " · ";

	const budget = width - MIN_LEAD_RULE - SIDE_GAP * 2 - TRAIL_RULE;
	if (budget <= 0) return undefined;

	const kept: Array<{ text: string; cost: number }> = [];
	let used = 0;
	let dropped = false;
	for (const [index, item] of items.entries()) {
		const gap = index === 0 ? "" : painter.paints ? " ".repeat(item.gapBefore) : separator;
		const text = gap + painter.chip(item.badge);
		const cost = painter.width(text);
		if (used + cost > budget) {
			dropped = true;
			break;
		}
		kept.push({ text, cost });
		used += cost;
	}

	if (dropped) {
		// Make room for the marker by giving back badges, rather than dropping it when
		// it does not fit. A truncation the reader cannot see is the one genuinely bad
		// outcome here: `mcp 3/4` with nothing after it is indistinguishable from a
		// healthy install, so a silently dropped `1 failed` does not merely lose
		// detail, it asserts something false.
		const marker = painter.rule("…");
		const markerCost = painter.width("…");
		while (kept.length > 0 && used + markerCost > budget) {
			used -= kept.pop()!.cost;
		}
		if (kept.length > 0) {
			kept.push({ text: marker, cost: markerCost });
			used += markerCost;
		}
	}

	// Nothing fitted at all: a lone `…` in a border says less than an untouched
	// border does, so leave it alone entirely.
	if (kept.length === 0) return undefined;
	const body = kept.map((piece) => piece.text).join("");

	const leading = width - SIDE_GAP * 2 - used - TRAIL_RULE;
	// Checked rather than clamped, and the asymmetry is deliberate. Clamping a
	// negative to zero would emit a line *wider* than the border it replaces, which
	// wraps and corrupts every frame after it; abandoning the bar leaves a plain
	// rule (or an untouched scroll indicator), which nobody notices. The fitting
	// loop above already bounds `used` — so this holds `leading >= MIN_LEAD_RULE`
	// in practice and is defence against a future edit rather than a live case —
	// but it is the one branch where being wrong is expensive, so it is not left to
	// inference.
	if (leading < 0) return undefined;
	// The gaps go inside the themed runs rather than beside them, so the whole
	// non-badge part of the line is one colour and there is no bare space at the
	// seam for a background-setting theme to leave a hole in.
	return (
		painter.rule(`${"─".repeat(leading)}${" ".repeat(SIDE_GAP)}`) +
		body +
		painter.rule(`${" ".repeat(SIDE_GAP)}${"─".repeat(TRAIL_RULE)}`)
	);
}

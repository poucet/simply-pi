/**
 * Laying badges into the right-hand end of the editor's top border.
 *
 * Two halves, tested two ways. The layout is pure and is driven here with
 * identity painters, so every assertion is about columns rather than about
 * colour. The *seam* — which line of pi's editor output is the border, and what
 * happens when a scroll indicator is sitting in it — is exercised against the
 * real `Editor` in `editor.test.ts`, because a hand-rolled fake of that output
 * would be a fake of exactly the thing that can change under us.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { BadgeGroup } from "../../shared/border-badges.ts";
import { AGENT_GLYPH, UNREAD_GLYPH } from "../notify.ts";
import { MIN_LEAD_RULE, TRAIL_RULE, borderSlot, composeBar } from "../badge-bar.ts";

/** Identity painter: no colour, so `.length` is the visible width. */
const plain = {
	rule: (text: string) => text,
	chip: (badge: { text: string }) => badge.text,
	width: (text: string) => text.length,
	paints: false,
};

/**
 * A painter that "paints" with markers a human can read in a diff.
 *
 * `[…]` stands in for the background+foreground escape sequences, and is counted
 * as zero columns — which is the property that matters, since counting escapes
 * as width is exactly how a bar overflows its line.
 */
const painted = {
	rule: (text: string) => text,
	// The painter owns the padding inside its own background, exactly as the real
	// one does; `[`/`]` stand in for the escape sequences and cost no columns.
	chip: (badge: { text: string }) => `[ ${badge.text} ]`,
	width: (text: string) => text.replace(/[[\]]/g, "").length,
	paints: true,
};

/**
 * The painter for anything carrying a wide glyph.
 *
 * Colourless like `plain`, but measured in **cells** rather than characters, so
 * a badge whose `.length` and width disagree is laid out the way the terminal
 * will actually draw it.
 */
const cells = {
	rule: (text: string) => text,
	chip: (badge: { text: string }) => ` ${badge.text} `,
	width: visibleWidth,
	paints: true,
};

const group = (source: string, ...badges: Array<[string, string]>): BadgeGroup => ({
	source,
	badges: badges.map(([text, tone]) => ({ text, tone: tone as never })),
});

const mcp = group("mcp", ["mcp", "label"], ["3/4", "ok"], ["27 tools", "neutral"]);

/**
 * The same install with a server switched off.
 *
 * `extensions/mcp` folds its disabled count into the ratio chip as `3/4·1`
 * rather than publishing a separate `1 off` badge, so the headline chip is
 * sometimes two columns wider than the sweeps above assume. `·` is U+00B7 — one
 * code unit, one cell — but that is exactly the sort of assumption this file
 * exists to check rather than make, so it is swept and pinned below.
 */
const mcpWithOff = group("mcp", ["mcp", "label"], ["3/4·1", "ok"], ["27 tools", "neutral"]);

/** The same install with something wrong, i.e. one badge wider than fits. */
const mcpFailing = group(
	"mcp",
	["mcp", "label"],
	["3/4", "error"],
	["27 tools", "neutral"],
	["1 failed", "error"],
);

/** Columns of rule before the first chip — the bar's only free variable. */
const leadingRule = (bar: string): number => /^─*/.exec(bar)![0].length;

test("the bar is exactly as wide as the border it replaces", () => {
	// The single most important property here. A line one column too long wraps,
	// and every frame drawn after it is corrupt — so this is checked across a
	// range of widths rather than at one convenient number.
	for (const width of [20, 24, 40, 60, 80, 100, 200]) {
		const bar = composeBar([mcp], width, plain);
		assert.equal(plain.width(bar!), width, `width ${width}`);
	}
});

test("escape sequences are not columns", () => {
	// The same widths, but with a painter whose output is longer than it looks.
	// Measuring with `.length` here would silently produce short bars.
	for (const width of [24, 40, 80]) {
		const bar = composeBar([mcp], width, painted);
		assert.equal(painted.width(bar!), width, `width ${width}`);
		assert.ok(bar!.length > width, "the test painter should be adding invisible characters");
	}
});

test("the badges sit at the right-hand end, held off the rule at both ends", () => {
	// Right-aligned: the *leading* rule is the long one and absorbs the slack, and
	// a short fixed run survives after the last chip so the pills are not jammed
	// into the terminal's corner. `───` mirrors what pi's own scroll indicator puts
	// in front of its content, which shares this border.
	const bar = composeBar([mcp], 40, plain)!;
	assert.equal(bar, "─────────────── mcp · 3/4 · 27 tools ───");
	assert.ok(bar.endsWith(` ${"─".repeat(TRAIL_RULE)}`));
	assert.ok(leadingRule(bar) >= MIN_LEAD_RULE);
});

test("every column the badges do not use goes into the leading rule", () => {
	// The alignment maths, stated as the invariant it is: widen the border by one
	// and the extra column appears on the left, never on the right. Swept from the
	// narrowest width that still holds every chip, since below that the badges are
	// being dropped and the body is no longer a fixed size.
	const body = "mcp · 3/4 · 27 tools";
	for (let width = body.length + MIN_LEAD_RULE + 2 + TRAIL_RULE; width <= 60; width++) {
		const bar = composeBar([mcp], width, plain)!;
		assert.equal(plain.width(bar), width, `width ${width}`);
		assert.equal(bar, `${"─".repeat(width - body.length - 2 - TRAIL_RULE)} ${body} ${"─".repeat(TRAIL_RULE)}`);
		assert.ok(leadingRule(bar) >= MIN_LEAD_RULE, `width ${width}`);
	}
});

test("a theme that paints gets spaces, one that does not gets a visible separator", () => {
	// With backgrounds the chips separate themselves. Without them ` mcp  3/4 ` is
	// a run of words, so the separator has to be something you can see. The editor
	// border can afford that; pi's footer collapses runs of spaces, which is why
	// `extensions/mcp` cannot do the same thing there.
	assert.match(composeBar([mcp], 40, plain)!, /mcp · 3\/4 · 27 tools/);
	assert.match(composeBar([mcp], 40, painted)!, /\[ mcp \] \[ 3\/4 \]/);
});

test("publishers are separated more widely than their own badges", () => {
	// The `label` chip anchors each group; a single space everywhere would let two
	// extensions' chips read as one long run.
	const bar = composeBar([mcp, group("subagents", ["subagents", "label"], ["1 running", "neutral"])], 80, painted)!;
	assert.match(bar, /\[ 27 tools \] {2}\[ subagents \]/);
});

test("a narrow bar drops trailing badges and says that it did", () => {
	// Dropping from the end keeps the label and the headline. By `status.ts`'s own
	// rule the headline chip already carries the worst news in its *tone*, so what
	// is lost is detail rather than the alarm — and right alignment does not change
	// that: the `…` still marks the place the dropped chips would have taken.
	const bar = composeBar([mcpFailing], 30, plain)!;
	assert.equal(bar, "──── mcp · 3/4 · 27 tools… ───");
	assert.equal(plain.width(bar), 30);
	// The narrowest bar there is still keeps its minimum run of rule in front.
	assert.equal(leadingRule(bar), MIN_LEAD_RULE);
	// Wide enough for everything: no marker, because nothing was lost.
	assert.ok(!composeBar([mcpFailing], 60, plain)!.includes("…"));
});

test("the truncation marker is never itself dropped", () => {
	// The one genuinely bad outcome: `mcp 3/4` with nothing after it is
	// indistinguishable from a healthy install, so a silent drop does not merely
	// lose detail, it asserts something false. When the marker will not fit,
	// another badge is given back to make room for it.
	for (let width = 12; width <= 60; width++) {
		const bar = composeBar([mcpFailing], width, plain);
		if (bar === undefined) continue;
		assert.equal(plain.width(bar), width, `width ${width}`);
		const complete = bar.includes("1 failed");
		assert.ok(complete || bar.includes("…"), `width ${width} dropped a badge silently: ${bar}`);
	}
});

test("a border too narrow for even one badge is left alone", () => {
	// `undefined` means "do not touch the border". A lone `…` in a rule says less
	// than the plain rule it replaced.
	for (const width of [0, 1, 4, 8, 11]) {
		assert.equal(composeBar([mcp], width, plain), undefined, `width ${width}`);
	}
});

test("nothing published means nothing drawn", () => {
	assert.equal(composeBar([], 80, plain), undefined);
	assert.equal(composeBar([{ source: "mcp", badges: [] }], 80, plain), undefined);
});

test("a negative width cannot produce a line at all", () => {
	// `repeat` throws on a negative count, and a throw inside render would cost
	// the user their input box rather than a badge.
	assert.equal(composeBar([mcp], -1, plain), undefined);
});

// --- finding the border ----------------------------------------------------

const RULE = "─".repeat(10);

test("the top border is the first exact match, never the bottom one", () => {
	// pi renders [top, ...content, bottom, ...completions]; the bottom border is an
	// identical string, so a search that ran off the end would paint the wrong line.
	assert.deepEqual(borderSlot([RULE, "text      ", RULE], RULE, "top"), { index: 0, lead: "" });
	// A one-line editor has both borders adjacent and still must pick the first.
	assert.deepEqual(borderSlot([RULE, RULE], RULE, "top"), { index: 0, lead: "" });
});

test("the same function finds the bottom border from the other end", () => {
	// The end is a parameter rather than a second copy of the scan, so the two can
	// never drift apart. Nothing renders into the bottom border today; keeping the
	// direction tested is what makes moving back a parameter change.
	assert.deepEqual(borderSlot([RULE, "text      ", RULE], RULE, "bottom"), { index: 2, lead: "" });
	assert.deepEqual(borderSlot([RULE, RULE], RULE, "bottom"), { index: 1, lead: "" });
});

test("a completion menu below the border does not steal the match", () => {
	const lines = [RULE, "text      ", RULE, " /agents  ", " /model   "];
	assert.deepEqual(borderSlot(lines, RULE, "top"), { index: 0, lead: "" });
	// From the other end the completion rows are skipped rather than matched: they
	// are padded content and never pass through `borderColor`.
	assert.deepEqual(borderSlot(lines, RULE, "bottom"), { index: 2, lead: "" });
});

test("a scroll indicator is kept and drawn around, not painted over", () => {
	// The collision, and it is no longer one. The indicator is anchored left and
	// the badges are anchored right, so the lookup hands back the indicator as a
	// `lead` for the caller to re-theme, and the bar composes into what is left.
	assert.deepEqual(borderSlot(["─── ↑ 8 more ─", "text      ", RULE], RULE, "top"), {
		index: 0,
		lead: "─── ↑ 8 more ",
	});
	// Same for the downward one, so the direction stays a parameter here too.
	assert.deepEqual(borderSlot([RULE, "text      ", "─── ↓ 3 more ─"], RULE, "bottom"), {
		index: 2,
		lead: "─── ↓ 3 more ",
	});
	// An unscrolled border on the other side is still just a rule.
	assert.deepEqual(borderSlot(["─── ↑ 8 more ─", "text      ", RULE], RULE, "bottom"), {
		index: 2,
		lead: "",
	});
});

test("an indicator pi had to truncate is left entirely alone", () => {
	// Below about fourteen columns `createScrollBorder` cuts its own text and ends
	// the line with `...`. There is no free space to compose into, and no reliable
	// prefix to preserve, so the bar does not draw at all.
	assert.equal(borderSlot(["─── ↑ 3 mo...", "text  ", RULE], RULE, "top"), undefined);
});

test("the indicator match runs on stripped text, not on escape sequences", () => {
	// The themed line carries colour around the whole run, so the pattern has to be
	// applied to the plain text; the `lead` handed back is plain for the same
	// reason — the caller re-paints it rather than slicing inside an escape.
	const themed = `\x1b[2m${"─── ↑ 3 more ───"}\x1b[22m`;
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	assert.deepEqual(borderSlot([themed, "text  ", RULE], RULE, "top", strip), {
		index: 0,
		lead: "─── ↑ 3 more ",
	});
	// Without the stripper the escapes are part of the string and nothing matches,
	// which is the safe direction: no bar rather than a mangled one.
	assert.equal(borderSlot([themed, "text  ", RULE], RULE, "top"), undefined);
});

test("an empty rule never matches anything", () => {
	// `width` of zero makes the plain rule the empty string, which would otherwise
	// match a blank line and splice a bar into the middle of the editor.
	assert.equal(borderSlot(["", "", ""], "", "top"), undefined);
	assert.equal(borderSlot(["", "", ""], "", "bottom"), undefined);
});

// --- sharing the line with the scroll indicator -----------------------------

test("indicator and badges together are exactly the border's width, and never touch", () => {
	// The whole point of moving to the right-hand end. `lead` costs its own
	// columns, the bar composes into the rest, and the sum has to land on the nose
	// at every width — an off-by-one here wraps the frame, and a too-eager fit
	// overwrites the only sign the user's text continues above the fold.
	const indicator = "─── ↑ 12 more ";
	const lead = visibleWidth(indicator);
	for (let width = 16; width <= 120; width++) {
		const bar = composeBar([mcp], width - lead, cells);
		if (bar === undefined) continue;
		assert.equal(lead + visibleWidth(bar), width, `width ${width}`);
		// The composer's own minimum run of rule is the gap: there is no separate
		// "do they collide" check, because there cannot be a bar without one.
		assert.ok(leadingRule(bar) >= MIN_LEAD_RULE, `width ${width} crowded the indicator: ${bar}`);
	}
});

test("no room beside the indicator means the indicator keeps the whole line", () => {
	// Losing "3 more" is a worse trade than losing badges, so the narrow case has
	// to come back as `undefined` rather than as a squeezed bar.
	const lead = visibleWidth("─── ↑ 12 more ");
	for (let width = 1; width < lead + 9; width++) {
		assert.equal(composeBar([mcp], width - lead, cells), undefined, `width ${width}`);
	}
});

// --- wide glyphs -----------------------------------------------------------

test("visibleWidth reports the robot as two cells", () => {
	// Pinned, not assumed. The whole bar's padding is derived from this number, so
	// a pi-tui upgrade that changed it would silently skew every border that
	// carries the subagents badge. Failing here is how that gets noticed.
	assert.equal(visibleWidth(AGENT_GLYPH), 2, "🤖 is East Asian Wide");
	assert.equal(visibleWidth(`${AGENT_GLYPH} 2`), 4);
	assert.equal(visibleWidth(` ${AGENT_GLYPH} 2 `), 6);
	// The unread marker is unambiguous in every terminal, which is why the second
	// chip is not also a wide glyph.
	assert.equal(visibleWidth(UNREAD_GLYPH), 1);
});

test("`.length` agreeing with the width here is luck, not licence", () => {
	// `🤖` is a bare surrogate pair, so the two agree by accident. `❓` is one code
	// unit and two cells; a ZWJ sequence is many code units and two cells. This is
	// the assertion that stops someone "simplifying" the composer to `.length`.
	assert.equal(AGENT_GLYPH.length, visibleWidth(AGENT_GLYPH), "the coincidence this test exists for");
	assert.notEqual("❓".length, visibleWidth("❓"), "…and the counter-example that breaks it");
	assert.notEqual("👩‍💻".length, visibleWidth("👩‍💻"));
});

test("a bar carrying a wide glyph is still exactly the border's width", () => {
	// Measured in cells, not characters: if the composer ever counted the robot as
	// one column the line would come out a column short, and as three it would
	// wrap. Swept rather than spot-checked because an off-by-one only shows up at
	// some widths.
	const robot: BadgeGroup = {
		source: "subagents",
		badges: [{ text: `${AGENT_GLYPH} 2`, tone: "ok" }],
	};
	for (let width = 16; width <= 100; width++) {
		const bar = composeBar([robot], width, cells);
		assert.equal(visibleWidth(bar!), width, `width ${width}`);
		// Right alignment moves the slack to the other side, so the sweep has to
		// check that side too: the fixed run after the chips is what stops them
		// being drawn into the terminal's last column.
		assert.ok(bar!.endsWith(` ${"─".repeat(TRAIL_RULE)}`), `width ${width}`);
	}
});

// --- the folded off-count in mcp's ratio chip -------------------------------

test("the interpunct in a folded ratio is one column, not zero and not two", () => {
	// Pinned rather than assumed. Every column of the bar is derived from this
	// number, and a separator the composer measured wrongly would skew the border
	// only on the installs that happen to have a server switched off — the hardest
	// kind of layout bug to notice.
	assert.equal(visibleWidth("·"), 1);
	assert.equal(visibleWidth("3/4·1"), 5);
	assert.equal(visibleWidth("3/4·12"), 6);
});

test("a folded off-count widens the chip without moving the right-hand edge", () => {
	// The chip mcp publishes when something is disabled is wider than the plain
	// ratio, so the bar has to absorb the difference in the *leading* rule and
	// nowhere else. Swept, because an off-by-one from the extra columns would only
	// show up at the widths where the fit is tight.
	for (let width = 16; width <= 120; width++) {
		const bar = composeBar([mcpWithOff], width, cells);
		if (bar === undefined) continue;
		assert.equal(visibleWidth(bar), width, `width ${width}`);
		assert.ok(bar.endsWith(` ${"─".repeat(TRAIL_RULE)}`), `width ${width}`);
		assert.ok(leadingRule(bar) >= MIN_LEAD_RULE, `width ${width}`);
	}
	// Two columns wider than the same install with nothing disabled, taken out of
	// the leading rule — the badges stay anchored to the right-hand end.
	const plainBar = composeBar([mcp], 40, cells)!;
	const foldedBar = composeBar([mcpWithOff], 40, cells)!;
	assert.equal(leadingRule(foldedBar), leadingRule(plainBar) - 2);
});

test("a folded ratio next to a wide glyph still lands on the exact width", () => {
	// The two widenings that do not come from `.length` — an extra separator and a
	// double-width glyph — in the same bar, since they are measured by different
	// parts of `visibleWidth` and could plausibly be got wrong independently.
	const both: BadgeGroup[] = [
		mcpWithOff,
		group("subagents", [`${AGENT_GLYPH} 2`, "warn"], [`${UNREAD_GLYPH} 3`, "neutral"]),
	];
	for (let width = 20; width <= 120; width++) {
		const bar = composeBar(both, width, cells);
		if (bar === undefined) continue;
		assert.equal(visibleWidth(bar), width, `width ${width}`);
		assert.ok(leadingRule(bar) >= MIN_LEAD_RULE, `width ${width}`);
	}
});

test("a folded ratio is still exactly the width beside a scroll indicator", () => {
	// The tightest case there is: the indicator has already taken its columns and
	// the chips are wider than usual, so this is where a mis-measured separator
	// would first push the line past the border and wrap the frame.
	const lead = visibleWidth("─── ↑ 12 more ");
	for (let width = 16; width <= 120; width++) {
		const bar = composeBar([mcpWithOff], width - lead, cells);
		if (bar === undefined) continue;
		assert.equal(lead + visibleWidth(bar), width, `width ${width}`);
		assert.ok(leadingRule(bar) >= MIN_LEAD_RULE, `width ${width} crowded the indicator: ${bar}`);
	}
});

test("mixed publishers with a wide glyph still land on the exact width", () => {
	const both = [
		mcp,
		{
			source: "subagents",
			badges: [
				{ text: `${AGENT_GLYPH} 2`, tone: "warn" as never },
				{ text: `${UNREAD_GLYPH} 3`, tone: "neutral" as never },
			],
		} as BadgeGroup,
	];
	for (let width = 20; width <= 120; width++) {
		const bar = composeBar(both, width, cells);
		if (bar === undefined) continue;
		assert.equal(visibleWidth(bar), width, `width ${width}`);
		assert.ok(leadingRule(bar) >= MIN_LEAD_RULE, `width ${width}`);
	}
});

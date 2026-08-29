import assert from "node:assert/strict";
import { test } from "node:test";
import { countServers, formatStatus, statusBadges, type StatusBadge, type StatusServer } from "../status.ts";

const ready = (tools = 0): StatusServer => ({ status: "ready", tools });
const connecting = (): StatusServer => ({ status: "connecting", tools: 0 });
const failed = (): StatusServer => ({ status: "error", tools: 0 });
const needsAuth = (): StatusServer => ({ status: "needs auth", tools: 0 });
// A disabled server keeps the tools it discovered before being switched off;
// they must not be counted, because the model cannot see them.
const off = (tools = 3): StatusServer => ({ status: "disabled", tools });

test("no servers configured means no footer entry at all", () => {
	assert.equal(formatStatus([]), undefined);
});

test("the happy path reads as N/N servers and a tool count", () => {
	assert.equal(formatStatus([ready(45), ready(46)]), "mcp: 2/2 servers, 91 tools");
});

test("a single tool is not pluralised", () => {
	assert.equal(formatStatus([ready(1)]), "mcp: 1/1 servers, 1 tool");
});

test("startup shows connecting rather than a zero ratio", () => {
	assert.equal(formatStatus([connecting()]), "mcp: connecting to 1 server…");
	assert.equal(formatStatus([connecting(), connecting()]), "mcp: connecting to 2 servers…");
});

test("a partly connected set reports the ratio and what is still in flight", () => {
	assert.equal(formatStatus([ready(10), connecting()]), "mcp: 1/2 servers, 10 tools, 1 connecting");
});

test("a failure is named, not just implied by the ratio", () => {
	const text = formatStatus([ready(10), failed()]);
	assert.equal(text, "mcp: 1/2 servers, 10 tools, 1 failed");
	// The distinguishing property: you can tell a failure from a smaller install.
	assert.notEqual(text, formatStatus([ready(10)]));
	assert.ok(text!.includes("failed"));
});

test("every server failing still shows the ratio, not a connecting state", () => {
	assert.equal(formatStatus([failed(), failed()]), "mcp: 0/2 servers, 0 tools, 2 failed");
});

test("servers awaiting login are called out separately from failures", () => {
	assert.equal(formatStatus([ready(5), needsAuth()]), "mcp: 1/2 servers, 5 tools, 1 needs login");
	assert.equal(
		formatStatus([ready(5), needsAuth(), needsAuth()]),
		"mcp: 1/3 servers, 5 tools, 2 need login",
	);
});

test("disabled servers are excluded from the ratio and reported as off", () => {
	assert.equal(formatStatus([ready(7), off()]), "mcp: 1/1 servers, 7 tools, 1 off");
	// Their stale tool count never inflates the total.
	assert.ok(!formatStatus([ready(7), off(99)])!.includes("99"));
});

test("only-disabled servers say so instead of clearing", () => {
	assert.equal(formatStatus([off(), off()]), "mcp: 2 off");
});

test("the states compose in a fixed order", () => {
	assert.equal(
		formatStatus([ready(4), connecting(), failed(), needsAuth(), off()]),
		"mcp: 1/4 servers, 4 tools, 1 connecting, 1 failed, 1 needs login, 1 off",
	);
});

test("the documented example still formats as documented", () => {
	// extensions/mcp/README.md, "The footer line": `mcp: 3/4 servers, 27 tools, 1 needs login, 1 off`
	assert.equal(
		formatStatus([ready(9), ready(9), ready(9), needsAuth(), off()]),
		"mcp: 3/4 servers, 27 tools, 1 needs login, 1 off",
	);
});

// The badge row, as `tone:text` pairs. Asserting on the structure rather than on
// rendered ANSI is the whole reason status.ts stays free of pi imports: a colour
// is index.ts's business, and a test that pinned escape sequences here would
// break every time a theme token was renamed without a single badge changing.
const shape = (servers: readonly StatusServer[]): string[] | undefined =>
	statusBadges(servers)?.map((badge: StatusBadge) => `${badge.tone}:${badge.text}`);

test("no servers configured means no badges at all", () => {
	assert.equal(statusBadges([]), undefined);
});

test("the happy path is a label, a green ratio and a tool count", () => {
	assert.deepEqual(shape([ready(45), ready(46)]), ["label:mcp", "ok:2/2", "neutral:91 tools"]);
});

test("a single tool is not pluralised in a badge either", () => {
	assert.deepEqual(shape([ready(1)]), ["label:mcp", "ok:1/1", "neutral:1 tool"]);
});

test("startup shows a connecting chip, never a zero ratio", () => {
	// The tool count is absent on purpose: nothing has reported its tools yet, so
	// `0 tools` would be a claim rather than a fact.
	assert.deepEqual(shape([connecting()]), ["label:mcp", "pending:connecting 1…"]);
	assert.deepEqual(shape([connecting(), connecting()]), ["label:mcp", "pending:connecting 2…"]);
});

test("a partly connected set keeps the ratio and adds what is still in flight", () => {
	assert.deepEqual(shape([ready(10), connecting()]), [
		"label:mcp",
		"pending:1/2",
		"neutral:10 tools",
		"pending:1 connecting",
	]);
});

test("a failure colours the ratio as well as getting its own chip", () => {
	// Both, deliberately: the ratio is where a glance lands, so it has to carry
	// the bad news without the user having to read along the line.
	assert.deepEqual(shape([ready(10), failed()]), ["label:mcp", "error:1/2", "neutral:10 tools", "error:1 failed"]);
});

test("every server failing still shows the ratio, not a connecting chip", () => {
	assert.deepEqual(shape([failed(), failed()]), ["label:mcp", "error:0/2", "neutral:0 tools", "error:2 failed"]);
});

test("needing a login is a warning, not an error", () => {
	assert.deepEqual(shape([ready(5), needsAuth()]), ["label:mcp", "warn:1/2", "neutral:5 tools", "warn:1 needs login"]);
	assert.deepEqual(shape([ready(5), needsAuth(), needsAuth()]), [
		"label:mcp",
		"warn:1/3",
		"neutral:5 tools",
		"warn:2 need login",
	]);
});

test("a failure outranks a login when both are true of the ratio", () => {
	const badges = statusBadges([ready(1), failed(), needsAuth()]);
	assert.equal(badges?.[1]?.text, "1/3");
	assert.equal(badges?.[1]?.tone, "error");
});

test("disabled servers ride on the ratio chip instead of taking one of their own", () => {
	// `1/1·1`, not `1/2`: the ratio counts only the servers that are *supposed* to
	// be up, so it stays a health signal and `/mcp disable` never looks like a
	// failure. The count is appended after it as a separate number.
	assert.deepEqual(shape([ready(7), off()]), ["label:mcp", "ok:1/1·1", "neutral:7 tools"]);
	assert.deepEqual(shape([ready(7), off(), off()]), ["label:mcp", "ok:1/1·2", "neutral:7 tools"]);
	// Their stale tool count never inflates the total.
	assert.deepEqual(shape([ready(7), off(99)]), shape([ready(7), off(3)]));
});

test("nothing switched off leaves the ratio chip exactly as it was", () => {
	// The suffix is omitted at zero rather than shown as `·0`. This is the case
	// almost every install is in, and it must not pay a column for a fact that has
	// not happened.
	for (const servers of [[ready(45), ready(46)], [ready(1)], [ready(10), failed()], [failed(), failed()]]) {
		const ratio = statusBadges(servers)?.[1]?.text ?? "";
		assert.ok(!ratio.includes("·"), `"${ratio}" grew a separator with nothing disabled`);
	}
});

test("the folded count takes the ratio's tone, not one of its own", () => {
	// A chip is painted as one run — the composer has no notion of two colours
	// inside one pill — so there is exactly one tone to choose, and it is the one
	// the ratio would have had alone. A failure alongside something switched off
	// still reads as a failure.
	assert.deepEqual(shape([ready(1), failed(), off()]), [
		"label:mcp",
		"error:1/2·1",
		"neutral:1 tool",
		"error:1 failed",
	]);
	assert.deepEqual(shape([ready(1), needsAuth(), off()]), [
		"label:mcp",
		"warn:1/2·1",
		"neutral:1 tool",
		"warn:1 needs login",
	]);
});

test("the startup chip keeps its own off badge, because it has no ratio to ride on", () => {
	// `connecting 2…·1` is not a thing anyone can read. The fold is a property of
	// the ratio chip, and where there is no ratio the count falls back to the chip
	// it always had rather than being dropped — losing a fact to a layout detail is
	// the one outcome that is worse than an extra chip.
	assert.deepEqual(shape([connecting(), connecting(), off()]), [
		"label:mcp",
		"pending:connecting 2…",
		"muted:1 off",
	]);
});

test("only-disabled servers get a chip instead of clearing", () => {
	// Also a no-ratio case, so also the worded chip.
	assert.deepEqual(shape([off(), off()]), ["label:mcp", "muted:2 off"]);
});

test("the badges compose in the same fixed order as the sentence", () => {
	assert.deepEqual(shape([ready(4), connecting(), failed(), needsAuth(), off()]), [
		"label:mcp",
		"error:1/4·1",
		"neutral:4 tools",
		"pending:1 connecting",
		"error:1 failed",
		"warn:1 needs login",
	]);
});

/**
 * How each fact shows up in each rendering.
 *
 * A plain substring search over both would do if the two spelled everything the
 * same way, and it did until the switched-off count started riding on the ratio
 * chip as `2/2·1` while the sentence kept saying `1 off`. The test below is not
 * about spelling, though — it is about neither rendering silently dropping a
 * fact the other reports — so the spelling is a parameter and the property
 * stays exactly as strong as it was.
 */
const FACTS: { name: string; sentence: RegExp; badges: RegExp }[] = [
	{ name: "connecting", sentence: /connecting/, badges: /connecting/ },
	{ name: "failed", sentence: /failed/, badges: /failed/ },
	{ name: "login", sentence: /login/, badges: /login/ },
	// `, 1 off` in prose; `·1` glued to the ratio, or the worded chip in the two
	// states that have no ratio to glue it to.
	{ name: "off", sentence: /\d+ off/, badges: /·\d+|\d+ off/ },
];

test("the two renderings never disagree about what is worth mentioning", () => {
	// The failure mode this guards is a chip row that quietly drops a failure the
	// sentence reports (or the reverse), leaving the user unable to tell which of
	// the two is lying. Both are driven from one set of counts; this checks it.
	const states: StatusServer[] = [ready(4), connecting(), failed(), needsAuth(), off()];
	for (let mask = 0; mask < 1 << states.length; mask++) {
		const subset = states.filter((_, i) => mask & (1 << i));
		const text = formatStatus(subset);
		const badges = statusBadges(subset);
		assert.equal(text === undefined, badges === undefined, `presence differs for mask ${mask}`);
		if (!text || !badges) continue;
		const chips = badges.map((badge) => badge.text).join(" ");
		for (const fact of FACTS) {
			assert.equal(
				fact.sentence.test(text),
				fact.badges.test(chips),
				`"${fact.name}" differs between "${text}" and ${JSON.stringify(badges.map((b) => b.text))}`,
			);
		}
	}
});

test("the sentence is untouched by the fold: it still says the count in words", () => {
	// The badges' `·` notation is something you look at, not something you read,
	// and the sentence exists for the places that cannot show chips at all. Pinned
	// so the two cannot be "unified" into prose that reads `2/2·1 servers`.
	assert.equal(formatStatus([ready(45), ready(46), off()]), "mcp: 2/2 servers, 91 tools, 1 off");
	for (const servers of [[ready(7), off()], [ready(4), connecting(), failed(), needsAuth(), off()], [off(), off()]]) {
		assert.ok(!formatStatus(servers)!.includes("·"), "the sentence borrowed the badges' separator");
	}
});

test("badges are unpadded: the renderer owns the whitespace", () => {
	// The footer collapses runs of literal spaces, so padding has to be applied
	// inside the colour escapes by index.ts. A badge that arrived pre-padded would
	// be padded twice and then unevenly collapsed.
	for (const badge of statusBadges([ready(4), connecting(), failed(), needsAuth(), off()]) ?? []) {
		assert.equal(badge.text, badge.text.trim(), `badge "${badge.text}" carries its own padding`);
		assert.ok(!badge.text.includes("  "), `badge "${badge.text}" has a collapsible double space`);
	}
	// The folded ratio in particular: `2/2 · 1` would read as three chips' worth of
	// separator inside one chip, and the composer already uses ` · ` between chips.
	assert.deepEqual(
		statusBadges([ready(7), off()])?.map((badge) => badge.text),
		["mcp", "1/1·1", "7 tools"],
	);
});

test("countServers separates configured from switched off", () => {
	const counts = countServers([ready(2), connecting(), failed(), needsAuth(), off(5)]);
	assert.deepEqual(counts, {
		configured: 4,
		connecting: 1,
		ready: 1,
		failed: 1,
		needsAuth: 1,
		off: 1,
		tools: 2,
	});
});

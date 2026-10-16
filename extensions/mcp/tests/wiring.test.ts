/**
 * The footer and the bar against the real extension.
 *
 * `status.test.ts` covers what the line says and `observe.test.ts` what the
 * derivation concludes; this covers whether anything is ever *written* — the
 * part that broke in review once before: a status painted once at startup, or
 * painted into a context that has no UI. Real config files on disk, a stub pi
 * whose `getAllTools()` the tests mutate to play the builtin registering and
 * withdrawing tools, no terminal.
 *
 * It also covers the badge rendering, which cannot live in `status.test.ts`
 * because it needs a theme. The assertions that matter there are not about which
 * colour: they are about the badge line surviving what pi's footer does to it on
 * the way to the screen, and about every non-terminal caller still getting a
 * sentence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import mcpBadges, { BADGE_STYLE } from "../index.ts";
import { mcpNamespace } from "../observe.ts";
import { RECOMMENDED_TOKENS, resetForTests, setRenderer, snapshot } from "../../shared/border-badges.ts";

// An SGR sequence: escape, `[`, digits and semicolons, `m`. Exactly what a
// terminal parses, and what pi's own ANSI-aware width maths assumes. Notably it
// contains no space, which is what makes the footer's whitespace collapsing
// survivable at all.
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (text: string): string => text.replace(ANSI, "");

/**
 * What pi's footer does to every extension status before drawing it.
 *
 * Copied from `sanitizeStatusText` in
 * `dist/modes/interactive/components/footer.js`. It is duplicated here rather
 * than imported because it is not exported, and the point of the copy is that
 * the badge line has to survive it: escape sequences pass through untouched, but
 * two adjacent literal spaces become one, which would silently deform the
 * padding that gives each badge its shape.
 */
const sanitize = (text: string): string =>
	text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();

/**
 * Stand-in colour numbers for the tokens the badges use.
 *
 * Which number stands for which token is arbitrary. That the sequences built
 * from them are *structurally* real SGR is not: a test double that emitted
 * readable token names would put the letter `m` inside a sequence terminated by
 * `m`, and both `strip` here and pi's own width maths would mis-parse it. The
 * double has to be wrong in no way that the code under test can notice.
 */
const FG_CODE: Record<string, number> = {
	text: 30,
	accent: 31,
	muted: 32,
	dim: 33,
	success: 34,
	error: 35,
	warning: 36,
};
const BG_CODE: Record<string, number> = {
	selectedBg: 40,
	searchMatchBg: 41,
	userMessageBg: 42,
	customMessageBg: 43,
	toolPendingBg: 44,
	toolSuccessBg: 45,
	toolErrorBg: 46,
};

/** The escape sequences a badge of this tone should be wrapped in. */
const chip = (bg: string, fg: string, text: string): string =>
	`\x1b[48;5;${BG_CODE[bg]}m\x1b[38;5;${FG_CODE[fg]}m ${text} \x1b[39m\x1b[49m`;

/**
 * A stand-in for pi's `Theme`, close enough where it counts.
 *
 * Emits real escape sequences so the tests see the string a terminal would, and
 * throws on a token it does not know exactly as the real one does — that throw
 * is the thing `index.ts` guards against when it falls back to prose.
 */
function fakeTheme(options: { colorless?: boolean; missing?: string } = {}) {
	const wrap = (codes: Record<string, number>, on: number, off: number, token: string, text: string): string => {
		if (token === options.missing || codes[token] === undefined) {
			throw new Error(`Unknown theme color: ${token}`);
		}
		return options.colorless ? text : `\x1b[${on};5;${codes[token]}m${text}\x1b[${off}m`;
	};
	return {
		fg: (token: string, text: string) => wrap(FG_CODE, 38, 39, token, text),
		bg: (token: string, text: string) => wrap(BG_CODE, 48, 49, token, text),
		bold: (text: string) => (options.colorless ? text : `\x1b[1m${text}\x1b[22m`),
	};
}

/** A tool as the builtin registers it: namespaced under its server. */
const serverTool = (server: string, exposure = "direct") => ({
	name: `${mcpNamespace(server)}__tool`,
	exposure,
	namespace: { name: mcpNamespace(server) },
});

interface Harness {
	statuses: Array<string | undefined>;
	/** The last status exactly as pi received it, escape sequences and all. */
	status: () => string | undefined;
	/** The last status as the eye reads it: no colour, no padding. */
	plain: () => string | undefined;
	sessionStart: () => Promise<void>;
	/** Fire pi's `mcp_servers_change`, as a registration would. */
	serversChange: () => Promise<void>;
	/** The mutable `getAllTools()` output — the tests play the builtin with it. */
	tools: Array<{ name: string; exposure?: string; namespace?: { name: string } }>;
	registered: Array<{ name: string; config: { enabled?: boolean } }>;
	shutdown: () => Promise<void>;
}

/** Install the extension against a stub pi API and return the seams the test drives. */
function harness(options: {
	/** `mcpServers` map written to the scratch agent dir's mcp.json. */
	config?: Record<string, unknown>;
	/** `mcpServers` map written to `<cwd>/.pi/mcp.json`. */
	project?: Record<string, unknown>;
	tools?: Harness["tools"];
	registered?: Harness["registered"];
	hasUI?: boolean;
	mode?: string;
	theme?: ReturnType<typeof fakeTheme>;
}): Harness {
	// A scratch agent dir per harness: `getAgentDir()` reads the env on every
	// call, so pointing it somewhere fresh isolates each test's config without
	// any state to clean up.
	const agentDir = mkdtempSync(path.join(tmpdir(), "pi-mcp-wiring-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: options.config ?? {} }));

	const cwd = mkdtempSync(path.join(tmpdir(), "pi-mcp-wiring-cwd-"));
	if (options.project) {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: options.project }));
	}

	// The badge registry lives on `globalThis` so that separate module instances
	// share it, which means it also outlives a test. Start each harness from
	// nothing.
	resetForTests();

	const statuses: Array<string | undefined> = [];
	const tools = options.tools ?? [];
	const registered = options.registered ?? [];
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();

	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		// Default to the mode a person actually sees, so the wiring tests exercise
		// the rendering a person actually gets.
		mode: options.mode ?? "tui",
		ui: {
			theme: options.theme ?? fakeTheme(),
			setStatus: (key: string, text: string | undefined) => {
				assert.equal(key, "mcp");
				statuses.push(text);
			},
		},
	};

	const pi = {
		on: (name: string, handler: (event: any, c: any) => Promise<void> | void) => handlers.set(name, handler),
		getMcpServers: () => registered,
		getAllTools: () => tools,
	};

	mcpBadges(pi as any);

	const last = () => statuses[statuses.length - 1];
	return {
		statuses,
		tools,
		registered,
		status: last,
		plain: () => {
			const text = last();
			return text === undefined ? undefined : sanitize(strip(text));
		},
		sessionStart: async () => {
			await handlers.get("session_start")?.({}, ctx);
		},
		serversChange: async () => {
			await handlers.get("mcp_servers_change")?.({}, ctx);
		},
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
	};
}

/**
 * Every test must shut the extension down: `session_start` starts the poll
 * interval, and although it is unref'd (so a leak cannot hang the suite), a
 * poller left running would repaint into a later test's registry.
 */
async function withHarness(
	options: Parameters<typeof harness>[0],
	body: (h: Harness) => Promise<void>,
): Promise<void> {
	const h = harness(options);
	try {
		await body(h);
	} finally {
		await h.shutdown();
	}
}

/** One poll tick, with margin. `run.mjs` sets `PI_MCP_BADGE_POLL_MS=25`. */
const tick = () => sleep(80);

test("servers whose tools are registered are counted, with their tools", async () => {
	await withHarness(
		{
			config: { alpha: {}, beta: {} },
			tools: [...Array.from({ length: 45 }, () => serverTool("alpha")), ...Array.from({ length: 46 }, () => serverTool("beta"))],
		},
		async (h) => {
			await h.sessionStart();
			assert.equal(h.plain(), "mcp 2/2 91 tools");
		},
	);
});

test("an enabled server with no tools yet reads as connecting", async () => {
	await withHarness({ config: { slow: {} } }, async (h) => {
		await h.sessionStart();
		assert.equal(h.plain(), "mcp connecting 1…");
	});
});

test("the poll notices the builtin's tools appearing, with no event fired", async () => {
	// This is the trigger that earns the interval: pi fires nothing when the
	// builtin finishes a connect, so without the poll the footer would say
	// "connecting" forever on a healthy install.
	await withHarness({ config: { slow: {} } }, async (h) => {
		await h.sessionStart();
		assert.equal(h.plain(), "mcp connecting 1…");
		h.tools.push(serverTool("slow"), serverTool("slow"));
		await tick();
		assert.equal(h.plain(), "mcp 1/1 2 tools");
	});
});

test("a server disabled in config rides the ratio as ·1", async () => {
	await withHarness(
		{ config: { alpha: {}, beta: { enabled: false } }, tools: [serverTool("alpha"), serverTool("alpha"), serverTool("alpha")] },
		async (h) => {
			await h.sessionStart();
			assert.equal(h.plain(), "mcp 1/1·1 3 tools");
		},
	);
});

test("the project mcp.json overrides the global entry of the same name", async () => {
	await withHarness(
		{
			config: { alpha: {}, beta: {} },
			project: { beta: { enabled: false } },
			tools: [serverTool("alpha")],
		},
		async (h) => {
			await h.sessionStart();
			assert.equal(h.plain(), "mcp 1/1·1 1 tool");
		},
	);
});

test("hidden tools — the builtin's withdrawn ones — are not counted", async () => {
	await withHarness(
		{ config: { alpha: {} }, tools: [serverTool("alpha"), serverTool("alpha", "hidden")] },
		async (h) => {
			await h.sessionStart();
			assert.equal(h.plain(), "mcp 1/1 1 tool");
		},
	);
});

test("registered servers are observed, and mcp_servers_change repaints", async () => {
	await withHarness({ config: {} }, async (h) => {
		await h.sessionStart();
		assert.equal(h.status(), undefined);

		h.registered.push({ name: "jira", config: {} });
		await h.serversChange();
		assert.equal(h.plain(), "mcp connecting 1…");

		h.tools.push(serverTool("jira"));
		await tick();
		assert.equal(h.plain(), "mcp 1/1 1 tool");
	});
});

test("no configured servers clears the entry instead of writing an empty one", async () => {
	await withHarness({ config: {} }, async (h) => {
		await h.sessionStart();
		assert.equal(h.status(), undefined);
		// `undefined` clears; an empty string would leave a separator behind.
		assert.ok(!h.statuses.includes(""));
	});
});

test("without a UI nothing is ever written", async () => {
	await withHarness({ config: { alpha: {} }, tools: [serverTool("alpha")], hasUI: false, mode: "print" }, async (h) => {
		await h.sessionStart();
		await tick();
		assert.deepEqual(h.statuses, []);
	});
});

test("a terminal gets badges: every fact is a separately coloured chip", async () => {
	await withHarness(
		{
			config: { alpha: {}, beta: { enabled: false } },
			tools: [serverTool("alpha"), serverTool("alpha"), serverTool("alpha")],
		},
		async (h) => {
			await h.sessionStart();
			const line = h.status() ?? "";
			// The label is the accent chip, and the only bold one; the ratio is green
			// because everything still switched on is up, and it carries the `·1` inside
			// that one background — a chip is painted as a single run, so the count
			// cannot be tinted separately and does not try to be.
			assert.ok(line.includes(chip("selectedBg", "accent", "\x1b[1mmcp\x1b[22m")), "no accent label chip");
			assert.ok(line.includes(chip("toolSuccessBg", "success", "1/1·1")), "ratio is not the success chip");
			assert.ok(line.includes(chip("userMessageBg", "text", "3 tools")), "tools is not the neutral chip");
			// Every fact is painted: none is left as bare text beside the coloured ones.
			assert.equal((line.match(/\x1b\[48;/g) ?? []).length, 3, `expected three chips in ${JSON.stringify(line)}`);
		},
	);
});

test("the badge line survives what the footer does to it", async () => {
	// The contract this depends on, from footer.js: extension statuses are passed
	// through `sanitizeStatusText` before being drawn. Escape sequences survive,
	// but a run of two literal spaces is collapsed to one. Every space in a badge
	// line therefore has to be separated from its neighbour by an escape sequence,
	// or the padding silently shrinks on some chips and not others.
	await withHarness(
		{ config: { alpha: {}, beta: {} }, tools: [serverTool("alpha"), ...Array.from({ length: 6 }, () => serverTool("beta"))] },
		async (h) => {
			await h.sessionStart();
			const line = h.status() ?? "";
			assert.equal(sanitize(line), line, "the footer would rewrite the badge line");
			// Stated the other way round, because this is the property that actually
			// matters: nothing visible is lost or moved.
			assert.equal(strip(sanitize(line)), strip(line));
		},
	);
});

test("a client that is not a terminal gets the sentence, not escape codes", async () => {
	// RPC has `hasUI: true` — there is a client listening — but it renders the
	// status itself, so colour is something it would have to strip. `ctx.mode` is
	// the only signal that separates the two.
	await withHarness(
		{
			config: { alpha: {}, beta: {} },
			tools: [...Array.from({ length: 3 }, () => serverTool("alpha")), ...Array.from({ length: 4 }, () => serverTool("beta"))],
			mode: "rpc",
		},
		async (h) => {
			await h.sessionStart();
			assert.equal(h.status(), "mcp: 2/2 servers, 7 tools");
			assert.equal(strip(h.status() ?? ""), h.status());
		},
	);
});

test("a theme that paints nothing falls back to the sentence", async () => {
	// Badges lean on colour to be separable; without it `mcp 1/1 3 tools` is a run
	// of numbers, which is worse than the prose it replaced.
	await withHarness(
		{ config: { alpha: {} }, tools: Array.from({ length: 3 }, () => serverTool("alpha")), theme: fakeTheme({ colorless: true }) },
		async (h) => {
			await h.sessionStart();
			assert.equal(h.status(), "mcp: 1/1 servers, 3 tools");
		},
	);
});

test("a theme missing a token costs the colour, never the line", async () => {
	// pi's `fg`/`bg` throw on a token they do not know. A theme that drops one
	// must not take the status line down with it.
	await withHarness(
		{ config: { alpha: {} }, tools: Array.from({ length: 3 }, () => serverTool("alpha")), theme: fakeTheme({ missing: "toolSuccessBg" }) },
		async (h) => {
			await h.sessionStart();
			assert.equal(h.status(), "mcp: 1/1 servers, 3 tools");
		},
	);
});

test("a garbage mcp.json contributes nothing and breaks nothing", async () => {
	const h = harness({ config: {} });
	writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"), "{ not json");
	try {
		await h.sessionStart();
		assert.equal(h.status(), undefined);
	} finally {
		await h.shutdown();
	}
});

/** mcp's group in the shared registry, as `tone:text` pairs. */
const published = (): string[] | undefined =>
	snapshot()
		.find((group) => group.source === "mcp")
		?.badges.map((badge) => `${badge.tone}:${badge.text}`);

test("the same badges are published to the border-bar registry", async () => {
	await withHarness(
		{
			config: { alpha: {}, beta: {} },
			tools: [...Array.from({ length: 3 }, () => serverTool("alpha")), ...Array.from({ length: 4 }, () => serverTool("beta"))],
		},
		async (h) => {
			await h.sessionStart();
			assert.deepEqual(published(), ["label:mcp", "ok:2/2", "neutral:7 tools"]);

			// And it keeps up with the builtin, exactly as the footer copy does.
			h.tools.push(serverTool("beta"));
			await tick();
			assert.deepEqual(published(), ["label:mcp", "ok:2/2", "neutral:8 tools"]);
		},
	);
});

test("publishing does not depend on this extension having a UI", async () => {
	// The badges are data. Whether *this* callback was handed a context it can
	// paint into says nothing about whether the extension that owns the editor can
	// draw, so the publish happens before the UI guard.
	await withHarness(
		{ config: { alpha: {} }, tools: Array.from({ length: 3 }, () => serverTool("alpha")), hasUI: false, mode: "print" },
		async (h) => {
			await h.sessionStart();
			assert.deepEqual(h.statuses, [], "the footer was written to after all");
			assert.deepEqual(published(), ["label:mcp", "ok:1/1", "neutral:3 tools"]);
		},
	);
});

test("shutdown withdraws from the bar instead of leaving a dead snapshot", async () => {
	const h = harness({ config: { alpha: {} }, tools: [serverTool("alpha")] });
	try {
		await h.sessionStart();
		assert.ok(published(), "nothing was published to begin with");
	} finally {
		await h.shutdown();
	}
	assert.equal(published(), undefined);
});

test("shutdown stops the poll", async () => {
	const h = harness({ config: { alpha: {} }, tools: [serverTool("alpha")] });
	await h.sessionStart();
	await h.shutdown();
	// A poller still running would republish this within a tick.
	h.tools.push(serverTool("alpha"));
	await tick();
	assert.equal(published(), undefined);
});

test("nothing configured publishes nothing at all", async () => {
	await withHarness({ config: {} }, async (h) => {
		await h.sessionStart();
		assert.equal(published(), undefined);
	});
});

test("the footer and the border bar agree on what every tone looks like", () => {
	// Two renderers, one appearance. `index.ts` needs pi's typed token unions and
	// the shared registry cannot name them without importing pi, so the mapping is
	// written twice; this is what stops the copies drifting apart.
	assert.deepEqual(BADGE_STYLE, RECOMMENDED_TOKENS);
});

// --- degradation: is anything drawing the border bar? ----------------------

test("with a renderer attached the footer entry is cleared, not duplicated", async () => {
	// The bar and the status line would otherwise say the same thing twice, on
	// two lines, for the whole session.
	//
	// Announced inside the harness, not around it: `harness()` resets the shared
	// registry so each test starts from nothing, which would otherwise wipe the
	// very thing under test before `sessionStart` could see it.
	await withHarness({ config: { alpha: {} }, tools: Array.from({ length: 3 }, () => serverTool("alpha")) }, async (h) => {
		setRenderer(true);
		try {
			await h.sessionStart();
			assert.deepEqual(published(), ["label:mcp", "ok:1/1", "neutral:3 tools"]);
			assert.equal(h.status(), undefined, "the footer was written even though a bar exists");
		} finally {
			setRenderer(false);
		}
	});
});

test("with no renderer the footer keeps working exactly as before", async () => {
	// The degradation that matters: somebody who does not run the extension owning
	// the editor must not silently lose their MCP indicator. `hasRenderer()` is
	// false for them, and this is the old behaviour, unchanged.
	await withHarness({ config: { alpha: {} }, tools: [serverTool("alpha")] }, async (h) => {
		await h.sessionStart();
		assert.match(strip(String(h.status())), /mcp/);
		assert.match(strip(String(h.status())), /1\/1/);
	});
});

test("a renderer arriving mid-session takes the footer entry back down", async () => {
	// Extension load order is arbitrary, so this is the ordinary case rather than
	// an exotic one: mcp paints its footer, and the editor mounts a moment later.
	// Without the subscription the duplicate would sit there until the next poll.
	await withHarness({ config: { alpha: {} }, tools: [serverTool("alpha")] }, async (h) => {
		await h.sessionStart();
		assert.notEqual(h.status(), undefined, "expected a footer entry before the bar exists");

		setRenderer(true);
		try {
			assert.equal(h.status(), undefined, "the footer entry survived the bar appearing");
		} finally {
			setRenderer(false);
		}
		// …and it comes back when the bar goes away again, e.g. the extension that
		// owns the editor being disabled on a reload.
		assert.notEqual(h.status(), undefined, "the footer did not return when the bar left");
	});
});

test("the badges are published whether or not anything is rendering them", async () => {
	// Presence gates the *fallback*, never the data. A renderer that mounts later
	// has to find the current badges already there, not wait for the next poll to
	// hear about them.
	await withHarness({ config: { alpha: {} }, tools: Array.from({ length: 3 }, () => serverTool("alpha")) }, async (h) => {
		setRenderer(true);
		try {
			await h.sessionStart();
			assert.deepEqual(published(), ["label:mcp", "ok:1/1", "neutral:3 tools"]);
		} finally {
			setRenderer(false);
		}
	});
});

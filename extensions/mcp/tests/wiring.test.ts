/**
 * The footer against the real extension.
 *
 * `status.test.ts` covers what the line says; this covers whether it is ever
 * written — the part that broke in review: a status painted once at startup, or
 * painted into a context that has no UI. Real `ServerState`s, real stdio
 * connections to `fake-server.mjs`, no network and no terminal.
 *
 * It also covers the badge rendering, which cannot live in `status.test.ts`
 * because it needs a theme. The assertions that matter there are not about which
 * colour: they are about the badge line surviving what pi's footer does to it on
 * the way to the screen, and about every non-terminal caller still getting a
 * sentence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import mcpExtension, { BADGE_STYLE } from "../index.ts";
import { RECOMMENDED_TOKENS, resetForTests, setRenderer, snapshot } from "../../shared/border-badges.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(here, "fake-server.mjs");

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

interface Harness {
	statuses: Array<string | undefined>;
	/** The last status exactly as pi received it, escape sequences and all. */
	status: () => string | undefined;
	/** The last status as the eye reads it: no colour, no padding. */
	plain: () => string | undefined;
	sessionStart: () => Promise<void>;
	command: (args: string) => Promise<void>;
	/** Runs the extension's `session_shutdown`, which closes the stdio children. */
	shutdown: () => Promise<void>;
	notifications: string[];
}

/** Install the extension against a stub pi API and return the seams the test drives. */
function harness(options: {
	config: Record<string, unknown>;
	hasUI?: boolean;
	mode?: string;
	theme?: ReturnType<typeof fakeTheme>;
}): Harness {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-wiring-"));
	const file = path.join(dir, "mcp.json");
	writeFileSync(file, JSON.stringify({ mcpServers: options.config }));
	process.env.PI_MCP_CONFIG = file;

	// `/mcp disable` persists to `~/.pi/agent/mcp-state.json`, and `config.ts`
	// resolves that path once at import time — so it is one file shared by every
	// test in the run, and a test that disables a server silently disables it for
	// everyone after it. Clearing it here is what makes these tests independent of
	// the order they happen to run in.
	rmSync(path.join(homedir(), ".pi", "agent", "mcp-state.json"), { force: true });

	// The badge registry lives on `globalThis` so that separate module instances
	// share it, which means it also outlives a test. Same reasoning as the state
	// file above: start each harness from nothing.
	resetForTests();

	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	let activeTools: string[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
	let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	let starting: Promise<void> | undefined;

	const ctx = {
		cwd: dir,
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
			notify: (message: string) => notifications.push(message),
			addAutocompleteProvider: () => {},
			select: async () => undefined,
		},
	};

	const pi = {
		on: (name: string, handler: (event: any, c: any) => Promise<void> | void) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: (_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commandHandler = spec.handler;
		},
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
	};

	mcpExtension(pi as any);

	const last = () => statuses[statuses.length - 1];
	return {
		statuses,
		status: last,
		plain: () => {
			const text = last();
			return text === undefined ? undefined : sanitize(strip(text));
		},
		sessionStart: () => {
			// Remembered so `shutdown` can wait for it even when a test never reaches
			// its own `await` — see withHarness.
			starting = Promise.resolve(handlers.get("session_start")?.({}, ctx));
			return starting;
		},
		command: async (args: string) => {
			await commandHandler?.(args, ctx);
		},
		shutdown: async () => {
			// A connect still in flight has not assigned `state.client` yet, so shutting
			// down on top of it closes nothing and the server it goes on to spawn is
			// never reaped. Wait for it to settle first, however it settles.
			await starting?.catch(() => {});
			await handlers.get("session_shutdown")?.({}, ctx);
		},
		notifications,
	};
}

/**
 * Every test must shut the extension down.
 *
 * A stdio server is a real child process; leaving one running keeps the event
 * loop alive and the suite hangs after the last assertion passes — which is
 * exactly how this went unnoticed the first time, because the reporter had
 * already printed 20 green ticks.
 *
 * The `finally` is not enough on its own. A test whose assertion fails before it
 * awaits `sessionStart` would shut down on top of a half-finished connect and
 * orphan the child anyway, so a failing assertion could turn a red run into a
 * hung one and hide itself. `shutdown` waits for that connect; this only has to
 * make sure it is always called.
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

const stdio = (tools: number, extra: string[] = []) => ({
	command: process.execPath,
	args: [FAKE_SERVER, String(tools), ...extra],
});

test("a connected server is counted, with its tools", async () => {
	await withHarness({ config: { alpha: stdio(3) } }, async (h) => {
		await h.sessionStart();
		assert.equal(h.plain(), "mcp 1/1 3 tools");
	});
});

test("two servers add up", async () => {
	await withHarness({ config: { alpha: stdio(45), beta: stdio(46) } }, async (h) => {
		await h.sessionStart();
		assert.equal(h.plain(), "mcp 2/2 91 tools");
	});
});

test("the connecting state is shown before anything has connected", async () => {
	await withHarness({ config: { slow: stdio(2, ["--slow", "150"]) } }, async (h) => {
		const done = h.sessionStart();
		// Painted synchronously, before the first await on the transport.
		assert.equal(h.plain(), "mcp connecting 1…");
		await done;
		assert.equal(h.plain(), "mcp 1/1 2 tools");
	});
});

test("a failure is visible and distinct from a smaller install", async () => {
	await withHarness(
		{ config: { alpha: stdio(3), broken: { command: path.join(here, "definitely-not-a-command") } } },
		async (h) => {
			await h.sessionStart();
			assert.equal(h.plain(), "mcp 1/2 3 tools 1 failed");
		},
	);
});

test("the status keeps up with enable and disable", async () => {
	await withHarness({ config: { alpha: stdio(3), beta: stdio(4) } }, async (h) => {
		await h.sessionStart();
		assert.equal(h.plain(), "mcp 2/2 7 tools");

		await h.command("disable beta");
		// `1/1·1`: the off count rides on the ratio chip rather than taking one of
		// its own, and the ratio still counts only the servers that should be up.
		assert.equal(h.plain(), "mcp 1/1·1 3 tools");

		await h.command("enable beta");
		assert.equal(h.plain(), "mcp 2/2 7 tools");

		// It really is a live update, not one repaint at the end.
		assert.ok(h.statuses.length >= 4);
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
	await withHarness({ config: { alpha: stdio(3) }, hasUI: false, mode: "print" }, async (h) => {
		await h.sessionStart();
		await h.command("disable alpha");
		assert.deepEqual(h.statuses, []);
	});
});

test("a terminal gets badges: every fact is a separately coloured chip", async () => {
	await withHarness({ config: { alpha: stdio(3), beta: stdio(4) } }, async (h) => {
		await h.sessionStart();
		await h.command("disable beta");

		const line = h.status() ?? "";
		// The label is the accent chip, and the only bold one; the ratio is green
		// because everything still switched on is up, and it carries the `·1` inside
		// that one background — a chip is painted as a single run, so the count
		// cannot be tinted separately and does not try to be.
		assert.ok(line.includes(chip("selectedBg", "accent", "\x1b[1mmcp\x1b[22m")), "no accent label chip");
		assert.ok(line.includes(chip("toolSuccessBg", "success", "1/1·1")), "ratio is not the success chip");
		assert.ok(line.includes(chip("userMessageBg", "text", "3 tools")), "tools is not the neutral chip");
		// Every fact is painted: none is left as bare text beside the coloured ones.
		// Three now rather than four — the count folded into the ratio instead of
		// spending a background of its own on one digit.
		assert.equal((line.match(/\x1b\[48;/g) ?? []).length, 3, `expected three chips in ${JSON.stringify(line)}`);
	});
});

test("the badge line survives what the footer does to it", async () => {
	// The contract this depends on, from footer.js: extension statuses are passed
	// through `sanitizeStatusText` before being drawn. Escape sequences survive,
	// but a run of two literal spaces is collapsed to one. Every space in a badge
	// line therefore has to be separated from its neighbour by an escape sequence,
	// or the padding silently shrinks on some chips and not others.
	await withHarness({ config: { alpha: stdio(3), beta: stdio(4) } }, async (h) => {
		await h.sessionStart();
		const line = h.status() ?? "";
		assert.equal(sanitize(line), line, "the footer would rewrite the badge line");
		// Stated the other way round, because this is the property that actually
		// matters: nothing visible is lost or moved.
		assert.equal(strip(sanitize(line)), strip(line));
	});
});

test("a client that is not a terminal gets the sentence, not escape codes", async () => {
	// RPC has `hasUI: true` — there is a client listening — but it renders the
	// status itself, so colour is something it would have to strip. `ctx.mode` is
	// the only signal that separates the two.
	await withHarness({ config: { alpha: stdio(3), beta: stdio(4) }, mode: "rpc" }, async (h) => {
		await h.sessionStart();
		assert.equal(h.status(), "mcp: 2/2 servers, 7 tools");
		assert.equal(strip(h.status() ?? ""), h.status());
	});
});

test("a theme that paints nothing falls back to the sentence", async () => {
	// Badges lean on colour to be separable; without it `mcp 1/1 3 tools` is a run
	// of numbers, which is worse than the prose it replaced.
	await withHarness({ config: { alpha: stdio(3) }, theme: fakeTheme({ colorless: true }) }, async (h) => {
		await h.sessionStart();
		assert.equal(h.status(), "mcp: 1/1 servers, 3 tools");
	});
});

test("a theme missing a token costs the colour, never the line", async () => {
	// pi's `fg`/`bg` throw on a token they do not know. A theme that drops one
	// must not take the status line down with it.
	await withHarness({ config: { alpha: stdio(3) }, theme: fakeTheme({ missing: "toolSuccessBg" }) }, async (h) => {
		await h.sessionStart();
		assert.equal(h.status(), "mcp: 1/1 servers, 3 tools");
	});
});

test("nothing configured still clears the entry in a terminal", async () => {
	await withHarness({ config: {} }, async (h) => {
		await h.sessionStart();
		assert.equal(h.status(), undefined);
	});
});

/** mcp's group in the shared registry, as `tone:text` pairs. */
const published = (): string[] | undefined =>
	snapshot()
		.find((group) => group.source === "mcp")
		?.badges.map((badge) => `${badge.tone}:${badge.text}`);

test("the same badges are published to the border-bar registry", async () => {
	await withHarness({ config: { alpha: stdio(3), beta: stdio(4) } }, async (h) => {
		await h.sessionStart();
		assert.deepEqual(published(), ["label:mcp", "ok:2/2", "neutral:7 tools"]);

		// And it keeps up, exactly as the footer copy does.
		await h.command("disable beta");
		assert.deepEqual(published(), ["label:mcp", "ok:1/1·1", "neutral:3 tools"]);
	});
});

test("publishing does not depend on this extension having a UI", async () => {
	// The badges are data. Whether *this* callback was handed a context it can
	// paint into says nothing about whether the extension that owns the editor can
	// draw, so the publish happens before the UI guard.
	await withHarness({ config: { alpha: stdio(3) }, hasUI: false, mode: "print" }, async (h) => {
		await h.sessionStart();
		assert.deepEqual(h.statuses, [], "the footer was written to after all");
		assert.deepEqual(published(), ["label:mcp", "ok:1/1", "neutral:3 tools"]);
	});
});

test("shutdown withdraws from the bar instead of leaving a dead snapshot", async () => {
	// Shutdown marks every connected server "error" on its way out; a bar still
	// holding the last snapshot would spend the end of the session reporting
	// failures that never happened.
	const h = harness({ config: { alpha: stdio(3) } });
	try {
		await h.sessionStart();
		assert.ok(published(), "nothing was published to begin with");
	} finally {
		await h.shutdown();
	}
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
	await withHarness({ config: { alpha: stdio(3) } }, async (h) => {
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
	await withHarness({ config: { alpha: stdio(3) } }, async (h) => {
		await h.sessionStart();
		assert.match(strip(String(h.status())), /mcp/);
		assert.match(strip(String(h.status())), /1\/1/);
	});
});

test("a renderer arriving mid-session takes the footer entry back down", async () => {
	// Extension load order is arbitrary, so this is the ordinary case rather than
	// an exotic one: mcp connects and paints its footer, and the editor mounts a
	// moment later. Without the subscription the duplicate would sit there until a
	// server changed state, which for a healthy install never happens.
	await withHarness({ config: { alpha: stdio(3) } }, async (h) => {
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
	// has to find the current badges already there, not wait for the next server
	// event to hear about them.
	await withHarness({ config: { alpha: stdio(3) } }, async (h) => {
		setRenderer(true);
		try {
			await h.sessionStart();
			assert.deepEqual(published(), ["label:mcp", "ok:1/1", "neutral:3 tools"]);
		} finally {
			setRenderer(false);
		}
	});
});

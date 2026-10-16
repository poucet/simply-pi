/**
 * MCP status badges.
 *
 * pi's **built-in** MCP support owns everything operational: it reads
 * `mcp.json`, connects the servers, runs OAuth, registers each server's tools
 * as `mcp__<server>__<tool>`, and owns the `/mcp` command. This extension does
 * none of that any more. What the builtin does *not* do is say anything
 * persistent on screen — its status lives inside `/mcp`, visible only when
 * asked. This extension is the read-only observer that fills that gap:
 *
 *   - it derives per-server state from what is observable from outside the
 *     builtin (`observe.ts`: config files, `pi.getMcpServers()`, the
 *     `mcp__*`-namespaced tools in `pi.getAllTools()`);
 *   - it publishes the badges to the shared border-badges registry, where the
 *     extension owning the editor draws them into its top border;
 *   - and when nothing is drawing that bar, it writes the same facts into the
 *     footer status line instead — badges in a terminal, a sentence elsewhere.
 *
 * It registers no tools, no commands, opens no connections, and keeps no state
 * file. The builtin exposes no failure or auth state to extensions, so the
 * phases here are the honest subset: disabled, connecting, ready (see
 * `observe.ts` for why a failed server shows as "connecting").
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { deriveServers, mergeByName, readMcpEntries, type ObservedServer } from "./observe.ts";
import { formatStatus, statusBadges, type BadgeTone, type StatusBadge, type StatusServer } from "./status.ts";
import { hasRenderer, publish, subscribe } from "../shared/border-badges.ts";

/**
 * How often the derivation is re-run when nothing announced a change.
 *
 * pi fires `mcp_servers_change` only for *registered* servers; the builtin's
 * own connects — tools appearing as a server comes up, disappearing as one is
 * disabled in `/mcp` — announce nothing an extension can hear. Polling is the
 * only trigger left, and it is cheap: `publish()` skips unchanged badge lists
 * and the footer path writes the same string into the same slot, so an
 * unchanged poll notifies nobody and repaints nothing. Overridable for tests,
 * which cannot wait two seconds per assertion.
 */
const POLL_MS = Number(process.env.PI_MCP_BADGE_POLL_MS || 2_000);

/**
 * The theme, as the footer sees it. Taken structurally off the extension context
 * rather than imported: `Theme` lives behind a deep path in pi's dist and the
 * background-colour token union is not exported at all, so deriving both from
 * the value we are handed keeps this honest against whatever pi we run under.
 */
type FooterTheme = ExtensionContext["ui"]["theme"];
type FgToken = Parameters<FooterTheme["fg"]>[0];
type BgToken = Parameters<FooterTheme["bg"]>[0];

/**
 * Tone → theme tokens.
 *
 * Every badge gets a background, and not only because that is what makes a chip
 * look like a chip: the padding around the text survives the footer's whitespace
 * collapsing precisely because it sits inside the background's escape sequence.
 * Drop the background and the badge loses its shape in both senses.
 *
 * The pairs are ones pi already draws together — each `tool*Bg` is defined in
 * every theme against the matching status colour, because that is how tool boxes
 * are painted. Borrowing them means a badge stays readable in a theme this file
 * has never seen, including one a user wrote, which hand-picked colours could
 * not promise.
 *
 * These must stay identical to `RECOMMENDED_TOKENS` in the shared registry,
 * which is what the editor-border renderer maps its tones with: the same badge
 * appearing green here and grey there is worse than either choice alone. The
 * duplication buys type safety — the registry cannot name pi's token unions
 * without importing pi — and `tests/wiring.test.ts` asserts the two agree.
 */
export const BADGE_STYLE: Record<BadgeTone, { bg: BgToken; fg: FgToken; bold?: boolean }> = {
	label: { bg: "selectedBg", fg: "accent", bold: true },
	ok: { bg: "toolSuccessBg", fg: "success" },
	pending: { bg: "toolPendingBg", fg: "accent" },
	error: { bg: "toolErrorBg", fg: "error" },
	// Same background as `error` on purpose: a login and a failure are both bad
	// news and belong to the same region of the line, and the foreground is what
	// separates "broken" from "blocked". Nothing produces these two tones today —
	// the builtin exposes neither state — but the vocabulary stays so a future
	// source of either fact needs no new plumbing.
	warn: { bg: "toolErrorBg", fg: "warning" },
	neutral: { bg: "userMessageBg", fg: "text" },
	muted: { bg: "userMessageBg", fg: "muted" },
};

/**
 * Does this theme actually paint anything?
 *
 * Badges lean entirely on their colours to be separable: strip them and
 * ` mcp  2/2  91 tools ` is a run of numbers with nothing between them, which is
 * strictly worse than the sentence it replaced. So if a theme hands text back
 * untouched — a stub, a build with colour compiled out — we would rather print
 * prose. The probe is a probe rather than a capability flag because pi's `Theme`
 * exposes no such flag; `getColorMode()` only chooses between two depths of
 * colour, never none.
 */
function themeHasColor(theme: FooterTheme): boolean {
	const probe = "x";
	try {
		return theme.fg("accent", probe) !== probe && theme.bg("selectedBg", probe) !== probe;
	} catch {
		// `fg`/`bg` throw on a token they do not know, which is its own answer.
		return false;
	}
}

/**
 * The badge row, as one string for `setStatus`.
 *
 * Exactly one space of padding per side, never two. The footer runs each
 * extension's status through a collapse of repeated literal spaces before
 * drawing it, so a two-space pad would come back as one and the badges would end
 * up unevenly sized. The single space between badges survives the same pass only
 * because escape sequences sit on either side of it, which is why this joins
 * with a plain space and pads inside the colour rather than the other way round.
 */
function renderBadges(theme: FooterTheme, badges: readonly StatusBadge[]): string {
	// Built in one pass and returned whole, so a throw part-way through discards
	// every chip rather than escaping with a half-painted line. A line that has
	// lost some of its badges is worse than one that was never painted: it still
	// looks authoritative, and the facts it dropped are exactly the ones the user
	// needed.
	return badges
		.map(({ text, tone }) => {
			const style = BADGE_STYLE[tone];
			const body = style.bold ? theme.bold(text) : text;
			return theme.bg(style.bg, theme.fg(style.fg, ` ${body} `));
		})
		.join(" ");
}

/**
 * What this run mode can actually show.
 *
 * Only a terminal gets badges. `hasUI` is true in RPC mode too, but there the
 * status is handed to a client program as a string it will render itself, and
 * escape sequences are just something for that client to strip — so RPC gets the
 * sentence. `ctx.mode` is the signal for exactly this; `hasUI` is not.
 *
 * The theme is read fresh on every call because `ui.theme` is a live getter and
 * `/theme` swaps the object underneath us. That still leaves one seam: pi has no
 * theme-change event for extensions, and the footer keeps the string we gave it,
 * so switching themes leaves the old colours until the next repaint — which the
 * poll now provides within a couple of seconds.
 */
function renderStatus(ctx: ExtensionContext, servers: readonly StatusServer[]): string | undefined {
	if (ctx.mode !== "tui") return formatStatus(servers);

	const theme = ctx.ui.theme;
	if (!themeHasColor(theme)) return formatStatus(servers);

	const badges = statusBadges(servers);
	if (!badges) return undefined;
	try {
		return renderBadges(theme, badges);
	} catch {
		// All or nothing: a theme missing one of the tokens above costs the colour,
		// never the facts. Falling back to the whole sentence keeps the line and the
		// badge row reporting the same thing, which a partial repaint would not.
		return formatStatus(servers);
	}
}

export default function mcpBadges(pi: ExtensionAPI) {
	/** Last context seen, so async repaints (the poll, a renderer appearing) have a UI to write to. */
	let statusContext: ExtensionContext | undefined;
	/**
	 * Whether a border-bar renderer existed last time we looked, and how to stop
	 * watching.
	 *
	 * Extension load order is arbitrary, so this extension routinely writes its
	 * footer entry *before* the extension that owns the editor has mounted one. Two
	 * seconds later a bar appears and the same facts are on screen twice. Watching
	 * for the transition is what closes that window without waiting for the poll.
	 */
	let rendererPresent = false;
	let unwatchRenderer: (() => void) | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	/**
	 * Everything observable, derived fresh on every call.
	 *
	 * Config entries are the two files the builtin reads — global, then the
	 * project file merged over it by name — unioned with the servers extensions
	 * registered and with any `mcp__*` tool namespace matching neither (see
	 * `observe.ts`). Reading two small files per repaint is deliberate: it is the
	 * only way a server added to `mcp.json` mid-session shows up without an event
	 * pi does not fire, and at one poll every two seconds the cost is noise.
	 */
	const observe = (ctx: ExtensionContext): StatusServer[] => {
		const configured = mergeByName(
			readMcpEntries(join(getAgentDir(), "mcp.json")),
			readMcpEntries(join(ctx.cwd, ".pi", "mcp.json")),
		);
		const registered: ObservedServer[] = pi
			.getMcpServers()
			.map(({ name, config }) => ({ name, enabled: config.enabled !== false }));
		return deriveServers(configured, registered, pi.getAllTools());
	};

	/**
	 * Refresh the badges, wherever they are drawn.
	 *
	 * Two destinations, and only ever one at a time. The badges are published to
	 * the shared registry unconditionally; the footer copy is written **only when
	 * nothing is drawing the bar**.
	 *
	 * That condition is the whole reason `hasRenderer()` exists. The bar lives in
	 * the editor's top border, and only the extension holding
	 * `setEditorComponent` can draw there — which may be disabled, or not installed.
	 * Deleting this `setStatus` outright would have meant those users lose their MCP
	 * indicator entirely, with nothing anywhere to explain why. Asking instead costs
	 * one branch and degrades to the plain footer line.
	 *
	 * Nothing in here is allowed to throw. It runs on a timer and from lifecycle
	 * events, and it is only cosmetics: a theme without a colour token, or a UI
	 * torn down a moment earlier, must not be able to surface as an extension
	 * error for a status line.
	 */
	const updateStatus = (ctx: ExtensionContext | undefined = statusContext): void => {
		if (!ctx) return;
		try {
			const states = observe(ctx);

			// Published unconditionally, before the UI guard: badges are data, not
			// paint. Whether *this* callback was handed a context it can draw into
			// says nothing about whether the extension owning the editor can draw.
			// `publish` is documented never to throw and to skip unchanged lists.
			publish("mcp", statusBadges(states));

			if (!ctx.hasUI) return; // print/json modes have no status line to write to
			statusContext = ctx;
			// `undefined` clears the entry — both when no MCP is configured (no footer
			// clutter) and when the border bar is showing these same badges (no saying
			// it twice). Recomputed on every call rather than latched, so an editor
			// arriving or going away is picked up by the next repaint; `onRendererChange`
			// below is what makes sure there *is* a next repaint.
			ctx.ui.setStatus("mcp", hasRenderer() ? undefined : renderStatus(ctx, states));
		} catch {
			// Deliberately silent: the only way to report this would be another call
			// into the same UI that just failed.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		statusContext = ctx;

		// Only presence changes matter here. Subscribing to badge changes as well
		// would mean reacting to our own `publish` on every repaint — harmless,
		// because an unchanged republish notifies nobody, but a pointless extra
		// repaint each time. Comparing against the last seen value makes the
		// filter explicit.
		rendererPresent = hasRenderer();
		unwatchRenderer?.();
		unwatchRenderer = subscribe(() => {
			const present = hasRenderer();
			if (present === rendererPresent) return;
			rendererPresent = present;
			// Repaints the footer: writes the entry when the bar has gone away, clears it
			// when the bar has arrived.
			updateStatus();
		});

		// The initial paint says "connecting" for every enabled server, because the
		// builtin's connects have not registered tools yet — exactly the right first
		// word. The poll then watches the counts climb as servers come up.
		updateStatus(ctx);
		pollTimer = setInterval(() => updateStatus(), POLL_MS);
		// A status poll must never be the reason the process cannot exit.
		pollTimer.unref?.();
	});

	// Fired when an extension registers or unregisters a server. The builtin
	// reacts by connecting/dropping it; this observer only needs to repaint —
	// the new server shows as "connecting" until its tools appear to the poll.
	pi.on("mcp_servers_change", async () => {
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		// Clear the footer entry and withdraw from the bar: a dead session's last
		// snapshot sitting in either place would look authoritative while being
		// nobody's problem to update. Guarded because a UI that has already gone
		// away must not turn teardown into an error.
		try {
			if (statusContext?.hasUI) statusContext.ui.setStatus("mcp", undefined);
		} catch {
			// Nothing to do about it, and nowhere left to say so.
		}
		try {
			unwatchRenderer?.();
		} catch {
			/* the store has already forgotten us */
		}
		unwatchRenderer = undefined;
		publish("mcp", undefined);
		statusContext = undefined;
	});
}

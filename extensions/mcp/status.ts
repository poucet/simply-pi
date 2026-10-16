/**
 * The MCP footer line.
 *
 * pi's built-in `/mcp` answers "what is going on with my servers?" in full, but
 * only when you ask. Connecting to a remote server takes seconds, servers fail
 * quietly, and disabling one changes what the model can see — none of which is
 * visible unless something durable says so. The border badge bar and
 * `ctx.ui.setStatus("mcp", …)` are that durable place, and this module decides
 * what it says.
 *
 * It says it twice. `statusBadges` is the form a terminal gets — a row of
 * coloured chips, because the footer is scanned rather than read and a chip is
 * the only thing on that line a glance can land on. `formatStatus` is the same
 * facts as a sentence, for everywhere that cannot show colour. They are built
 * from one set of counts and share the decision about what is worth mentioning,
 * so the two can never end up disagreeing about whether a server failed.
 *
 * Kept pure (no pi imports, no clients, no terminal) so every state is testable
 * headlessly; `observe.ts` derives the `StatusServer`s from what pi's builtin
 * lets an extension see, and `index.ts` owns the tone → theme-token mapping,
 * which is the only part that needs a terminal to mean anything.
 */

/**
 * Lifecycle of one server. The full vocabulary is kept, but since the move to
 * pi's built-in MCP only "disabled", "connecting" and "ready" are ever produced:
 * the builtin exposes no failure or auth state to extensions, so `observe.ts`
 * cannot distinguish a failed or login-blocked server from one still dialling
 * (see its header). "error" and "needs auth" stay so the vocabulary — and the
 * renderings below, which are pure and tested — are ready the day pi exposes
 * the facts.
 */
export type StatusPhase = "connecting" | "ready" | "error" | "disabled" | "needs auth";

/** The only thing the footer needs to know about a server. */
export interface StatusServer {
	status: StatusPhase;
	/** Tools currently exposed by this server. */
	tools: number;
}

export interface StatusCounts {
	/** Servers expected to be usable: everything except the ones switched off. */
	configured: number;
	connecting: number;
	ready: number;
	failed: number;
	needsAuth: number;
	off: number;
	tools: number;
}

export function countServers(servers: readonly StatusServer[]): StatusCounts {
	const counts: StatusCounts = {
		configured: 0,
		connecting: 0,
		ready: 0,
		failed: 0,
		needsAuth: 0,
		off: 0,
		tools: 0,
	};
	for (const server of servers) {
		if (server.status === "disabled") {
			counts.off += 1;
			continue;
		}
		counts.configured += 1;
		switch (server.status) {
			case "connecting":
				counts.connecting += 1;
				break;
			case "ready":
				counts.ready += 1;
				counts.tools += server.tools;
				break;
			case "error":
				counts.failed += 1;
				break;
			case "needs auth":
				counts.needsAuth += 1;
				break;
		}
	}
	return counts;
}

/**
 * The badge vocabulary now lives in `extensions/shared/border-badges.ts`,
 * because the same badges are drawn in two places by two different extensions:
 * this one paints them into the footer status line, and whichever extension owns
 * the editor paints them into its top border. Neither renderer can be made to
 * import the other's package, so the shared contract sits outside both.
 *
 * Re-exported here so callers of `statusBadges` keep getting the type from the
 * module that produced the value. `import type` leaves nothing behind at
 * runtime, so this file stays as free of dependencies as its header promises.
 */
export type { BadgeTone, StatusBadge } from "../shared/border-badges.ts";
import type { BadgeTone, StatusBadge } from "../shared/border-badges.ts";

/**
 * The facts that follow the headline, in a fixed order, each already carrying
 * the tone it should be shown in.
 *
 * Shared by both renderings on purpose. These are the parts that report trouble,
 * and a badge line that omits a failure the sentence mentions — or the reverse —
 * is worse than either alone, because the user has no way to tell which one is
 * lying. Deciding it once removes the possibility.
 *
 * The switched-off count is the one fact not settled here, because the two
 * renderings put it in genuinely different places: the badges fold it into the
 * ratio chip as `2/2·1` (see `ratioText`), the sentence keeps it as a trailing
 * `, 1 off` because `·` is not something prose can say. `includeOff` is how a
 * caller declares which of the two it is doing — nobody gets to *forget* the
 * count, they only get to choose where it goes.
 */
function trailingParts(counts: StatusCounts, includeOff: boolean): StatusBadge[] {
	const parts: StatusBadge[] = [];
	// A server still connecting is not a failure; keep it distinct from both.
	if (counts.connecting > 0 && counts.ready > 0) {
		parts.push({ text: `${counts.connecting} connecting`, tone: "pending" });
	}
	if (counts.failed > 0) parts.push({ text: `${counts.failed} failed`, tone: "error" });
	// Needing a login is a warning, not an error: nothing is broken and the fix is
	// a command away. pi's builtin draws the same distinction in `/mcp`, and the
	// footer should not contradict it.
	if (counts.needsAuth > 0) {
		parts.push({ text: `${counts.needsAuth} need${counts.needsAuth === 1 ? "s" : ""} login`, tone: "warn" });
	}
	if (includeOff && counts.off > 0) parts.push({ text: `${counts.off} off`, tone: "muted" });
	return parts;
}

/**
 * The headline chip's text: `2/2`, or `2/2·1` when something is switched off.
 *
 * The disabled server stays *out* of the ratio — it is `2/2·1`, never `2/3`.
 * The ratio means "of the servers that should be up, how many are", which is
 * exactly what makes anything below `N/N` a reliable at-a-glance "something is
 * wrong"; moving a deliberately disabled server into the denominator would make a
 * choice the user made look like a failure. The count is appended rather than
 * merged for that reason: it is a different kind of fact, so it gets its own
 * position and its own separator instead of quietly changing what `/` counts.
 * Its stale tools stay out of the tool total on the same grounds — the model
 * cannot see them.
 *
 * Omitted entirely at zero: an install with nothing switched off reads exactly
 * as it always did, and a `·0` would spend columns saying nothing happened.
 */
function ratioText(counts: StatusCounts): string {
	const ratio = `${counts.ready}/${counts.configured}`;
	return counts.off > 0 ? `${ratio}·${counts.off}` : ratio;
}

/**
 * The tone of the `N/M` chip: the worst thing currently true of the set.
 *
 * It repeats what the trailing chips already say, and that is the point — the
 * ratio is the chip a glance lands on first, so it has to carry the bad news by
 * itself. The precedence follows how much the user has to do about each state: a
 * failure wants investigating, a login wants a command, a connection wants only
 * patience.
 */
function ratioTone(counts: StatusCounts): BadgeTone {
	if (counts.failed > 0) return "error";
	if (counts.needsAuth > 0) return "warn";
	if (counts.connecting > 0) return "pending";
	return "ok";
}

/**
 * The footer as chips, e.g. `mcp` `3/4` `27 tools` `1 failed`.
 *
 * The switched-off count rides on the ratio chip (`2/2·1`) rather than taking a
 * chip of its own, because a chip is the expensive unit here: it costs its
 * padding, its separator and a background the eye has to land on, all to carry
 * one digit that changes only when the user changes it. In the sentence it
 * stays a trailing `, 1 off`, which is what prose can actually say.
 *
 * Same information and the same `undefined`-means-nothing-to-say contract as
 * `formatStatus`; only the shape differs. Two things are shorter here than in
 * the sentence, both because this line is shared with every other extension's
 * status and columns are the scarce resource:
 *
 *   - the word "servers" is dropped, since the `mcp` chip on the left already
 *     names the subject and the `N tools` chip on the right settles what else
 *     the ratio could have been counting;
 *   - "connecting to 2 servers…" becomes "connecting 2…", which a chip can get
 *     away with because it is read as a label rather than as prose.
 */
export function statusBadges(servers: readonly StatusServer[]): StatusBadge[] | undefined {
	const counts = countServers(servers);

	// Same reasoning as formatStatus: only-off is still worth a chip, nothing at
	// all is worth none. This is the one case where the count cannot ride on the
	// ratio, because there is no ratio to ride on — so here it keeps both the
	// words and `muted`, which is what a state that is nobody's problem should
	// look like.
	if (counts.configured === 0) {
		if (counts.off === 0) return undefined;
		return [{ text: "mcp", tone: "label" }, { text: `${counts.off} off`, tone: "muted" }];
	}

	const badges: StatusBadge[] = [{ text: "mcp", tone: "label" }];

	// Whether the switched-off count found a ratio to ride on. The startup branch
	// has no ratio chip, so there it falls back to its own `N off` chip rather
	// than being dropped: the count is a fact, and which chip carries it is a
	// layout detail that must not be able to lose it.
	const ratioCarriesOff = !(counts.ready === 0 && counts.connecting > 0);

	if (!ratioCarriesOff) {
		// A `0/2` chip during startup is indistinguishable from two dead servers,
		// and in red it is actively alarming. The ellipsis says the number is still
		// moving. The tool count is omitted rather than shown as zero for the same
		// reason — nothing has reported its tools yet.
		badges.push({ text: `connecting ${counts.connecting}…`, tone: "pending" });
	} else {
		// One chip, one tone. A chip is painted as a single run — the composer has
		// no notion of two colours inside one pill, and giving it one would disturb
		// the exact-width arithmetic the border bar is built on. So the ratio's own
		// tone covers the whole chip, which is the right answer anyway: the count is
		// a footnote to the health signal rather than a competing one.
		badges.push({ text: ratioText(counts), tone: ratioTone(counts) });
		badges.push({ text: `${counts.tools} tool${counts.tools === 1 ? "" : "s"}`, tone: "neutral" });
	}

	badges.push(...trailingParts(counts, !ratioCarriesOff));
	return badges;
}

/**
 * The footer as a sentence, e.g. `mcp: 3/4 servers, 27 tools, 1 failed`.
 *
 * Returns `undefined` when there is nothing to say — no servers configured at
 * all — which is also how the status is cleared, so a user without MCP never
 * sees an empty `mcp:` sitting in their footer.
 *
 * The ratio is deliberate: `1/2` says one of the two servers you asked for is
 * not there, which a bare `1 server` would hide. A failure is never left to be
 * inferred from the ratio alone; it gets its own words.
 *
 * Unlike the badges, this keeps `1 off` as a trailing clause rather than folding
 * it into the ratio. `2/2·1` is a thing you look at, not a thing you read; the
 * sentence exists precisely for the places that cannot show chips, so it says
 * the number in words instead of borrowing a notation from a rendering that is
 * not available there.
 */
export function formatStatus(servers: readonly StatusServer[]): string | undefined {
	const counts = countServers(servers);

	// Nothing but switched-off servers: still worth a word (their tools are
	// missing on purpose, and `/mcp` is where you turn them back on), but only
	// if the user actually configured something.
	if (counts.configured === 0) {
		return counts.off > 0 ? `mcp: ${counts.off} off` : undefined;
	}

	// While the first connections are in flight, the ratio would read `0/2` and
	// look like a failure. Say what is actually happening instead.
	const head =
		counts.ready === 0 && counts.connecting > 0
			? `mcp: connecting to ${counts.connecting} server${counts.connecting === 1 ? "" : "s"}…`
			: `mcp: ${counts.ready}/${counts.configured} servers, ${counts.tools} tool${counts.tools === 1 ? "" : "s"}`;

	const parts = trailingParts(counts, true).map((part) => part.text);

	return parts.length > 0 ? `${head}, ${parts.join(", ")}` : head;
}

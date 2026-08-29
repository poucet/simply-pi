/**
 * Which of the parent's extensions a child does *not* get.
 *
 * A subagent inherits your normal auto-discovered extensions, so it is the same
 * agent as you, elsewhere: your providers, your rendering, your configuration.
 * The exceptions are one user-editable denylist rather than a scatter of
 * per-extension settings, so "what does a child load?" has a single answer.
 *
 * ## How this is implemented, and why
 *
 * pi's `--no-extensions` is all-or-nothing and there is no per-extension exclude
 * flag, so the policy cannot be expressed through the CLI alone. Three options
 * were on the table:
 *
 *   (a) an env var plus a guard inside each denied extension. Trivial for the
 *       ones in this repo, but it cannot deny an extension we do not control —
 *       a half-policy, and silently so.
 *   (b) `--no-extensions` plus an explicit `-e` per surviving extension, with
 *       discovery reimplemented here. Faithful, but a copy of pi's resolution
 *       order that would drift the first time pi changed it.
 *   (c) `--no-extensions` plus an explicit `-e` per surviving extension, where
 *       the survivors come from **pi's own discovery** — `DefaultPackageManager`
 *       and `SettingsManager` are both exported.
 *
 * (c) is what this does. It is (b) without the reimplementation: pi answers
 * "what would be loaded here?", we subtract the denylist, and pass the rest.
 * Third-party extensions are inheritable *and* deniable, and there is no second
 * copy of the discovery rules to keep in sync.
 *
 * The subagents extension itself is **not** excluded. A child inherits it and
 * therefore gets the `subagent` tool: subagents may spawn subagents, and the
 * framework's job is to make the tree visible rather than to forbid depth. What
 * a child does not inherit is the *user interface* — `index.ts` suppresses the
 * widget, the editor component, the footer status and `/agents` when it sees the
 * `PI_SUBAGENT=1` boot flag, because a child has no terminal of its own to paint
 * into. Put `subagents` in `childDeny` to opt a project out of nesting.
 */

import { basename, dirname, resolve as resolvePath } from "node:path";

/**
 * Denied out of the box.
 *
 * - `slack-approval`: it opens a dialog, and a dialog in a child **hangs it
 *   forever** — `ChildRpc` does not implement `extension_ui_request` yet, so
 *   nothing ever answers. That is a property of any dialog-opening extension,
 *   not a dislike of this one.
 *
 * `mcp` used to be here, denied wholesale because booting a couple of servers
 * and ~90 tools inside every child, on every spawn, is a real cost for tools
 * most delegated tasks never touch. That was the right worry and the wrong
 * lever: it also denied the child that genuinely needs one server. The cost is
 * now controlled by **which servers** a child boots rather than by whether it
 * gets MCP at all — an allowlist that is empty by default, so an unconfigured
 * child still boots nothing. See `shared/mcp-scope.ts` and `mcpScope` in
 * `manager.ts`. Denying `mcp` here still works and is still stronger: it stops
 * the extension loading rather than starving it of servers.
 */
export const DEFAULT_CHILD_DENY = ["slack-approval"];

/**
 * The name an extension is known by, derived from its path.
 *
 * Mirrors how pi presents discovered extensions: the file stem for
 * `extensions/foo.ts`, the directory name for `extensions/foo/index.ts`. Both
 * are matched, so `"mcp"` denies `extensions/mcp/index.ts` and `"model-routing"`
 * denies `extensions/model-routing.ts`.
 */
export function extensionName(path: string): string {
	const file = basename(path);
	const stem = file.replace(/\.(ts|mts|cts|js|mjs|cjs)$/i, "");
	// `foo/index.ts` is the directory's extension, not one called "index".
	if (stem.toLowerCase() === "index") return basename(dirname(path));
	return stem;
}

/**
 * Whether one denylist entry matches one discovered extension path.
 *
 * An entry is either a plain name (`"mcp"`, matched case-insensitively against
 * the discovery name) or an absolute path (matched against the resolved path, so
 * two identically named extensions in different directories stay separable).
 */
export function denyMatches(entry: string, path: string): boolean {
	const trimmed = entry.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
		const expanded = trimmed.startsWith("~")
			? trimmed.replace(/^~/, process.env.HOME ?? "~")
			: trimmed;
		return resolvePath(expanded) === resolvePath(path);
	}
	// A plain entry may still be written with the extension on it.
	const normalized = trimmed.replace(/\.(ts|mts|cts|js|mjs|cjs)$/i, "").replace(/\/+$/, "");
	return normalized.toLowerCase() === extensionName(path).toLowerCase();
}

export interface DenyPartition {
	/** Extensions the child should load, in discovery order. */
	allowed: string[];
	/** Extensions withheld, with the entry that withheld each. */
	denied: Array<{ path: string; entry: string }>;
	/**
	 * Entries that matched nothing.
	 *
	 * Reported rather than ignored: a mistyped entry denies nothing at all, and
	 * silently getting *more* than you asked for is the wrong failure direction
	 * for a setting whose whole job is exclusion.
	 */
	unmatched: string[];
}

/**
 * Split discovered extensions into what a child loads and what it does not.
 *
 * `alwaysDeny` carries the paths that are excluded structurally rather than by
 * user choice — this extension's own file, which must never be inherited.
 */
export function partitionExtensions(
	discovered: readonly string[],
	denyList: readonly string[],
	alwaysDeny: readonly string[] = [],
): DenyPartition {
	const allowed: string[] = [];
	const denied: Array<{ path: string; entry: string }> = [];
	const used = new Set<string>();

	for (const path of discovered) {
		const structural = alwaysDeny.some(
			(other) => resolvePath(other) === resolvePath(path) || extensionName(other) === extensionName(path),
		);
		if (structural) {
			denied.push({ path, entry: "(always)" });
			continue;
		}
		const entry = denyList.find((candidate) => denyMatches(candidate, path));
		if (entry === undefined) {
			allowed.push(path);
			continue;
		}
		used.add(entry);
		denied.push({ path, entry });
	}

	return {
		allowed,
		denied,
		unmatched: denyList.filter((entry) => entry.trim() && !used.has(entry)),
	};
}

/** Normalize the `childDeny` setting, falling back to the default list. */
export function parseDenyList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [...DEFAULT_CHILD_DENY];
	const entries = raw.filter((value): value is string => typeof value === "string" && value.trim() !== "");
	// An explicit empty array means "deny nothing"; only a missing or malformed
	// value falls back to the defaults.
	return entries.map((entry) => entry.trim());
}

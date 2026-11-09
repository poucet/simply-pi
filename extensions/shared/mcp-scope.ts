/**
 * Which MCP servers a subagent boots.
 *
 * ## Why this exists at all
 *
 * `mcp` used to be denied to children outright (`DEFAULT_CHILD_DENY`), for a
 * concrete reason: booting a couple of servers and ~90 tools inside *every*
 * child, on *every* spawn, for tools most delegated tasks never touch. That
 * denial threw out the useful case with the expensive one — a research child
 * genuinely wants Notion, and had no way to get it.
 *
 * So the extension is inherited again and the cost is controlled one level
 * down: by which **servers** a child boots, not by whether it has MCP at all.
 *
 * ## Allowlist, not blocklist — and why that direction
 *
 * The scope is an **allowlist**, and the default is the **empty** one: a child
 * with no configured scope boots no MCP servers, exactly as if the extension
 * had been denied. Behaviour therefore does not change for anyone until they
 * ask for it, and the thing being avoided — 90 tools appearing inside a child
 * by accident — cannot happen by omission.
 *
 * A blocklist fails the other way: every server added to `mcp.json` later would
 * silently join every child ever spawned, which is precisely the cost the
 * denial was protecting against. An allowlist's failure mode is a child missing
 * a server and saying so; a blocklist's is a bill.
 *
 * `"*"` is accepted as "every configured server" for the person who genuinely
 * wants the old inherit-everything behaviour, so the strict default is a
 * default rather than a ceiling.
 *
 * ## How the scope reaches the child, and why it is an env var
 *
 * A child is a separate `pi` process. The obvious mechanisms are all worse:
 *
 *   - **`mcp-state.json`** (the `/mcp disable` state) is *global*. A child
 *     writing it would change the parent's and every sibling's view of which
 *     servers are on. Two concurrent children with different scopes would race
 *     each other through one file. Non-starter.
 *   - **A per-child config file** would work, but it is a temp file to create,
 *     clean up and leak, for one small list.
 *   - **An env var** is per-process by construction. It cannot race, it cannot
 *     outlive the process, and two children with different scopes are two
 *     different values of the same variable in two different environments.
 *
 * The variable is only honoured when `PI_SUBAGENT=1`, so nothing a user has
 * exported into their own shell can quietly narrow their *own* MCP servers.
 *
 * ## Who enforces it
 *
 * MCP is pi's built-in extension, which knows nothing of this variable. The
 * parent enforces the scope by what it loads into the child
 * (`childExtensionArgs` in subagents/manager.ts): no `builtin:mcp` for an empty
 * scope, `builtin:mcp` for `"*"`, and for named servers
 * `subagents/child-mcp.ts`, which builds the builtin with its config narrowed
 * by `mcpScopeAllows`, reading the scope back through `childMcpScope`.
 */

/**
 * The child's MCP allowlist, as a comma-separated list of server names.
 *
 * Deliberately distinguishes "empty" from "unset": an empty string means an
 * explicit empty allowlist ("boot nothing"), and an unset variable means the
 * parent said nothing — which for a child is also "boot nothing", but for a
 * non-subagent process means "not scoped at all". Encoding both as absence
 * would make the parent unable to express "no servers" any differently from a
 * child launched by an older parent.
 */
export const MCP_SCOPE_ENV = "PI_SUBAGENT_MCP";

/** The wildcard entry: every server the config defines. */
export const MCP_SCOPE_ALL = "*";

/**
 * Normalize a configured allowlist into the canonical form stored and passed.
 *
 * Anything that is not an array of strings becomes `undefined` — "nothing was
 * configured" — rather than an empty list, because the two mean different
 * things one layer up: `undefined` lets a more general layer supply a value,
 * `[]` is a deliberate "no servers" that must beat it.
 */
export function parseMcpScope(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const entries = raw
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter((value) => value !== "");
	// Duplicates and ordering carry no meaning; a stable shape keeps the launch
	// spec comparable across a revive.
	return [...new Set(entries)].sort();
}

/** Encode an allowlist for the child's environment. See `MCP_SCOPE_ENV`. */
export function encodeMcpScope(scope: readonly string[] | undefined): string {
	return (scope ?? []).join(",");
}

/** Decode what `encodeMcpScope` wrote. An unset variable is an empty allowlist. */
export function decodeMcpScope(raw: string | undefined): string[] {
	if (!raw) return [];
	return [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * Whether a server name is inside an allowlist.
 *
 * Case-insensitive, because server names come from hand-written JSON and a
 * child silently losing `Notion` because the config said `notion` would be the
 * same silent-drop failure this whole change is about.
 */
export function mcpScopeAllows(scope: readonly string[], server: string): boolean {
	if (scope.includes(MCP_SCOPE_ALL)) return true;
	const wanted = server.toLowerCase();
	return scope.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * The scope this process must obey, or `undefined` when it is not scoped.
 *
 * `undefined` is the answer for a normal (non-subagent) pi process: it means
 * "this mechanism does not apply to you", which is different from the empty
 * allowlist a child gets. Only the boot flag switches it on, so the variable is
 * inert in an ordinary shell.
 */
export function childMcpScope(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
	const flag = env.PI_SUBAGENT;
	const isChild =
		(typeof flag === "string" && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false") ||
		Boolean(env.PI_SUBAGENT_NAME);
	if (!isChild) return undefined;
	return decodeMcpScope(env[MCP_SCOPE_ENV]);
}

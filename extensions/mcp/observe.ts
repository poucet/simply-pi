/**
 * What of pi's built-in MCP support can be observed from outside it.
 *
 * pi's builtin owns everything operational about MCP — connections, OAuth,
 * `/mcp`, tool registration — and exposes **no API for its connection state**.
 * There is no event for "server failed" or "server needs a login", and nothing
 * an extension can call to ask. What *is* observable, and what this module
 * works from:
 *
 *   - the config the builtin reads: `<agentDir>/mcp.json` and, for trusted
 *     projects, `<cwd>/.pi/mcp.json`, shape `{ "mcpServers": { name: config } }`,
 *     where `"enabled": false` means "kept but not connected";
 *   - the servers extensions registered, via `pi.getMcpServers()`;
 *   - the tools the builtin has registered, via `pi.getAllTools()`: each carries
 *     `namespace.name === "mcp__<server with - replaced by _>"`, and a tool the
 *     server has since dropped is re-registered with `exposure: "hidden"`
 *     (pi cannot unregister tools), so hidden tools must not be counted.
 *
 * The honest limit of that: an enabled server with tools is **ready**, an
 * enabled server without any is **connecting** — which is what a server that
 * failed, or is waiting for a login, also looks like from here. The
 * `StatusPhase` values "error" and "needs auth" survive in `status.ts` because
 * the vocabulary is still true, but nothing in this module can produce them.
 * A badge row that said "1 failed" on evidence this thin would be guessing;
 * "connecting" is merely incomplete, which is the better failure mode.
 *
 * Kept free of pi imports so every derivation is testable headlessly;
 * `index.ts` feeds it the live `pi.getMcpServers()` / `pi.getAllTools()` output
 * and the config file paths.
 */

import { readFileSync } from "node:fs";
import type { StatusServer } from "./status.ts";

/** A server as far as this observer can know one: a name and whether it should be up. */
export interface ObservedServer {
	name: string;
	enabled: boolean;
}

/** The slice of pi's `ToolInfo` the derivation reads. Structural, so tests need no pi. */
export interface ObservedTool {
	exposure?: string;
	namespace?: { name: string };
}

/**
 * Namespace of a server's tools, exactly as pi's `mcpNamespace` computes it:
 * `mcp__<server>` with `-` replaced by `_`. Duplicated rather than imported
 * because pi does not export it; one line, asserted against real tool output
 * in the tests.
 */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

/**
 * Parse one `mcp.json`'s worth of server entries.
 *
 * Tolerant by design: a missing file, unparseable JSON or a shape that is not
 * `{ mcpServers: { … } }` contributes nothing, silently. The builtin already
 * validates the same file and reports its errors to the user; a second report
 * from a status overlay would say everything twice, and a throw here would cost
 * the badges of every *other* server in the file.
 */
export function parseMcpJson(text: string): ObservedServer[] {
	try {
		const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
		const entries = parsed?.mcpServers;
		if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return [];
		return Object.entries(entries).map(([name, config]) => ({
			name,
			// `enabled: false` is the builtin's "kept but not connected". Anything
			// else — including shapes the builtin would reject — counts as enabled:
			// over-counting shows one more "connecting" chip, under-counting hides a
			// server that is actually up.
			enabled: !(typeof config === "object" && config !== null && (config as { enabled?: unknown }).enabled === false),
		}));
	} catch {
		return [];
	}
}

/** `parseMcpJson` over a file that may not exist or may not be JSON. */
export function readMcpEntries(file: string): ObservedServer[] {
	try {
		return parseMcpJson(readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

/**
 * Later lists replace earlier entries with the same name — how the builtin
 * merges the project `mcp.json` over the global one.
 */
export function mergeByName(...lists: ReadonlyArray<readonly ObservedServer[]>): ObservedServer[] {
	const byName = new Map<string, ObservedServer>();
	for (const list of lists) {
		for (const server of list) byName.set(server.name, server);
	}
	return [...byName.values()];
}

/**
 * The server set and each server's phase, from everything observable.
 *
 * The union mirrors the builtin's precedence: `configured` (project entries
 * already merged over global by the caller) wins over `registered` when both
 * name the same server — matched on namespace, as the builtin matches them,
 * so `my-server` in config overrides a registered `my_server`. Any `mcp__*`
 * namespace seen in the tools that matches neither is counted too, as an
 * enabled server: the builtin is demonstrably running it (its tools exist),
 * whatever this observer failed to find in config — an untrusted project file,
 * a config source a future pi grows. Only non-hidden tools can introduce such
 * a server, so it is always "ready" by construction.
 */
export function deriveServers(
	configured: readonly ObservedServer[],
	registered: readonly ObservedServer[],
	tools: readonly ObservedTool[],
): StatusServer[] {
	// namespace -> server, config first so a registered duplicate cannot displace it.
	const byNamespace = new Map<string, ObservedServer>();
	for (const server of configured) {
		byNamespace.set(mcpNamespace(server.name), server);
	}
	for (const server of registered) {
		const ns = mcpNamespace(server.name);
		if (!byNamespace.has(ns)) byNamespace.set(ns, server);
	}

	// Visible (non-hidden) tools per namespace. Hidden is the builtin's way of
	// withdrawing a tool it cannot unregister; the model cannot call it, so the
	// count must not include it.
	const toolCounts = new Map<string, number>();
	for (const tool of tools) {
		const ns = tool.namespace?.name;
		if (!ns || !ns.startsWith("mcp__") || tool.exposure === "hidden") continue;
		toolCounts.set(ns, (toolCounts.get(ns) ?? 0) + 1);
	}

	const servers: StatusServer[] = [];
	for (const [ns, server] of byNamespace) {
		const count = toolCounts.get(ns) ?? 0;
		toolCounts.delete(ns);
		servers.push({
			// See the module header: "connecting" is the honest reading of "enabled
			// but no tools yet" — failure and pending-login are indistinguishable
			// from here, and this observer does not guess.
			status: !server.enabled ? "disabled" : count > 0 ? "ready" : "connecting",
			tools: count,
		});
	}

	// Namespaces with visible tools that matched no known server.
	for (const count of toolCounts.values()) {
		servers.push({ status: "ready", tools: count });
	}

	return servers;
}

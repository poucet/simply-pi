/**
 * MCP server configuration discovery.
 *
 * Config files use the widely adopted `mcpServers` shape:
 *
 * {
 *   "mcpServers": {
 *     "linear":     { "url": "https://mcp.linear.app/mcp", "bearerToken": "${LINEAR_TOKEN}" },
 *     "docs":       "https://example.com/mcp",
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
 *   }
 * }
 *
 * Files are merged in increasing precedence:
 *   1. ~/.pi/agent/mcp.json
 *   2. <cwd>/.mcp.json
 *   3. <cwd>/.pi/mcp.json
 *   4. $PI_MCP_CONFIG (colon separated list of files)
 *
 * Inside a subagent the merged result is then narrowed to the servers the parent
 * scoped that child to — see `shared/mcp-scope.ts` for why children get an
 * allowlist rather than the whole config, and why it arrives as an env var
 * instead of through the shared `mcp-state.json`.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { childMcpScope, mcpScopeAllows } from "../shared/mcp-scope.ts";

export interface ServerConfig {
	name: string;
	/** remote (primary): streamable HTTP or legacy HTTP+SSE */
	url?: string;
	headers?: Record<string, string>;
	/** Transport hint. "auto" (default) probes streamable HTTP then falls back to legacy SSE. */
	mode?: "auto" | "streamable" | "sse";
	/** Convenience auth: turns into an Authorization header. */
	bearerToken?: string;
	/**
	 * Shell command whose stdout is the bearer token (vault/CLI-issued API keys).
	 * Run on every (re)connect. Relative paths resolve against the config file.
	 */
	bearerTokenCommand?: string;
	/**
	 * OAuth 2.1 behaviour for remote servers:
	 *   "auto" (default) — use OAuth when the server challenges with 401
	 *   "oauth"          — always attach OAuth credentials
	 *   "none"           — never; only static headers/tokens
	 */
	auth?: "auto" | "oauth" | "none";
	/** Pre-registered OAuth client, for servers without dynamic client registration. */
	clientId?: string;
	clientSecret?: string;
	/** OAuth scopes to request (defaults to what the server advertises). */
	scope?: string;
	/** Retries for connection-level failures on remote servers. */
	maxRetries?: number;
	/** local (optional): stdio child process */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** behaviour */
	disabled?: boolean;
	timeoutMs?: number;
	connectTimeoutMs?: number;
	/** Optional allow/deny lists of MCP tool names (unprefixed). */
	includeTools?: string[];
	excludeTools?: string[];
	/** Overrides the `mcp__<server>__` tool name prefix. */
	toolPrefix?: string;
	/** Source config file, for diagnostics. */
	source?: string;
}

export interface LoadedConfig {
	servers: ServerConfig[];
	files: string[];
	errors: string[];
}

/**
 * Runtime on/off overrides (`/mcp enable|disable|toggle`), kept out of the config
 * files so a toggle never rewrites hand-edited JSON. Global across projects.
 */
const STATE_FILE = join(homedir(), ".pi", "agent", "mcp-state.json");

export function loadDisabledServers(): Set<string> {
	// A subagent never reads the shared toggle state, and `saveDisabledServers`
	// refuses to write it: a child that inherited the parent's `/mcp disable`
	// choices would have its scope silently narrowed by an unrelated decision, and
	// one that *wrote* them would change the parent's view from another process.
	// A child's server set is decided entirely by its scope (see below).
	if (childMcpScope()) return new Set();
	try {
		if (!existsSync(STATE_FILE)) return new Set();
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { disabled?: unknown };
		if (!Array.isArray(parsed.disabled)) return new Set();
		return new Set(parsed.disabled.filter((name): name is string => typeof name === "string"));
	} catch {
		return new Set();
	}
}

export function saveDisabledServers(disabled: Set<string>): void {
	// Global across projects *and* across processes, so a child must never touch
	// it: `/mcp disable` inside a subagent would reach out of that subagent and
	// turn the server off for the parent and every sibling. Two concurrent
	// children would additionally race each other through the one file. The toggle
	// stays session-only inside a child, which is the same degradation a read-only
	// home directory already produces.
	if (childMcpScope()) return;
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// A read-only home directory just means the toggle is session-only.
	}
}

/** Expand ${VAR} / ${VAR:-default} / $VAR references from process.env. */
export function expandEnv(value: string): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
			return process.env[name] ?? fallback ?? "";
		})
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => process.env[name] ?? match);
}

function expandDeep<T>(value: T): T {
	if (typeof value === "string") return expandEnv(value) as unknown as T;
	if (Array.isArray(value)) return value.map((item) => expandDeep(item)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = expandDeep(item);
		return out as T;
	}
	return value;
}

function candidateFiles(cwd: string): string[] {
	const files = [
		join(homedir(), ".pi", "agent", "mcp.json"),
		join(cwd, ".mcp.json"),
		join(cwd, ".pi", "mcp.json"),
	];
	const extra = process.env.PI_MCP_CONFIG;
	if (extra) {
		for (const entry of extra.split(":")) {
			if (entry.trim()) files.push(resolve(cwd, entry.trim()));
		}
	}
	return files;
}

function normalize(name: string, raw: unknown, source: string): ServerConfig | string {
	// Shorthand: "my-server": "https://example.com/mcp"
	if (typeof raw === "string") {
		return { name, source, url: expandEnv(raw), mode: "auto" };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return `server "${name}" in ${source} must be an object or a URL string`;
	}

	const anyRaw = raw as Record<string, any>;
	const config: ServerConfig = { name, source, ...(expandDeep(raw) as Partial<ServerConfig>) };
	config.name = name;
	config.source = source;

	// Common aliases seen in the wild.
	if (!config.url && typeof anyRaw.endpoint === "string") config.url = expandEnv(anyRaw.endpoint);
	if (!config.url && typeof anyRaw.serverUrl === "string") config.url = expandEnv(anyRaw.serverUrl);
	if (typeof anyRaw.timeout === "number" && config.timeoutMs === undefined) config.timeoutMs = anyRaw.timeout;

	// "type"/"transport": "http" | "streamable-http" | "sse" | "stdio"
	const declared = String(anyRaw.type ?? anyRaw.transport ?? "").toLowerCase();
	if (declared === "sse") config.mode = "sse";
	else if (declared === "http" || declared === "streamable-http" || declared === "streamablehttp") {
		config.mode = config.mode ?? "streamable";
	}
	if (config.url && !config.mode) config.mode = "auto";

	// Static auth conveniences fold into headers.
	const token = config.bearerToken ?? (typeof anyRaw.apiKey === "string" ? expandEnv(anyRaw.apiKey) : undefined);
	if (token) {
		config.headers = { Authorization: `Bearer ${token}`, ...(config.headers ?? {}) };
	}
	if (config.url && !config.auth) config.auth = "auto";

	if (!config.command && !config.url) {
		return `server "${name}" in ${source} must define "url" (remote) or "command" (local stdio)`;
	}
	if (config.command && config.url) {
		return `server "${name}" in ${source} defines both "url" and "command"; pick one`;
	}
	if (config.url && !/^https?:\/\//i.test(config.url)) {
		return `server "${name}" in ${source} has an invalid url: ${config.url}`;
	}
	return config;
}

export function loadMcpConfig(cwd: string): LoadedConfig {
	const byName = new Map<string, ServerConfig>();
	const files: string[] = [];
	const errors: string[] = [];

	for (const file of candidateFiles(cwd)) {
		if (!existsSync(file)) continue;
		files.push(file);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch (error) {
			errors.push(`${file}: ${(error as Error).message}`);
			continue;
		}

		const servers = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>;
		if (!servers || typeof servers !== "object") {
			errors.push(`${file}: expected an object with "mcpServers"`);
			continue;
		}

		for (const [name, raw] of Object.entries(servers)) {
			if (raw === null || raw === undefined) continue;
			if (typeof raw !== "object" && typeof raw !== "string") continue;
			const result = normalize(name, raw, file);
			if (typeof result === "string") errors.push(result);
			else byName.set(name, result);
		}
	}

	// A subagent sees only the servers its parent scoped it to. Filtered here, at
	// the single point every consumer goes through, rather than at each connect:
	// an out-of-scope server must not merely fail to connect, it must not appear in
	// the status line, in `/mcp enable`, or anywhere else that would let a child
	// talk itself back into it.
	//
	// The scope is an env var the parent set on this process, so two concurrent
	// children with different scopes cannot interfere: there is no shared state to
	// interfere through. See shared/mcp-scope.ts.
	const scope = childMcpScope();
	const servers = scope
		? [...byName.values()].filter((config) => mcpScopeAllows(scope, config.name))
		: [...byName.values()];

	return { servers, files, errors };
}

/**
 * MCP Extension
 *
 * Connects pi to remote Model Context Protocol servers and exposes their tools
 * to the LLM as regular pi tools named `mcp__<server>__<tool>`.
 *
 * Remote servers are the primary target: `url` entries speak Streamable HTTP and
 * transparently fall back to the legacy HTTP+SSE transport, recover expired
 * sessions, and retry connection blips. Local `command` (stdio) servers are also
 * supported for the occasional local tool.
 *
 * Configure servers in any of (later files win):
 *   ~/.pi/agent/mcp.json      global
 *   <cwd>/.mcp.json           project (shared convention)
 *   <cwd>/.pi/mcp.json        project (pi specific)
 *   $PI_MCP_CONFIG            colon-separated extra files
 *
 * {
 *   "mcpServers": {
 *     "linear": { "url": "https://mcp.linear.app/mcp", "bearerToken": "${LINEAR_TOKEN}" },
 *     "docs":   "https://example.com/mcp",
 *     "legacy": { "url": "https://old.example.com/sse", "type": "sse" },
 *     "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
 *   }
 * }
 *
 * Commands:
 *   /mcp                     show server + tool status
 *   /mcp enable <server>     turn a server on (connects, activates its tools)
 *   /mcp disable <server>    turn a server off (disconnects, hides its tools)
 *   /mcp toggle [server]     flip a server, or pick one from a list
 *   /mcp tools [server]      list discovered tools
 *   /mcp resources <server>  list resources exposed by a server
 *   /mcp log <server>        show recent server stderr / transport diagnostics
 *   /mcp reconnect [server]  reconnect one or all servers (re-reads config)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HttpTransport,
	McpClient,
	StdioTransport,
	UnauthorizedError,
	type McpCallToolResult,
	type McpContentBlock,
	type McpToolInfo,
	type Transport,
} from "./client.ts";
import { OAuthProvider } from "./oauth.ts";
import { loadDisabledServers, loadMcpConfig, saveDisabledServers, type ServerConfig } from "./config.ts";
import { formatStatus, statusBadges, type BadgeTone, type StatusBadge, type StatusServer } from "./status.ts";
import { hasRenderer, publish, subscribe } from "../shared/border-badges.ts";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type HttpTransportAuth = (context: { retry: boolean; wwwAuthenticate?: string }) => Promise<string | undefined>;

const DEFAULT_CONNECT_TIMEOUT_MS = Number(process.env.PI_MCP_CONNECT_TIMEOUT_MS || 20_000);
const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.PI_MCP_TIMEOUT_MS || 120_000);
const MAX_TEXT_CHARS = Number(process.env.PI_MCP_MAX_TEXT || 60_000);

interface ServerState {
	config: ServerConfig;
	client?: McpClient;
	status: "connecting" | "ready" | "error" | "disabled" | "needs auth";
	error?: string;
	oauth?: OAuthProvider;
	/** Challenge from the last 401, reused to skip re-discovery during /mcp login. */
	challenge?: string;
	tools: Map<string, McpToolInfo>; // pi tool name -> MCP tool (swapped atomically on refresh)
}

interface McpToolDetails {
	server: string;
	tool: string;
	structuredContent?: unknown;
	isError?: boolean;
}

function sanitize(part: string): string {
	return part.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function piToolName(config: ServerConfig, toolName: string): string {
	const prefix = config.toolPrefix ?? `mcp__${sanitize(config.name)}__`;
	return `${prefix}${sanitize(toolName)}`.slice(0, 128);
}

function isAllowed(config: ServerConfig, toolName: string): boolean {
	if (config.includeTools?.length && !config.includeTools.includes(toolName)) return false;
	if (config.excludeTools?.includes(toolName)) return false;
	return true;
}

/** MCP input schemas are JSON Schema, which is what typebox emits — pass through, but keep it an object schema. */
function toParameterSchema(schema: Record<string, unknown> | undefined): any {
	if (!schema || typeof schema !== "object" || schema.type !== "object") {
		return { type: "object", properties: {}, additionalProperties: true };
	}
	const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
	if (!rest.properties) rest.properties = {};
	return rest;
}

function truncate(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}\n\n…[truncated ${text.length - MAX_TEXT_CHARS} chars]`;
}

/** Convert an MCP tool result into pi tool content blocks. */
function convertContent(result: McpCallToolResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

	for (const block of result.content ?? []) {
		const item = block as McpContentBlock;
		switch (item.type) {
			case "text":
				if (item.text) out.push({ type: "text", text: truncate(item.text) });
				break;
			case "image":
				if (item.data) out.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
				break;
			case "audio":
				out.push({ type: "text", text: `[audio content: ${item.mimeType ?? "unknown"} omitted]` });
				break;
			case "resource_link":
				out.push({ type: "text", text: `[resource link] ${item.uri ?? ""} ${item.description ?? ""}`.trim() });
				break;
			case "resource": {
				const resource = item.resource ?? {};
				if (resource.text) out.push({ type: "text", text: truncate(`[${resource.uri ?? "resource"}]\n${resource.text}`) });
				else if (resource.blob && resource.mimeType?.startsWith("image/"))
					out.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
				else out.push({ type: "text", text: `[binary resource ${resource.uri ?? ""} (${resource.mimeType ?? "unknown"})]` });
				break;
			}
			default:
				out.push({ type: "text", text: truncate(JSON.stringify(item)) });
		}
	}

	if (result.structuredContent !== undefined && out.length === 0) {
		out.push({ type: "text", text: truncate(JSON.stringify(result.structuredContent, null, 2)) });
	}
	if (out.length === 0) out.push({ type: "text", text: "(no content returned)" });
	return out;
}

/**
 * Resolve `bearerTokenCommand` into an Authorization header. Run per connect so
 * rotated / refreshed OAuth tokens are always current.
 */
async function resolveAuthHeaders(config: ServerConfig): Promise<Record<string, string> | undefined> {
	if (!config.bearerTokenCommand) return config.headers;
	const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", config.bearerTokenCommand], {
		cwd: config.source ? dirname(config.source) : process.cwd(),
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
	const token = stdout.trim();
	if (!token) throw new Error(`bearerTokenCommand produced no token${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	return { Authorization: `Bearer ${token}`, ...(config.headers ?? {}) };
}

function createTransport(
	config: ServerConfig,
	headers: Record<string, string> | undefined,
	getAuthorization?: HttpTransportAuth,
): Transport {
	if (config.url) {
		return new HttpTransport({
			url: config.url,
			headers,
			mode: config.mode ?? "auto",
			maxRetries: config.maxRetries,
			getAuthorization,
		});
	}
	return new StdioTransport({
		command: config.command as string,
		args: config.args,
		env: config.env,
		cwd: config.cwd,
	});
}

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
	// separates "broken" from "blocked".
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
 * so switching themes without touching a server leaves the old colours until the
 * next server event repaints. Servers are chatty enough that it corrects itself,
 * and the alternative is polling for a change we cannot be told about.
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

export default function mcpExtension(pi: ExtensionAPI) {
	const servers = new Map<string, ServerState>();
	/** pi tool name -> server name, so reconnects rebind existing registrations. */
	const registeredTools = new Map<string, string>();
	/** Servers switched off with /mcp disable; persisted in ~/.pi/agent/mcp-state.json. */
	const disabledServers = loadDisabledServers();
	let configErrors: string[] = [];
	let configFiles: string[] = [];
	/** Last context seen, so async events (a connect settling, tools/list_changed) can still repaint. */
	let statusContext: ExtensionContext | undefined;
	/**
	 * Whether a border-bar renderer existed last time we looked, and how to stop
	 * watching.
	 *
	 * Extension load order is arbitrary, so this extension routinely writes its
	 * footer entry *before* the extension that owns the editor has mounted one. Two
	 * seconds later a bar appears and the same facts are on screen twice, and they
	 * stay that way until a server happens to change state — which, for a healthy
	 * install, is never. Watching for the transition is what closes that window.
	 */
	let rendererPresent = false;
	let unwatchRenderer: (() => void) | undefined;

	/** A server is off when the config says so, or when it was toggled off. */
	const isOff = (config: ServerConfig): boolean => Boolean(config.disabled) || disabledServers.has(config.name);

	/** Add/remove a server's registered tools from the active set without touching other tools. */
	const setToolsActive = (state: ServerState, active: boolean): void => {
		const names = [...registeredTools.entries()].filter(([, owner]) => owner === state.config.name).map(([name]) => name);
		if (names.length === 0) return;
		const next = new Set(pi.getActiveTools());
		const before = next.size;
		for (const name of names) {
			if (active) next.add(name);
			else next.delete(name);
		}
		if (next.size !== before) pi.setActiveTools([...next]);
	};

	const describe = (state: ServerState): string => {
		const target = state.config.url ?? `${state.config.command} ${(state.config.args ?? []).join(" ")}`.trim();
		const kind = state.config.url ? "remote" : "stdio";
		return `${state.config.name} (${kind}: ${target})`;
	};

	/**
	 * Refresh the badges, wherever they are drawn.
	 *
	 * Called from every place that changes what a server is doing — each connect
	 * as it settles, a tools/list change, enable/disable, logout — so the counts
	 * track reality instead of being a startup snapshot. What to say lives in the
	 * pure `status.ts`, how to paint the footer copy in `renderStatus`; this only
	 * feeds them the live states and guards the UI.
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
	 * one branch and degrades to exactly the old behaviour.
	 *
	 * Nothing in here is allowed to throw. Every one of those callers is in the
	 * middle of something that matters — a connect settling, a disable, the
	 * shutdown that closes an MCP server's child process — and this is only
	 * cosmetics. A theme without a colour token, or a UI torn down a moment
	 * earlier, must not be able to abort a `client.close()` and leave a stray
	 * process behind.
	 */
	const updateStatus = (ctx: ExtensionContext | undefined = statusContext): void => {
		try {
			const states = [...servers.values()].map((s) => ({ status: s.status, tools: s.tools.size }));

			// Published unconditionally, before the UI guard: badges are data, not
			// paint. Whether *this* callback was handed a context it can draw into
			// says nothing about whether the extension owning the editor can draw.
			// `publish` is documented never to throw.
			publish("mcp", statusBadges(states));

			if (!ctx?.hasUI) return; // print/json modes have no status line to write to
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

	const registerToolFor = (state: ServerState, tool: McpToolInfo): void => {
		const name = piToolName(state.config, tool.name);
		if (!state.tools.has(name)) state.tools.set(name, tool);

		if (registeredTools.has(name)) {
			registeredTools.set(name, state.config.name);
			return; // already registered in this process; execute() resolves the live client
		}
		registeredTools.set(name, state.config.name);

		const description = tool.description?.trim() || tool.title || `MCP tool "${tool.name}" on server "${state.config.name}"`;

		pi.registerTool({
			name,
			label: `${state.config.name}: ${tool.title ?? tool.name}`,
			description: `[MCP:${state.config.name}] ${description}`,
			promptSnippet: `${description.split("\n")[0].slice(0, 120)} (MCP server ${state.config.name})`,
			parameters: toParameterSchema(tool.inputSchema),
			async execute(_toolCallId, params, signal, onUpdate) {
				const owner = servers.get(registeredTools.get(name) ?? state.config.name);
				const client = owner?.client;
				if (!client || client.closed) {
					throw new Error(
						`MCP server "${owner?.config.name ?? state.config.name}" is not connected` +
							`${owner?.error ? `: ${owner.error}` : ""}. Try /mcp reconnect.`,
					);
				}
				const mcpTool = owner.tools.get(name);
				if (!mcpTool) throw new Error(`Tool "${name}" is no longer exposed by server "${owner.config.name}".`);

				const result = await client.callTool(mcpTool.name, (params ?? {}) as Record<string, unknown>, {
					signal,
					timeoutMs: owner.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
					onProgress: (progress, total, message) => {
						const pct = total ? ` ${Math.round((progress / total) * 100)}%` : "";
						onUpdate?.({
							content: [{ type: "text", text: `${message ?? "working"}${pct}` }],
							details: { server: owner.config.name, tool: mcpTool.name },
						});
					},
				});

				const content = convertContent(result);
				if (result.isError) {
					const text = content.map((c) => ("text" in c ? c.text : "[image]")).join("\n");
					throw new Error(text || `MCP tool "${mcpTool.name}" reported an error`);
				}

				return {
					content,
					details: {
						server: owner.config.name,
						tool: mcpTool.name,
						structuredContent: result.structuredContent,
					} satisfies McpToolDetails,
				};
			},
		});
	};

	const refreshTools = async (state: ServerState): Promise<void> => {
		if (!state.client) return;
		if (!state.client.supports("tools")) {
			state.tools = new Map();
			return;
		}
		// List into a fresh map and swap, so a refresh never exposes an empty tool set.
		const tools = await state.client.listTools();
		const next = new Map<string, McpToolInfo>();
		for (const tool of tools) {
			if (!isAllowed(state.config, tool.name)) continue;
			next.set(piToolName(state.config, tool.name), tool);
		}
		state.tools = next;
		for (const tool of next.values()) registerToolFor(state, tool);
	};

	const connect = async (config: ServerConfig, ctx: ExtensionContext): Promise<ServerState> => {
		const existing = servers.get(config.name);
		if (existing?.client) await existing.client.close().catch(() => {});

		const state: ServerState = {
			config,
			status: isOff(config) ? "disabled" : "connecting",
			tools: existing?.tools ?? new Map(),
		};
		servers.set(config.name, state);
		if (state.status === "disabled") {
			setToolsActive(state, false);
			return state;
		}

		try {
			const headers = await resolveAuthHeaders(config);
			const staticAuth = Boolean(headers?.Authorization ?? headers?.authorization);

			// OAuth applies to remote servers that are not already using a static token.
			if (config.url && config.auth !== "none" && !staticAuth) {
				state.oauth = new OAuthProvider({
					serverUrl: config.url,
					clientId: config.clientId,
					clientSecret: config.clientSecret,
					scope: config.scope,
					log: (message) => state.client?.log.push(`oauth: ${message}`),
				});
			}

			const getAuthorization: HttpTransportAuth | undefined = state.oauth
				? async ({ retry, wwwAuthenticate }) => {
						if (wwwAuthenticate) state.challenge = wwwAuthenticate;
						if (!state.oauth?.hasCredentials()) return undefined;
						// On a 401 the stored token is stale: force a refresh-token exchange.
						const token = retry ? await state.oauth.refresh() : await state.oauth.getAccessToken();
						return token ? `Bearer ${token}` : undefined;
					}
				: undefined;

			const client = new McpClient(
				config.name,
				createTransport(config, headers, getAuthorization),
				config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
			);
			client.onToolsChanged = () => {
				void refreshTools(state).then(() => updateStatus(ctx)).catch(() => {});
			};
			await client.connect(config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
			state.client = client;
			await refreshTools(state);
			state.status = "ready";
			state.error = undefined;
			setToolsActive(state, true);
		} catch (error) {
			if (error instanceof UnauthorizedError && state.oauth) {
				state.status = "needs auth";
				state.challenge = error.wwwAuthenticate ?? state.challenge;
				state.error = `requires OAuth login — run /mcp login ${config.name}`;
			} else {
				state.status = "error";
				state.error = error instanceof Error ? error.message : String(error);
			}
			await state.client?.close().catch(() => {});
			state.client = undefined;
		}
		return state;
	};

	const connectAll = async (ctx: ExtensionContext, only?: string): Promise<void> => {
		const loaded = loadMcpConfig(ctx.cwd);
		configErrors = loaded.errors;
		configFiles = loaded.files;

		const targets = only ? loaded.servers.filter((s) => s.name === only) : loaded.servers;
		if (only && targets.length === 0) {
			ctx.ui.notify(`No MCP server named "${only}" in config`, "warning");
			return;
		}

		// Paint the "connecting" state before awaiting anything: reaching a remote
		// server takes seconds, and an empty footer for that whole time reads as
		// "no MCP". Each connect then repaints as it settles, so the ratio climbs.
		for (const config of targets) {
			const existing = servers.get(config.name);
			if (!existing) servers.set(config.name, { config, status: isOff(config) ? "disabled" : "connecting", tools: new Map() });
			else if (!isOff(config)) existing.status = "connecting";
		}
		updateStatus(ctx);

		await Promise.all(
			targets.map((config) =>
				connect(config, ctx).then((state) => {
					updateStatus(ctx);
					return state;
				}),
			),
		);

		for (const error of configErrors) ctx.ui.notify(`mcp config: ${error}`, "warning");
		for (const state of targets.map((c) => servers.get(c.name)).filter(Boolean) as ServerState[]) {
			if (state.status === "error") ctx.ui.notify(`mcp: ${describe(state)} failed — ${state.error}`, "error");
			if (state.status === "needs auth") ctx.ui.notify(`mcp: ${state.config.name} needs login — /mcp login ${state.config.name}`, "warning");
		}
		updateStatus(ctx);
	};

	/** Turn a server on or off at runtime; the choice is remembered for future sessions. */
	const setEnabled = async (name: string, enabled: boolean, ctx: ExtensionContext): Promise<void> => {
		const state = servers.get(name);
		if (!state) {
			ctx.ui.notify(`No MCP server named "${name}". Known: ${[...servers.keys()].join(", ") || "none"}`, "warning");
			return;
		}
		if (enabled && state.config.disabled) {
			ctx.ui.notify(`mcp: "${name}" is disabled in ${state.config.source ?? "config"} — remove "disabled": true there first`, "warning");
			return;
		}

		if (enabled) disabledServers.delete(name);
		else disabledServers.add(name);
		saveDisabledServers(disabledServers);

		if (enabled) {
			ctx.ui.notify(`mcp: enabling "${name}"…`, "info");
			await connectAll(ctx, name);
			const updated = servers.get(name);
			ctx.ui.notify(
				`mcp: ${name} is on — ${updated?.status}${updated?.status === "ready" ? ` (${updated.tools.size} tools)` : ` (${updated?.error ?? ""})`}`,
				updated?.status === "ready" ? "info" : "warning",
			);
			return;
		}

		await state.client?.close().catch(() => {});
		state.client = undefined;
		state.status = "disabled";
		state.error = undefined;
		setToolsActive(state, false);
		updateStatus(ctx);
		ctx.ui.notify(`mcp: ${name} is off — ${state.tools.size} tool${state.tools.size === 1 ? "" : "s"} hidden from the model`, "info");
	};

	/**
	 * Subcommands. `takesServer` decides whether a server name can follow; `prefer`
	 * only sorts the most likely servers to the top — every server stays completable,
	 * so `/mcp enable <tab>` still lists something when nothing is currently off.
	 */
	const SUBCOMMANDS: Array<{
		name: string;
		description: string;
		takesServer?: boolean;
		prefer?: (state: ServerState) => boolean;
	}> = [
		{ name: "enable", description: "connect a server and expose its tools", takesServer: true, prefer: (s) => s.status === "disabled" },
		{ name: "disable", description: "disconnect a server and hide its tools", takesServer: true, prefer: (s) => s.status !== "disabled" },
		{ name: "toggle", description: "flip a server on/off (no argument: pick from a list)", takesServer: true },
		{ name: "login", description: "OAuth login, then reconnect", takesServer: true, prefer: (s) => s.status === "needs auth" },
		{ name: "logout", description: "clear stored OAuth credentials", takesServer: true, prefer: (s) => Boolean(s.oauth?.hasCredentials()) },
		{ name: "tools", description: "list registered tools", takesServer: true },
		{ name: "resources", description: "list resources exposed by a server", takesServer: true, prefer: (s) => Boolean(s.client?.supports("resources")) },
		{ name: "log", description: "recent transport diagnostics / stderr", takesServer: true },
		{ name: "reconnect", description: "re-read config and reconnect", takesServer: true },
	];

	const serverHint = (state: ServerState): string => {
		const off = state.status === "disabled" && !state.config.disabled ? "off" : state.status;
		if (state.status === "ready") return `${off} — ${state.tools.size} tool${state.tools.size === 1 ? "" : "s"}`;
		return state.error ? `${off} — ${state.error}` : off;
	};

	/** Text after "/mcp " on this line (also matching "/mcp:2"), or undefined if not an /mcp line. */
	const mcpArguments = (line: string, cursorCol: number): string | undefined => {
		const beforeCursor = line.slice(0, cursorCol);
		return /^\/mcp(?::\d+)? /.test(beforeCursor) ? beforeCursor.slice(beforeCursor.indexOf(" ") + 1) : undefined;
	};

	/** Completions for the argument text of /mcp: subcommand first, then a relevant server name. */
	const completeArguments = (prefix: string): Array<{ value: string; label: string; description?: string }> | null => {
		const spaceIndex = prefix.indexOf(" ");

		// First token: complete the subcommand itself.
		if (spaceIndex === -1) {
			const items = SUBCOMMANDS.filter((sub) => sub.name.startsWith(prefix.toLowerCase())).map((sub) => ({
				value: sub.takesServer ? `${sub.name} ` : sub.name,
				label: sub.name,
				description: sub.description,
			}));
			return items.length > 0 ? items : null;
		}

		// Second token: every server is completable, with the likely ones listed first.
		const subcommand = SUBCOMMANDS.find((sub) => sub.name === prefix.slice(0, spaceIndex).toLowerCase());
		if (!subcommand?.takesServer) return null;
		const partial = prefix.slice(spaceIndex + 1).toLowerCase();
		if (partial.includes(" ")) return null;

		const matching = [...servers.values()].filter((state) => state.config.name.toLowerCase().startsWith(partial));
		const rank = (state: ServerState): number => (subcommand.prefer?.(state) ?? true ? 0 : 1);
		const items = matching
			.sort((a, b) => rank(a) - rank(b) || a.config.name.localeCompare(b.config.name))
			.map((state) => ({
				value: `${subcommand.name} ${state.config.name}`,
				label: state.config.name,
				description: serverHint(state),
			}));
		return items.length > 0 ? items : null;
	};

	pi.on("session_start", async (_event, ctx) => {
		// The built-in provider skips its slash-command branch when completion is forced
		// (an explicit Tab), which would otherwise fall through to file paths for "/mcp …".
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const argumentText = mcpArguments(lines[cursorLine] ?? "", cursorCol);
				if (argumentText === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				const items = completeArguments(argumentText);
				// Stay silent rather than delegating: on a "/mcp …" line, file paths are just noise.
				return items ? { items, prefix: argumentText } : null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				// Must stay true on "/mcp …" lines: Tab aborts the whole request when this is
				// false, and getSuggestions above is what swaps file paths for our own items.
				if (mcpArguments(lines[cursorLine] ?? "", cursorCol) !== undefined) return true;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));

		// Only presence changes matter here. Subscribing to badge changes as well
		// would mean reacting to our own `publish` on every server event — harmless,
		// because an unchanged republish notifies nobody, but a pointless extra repaint
		// each time. Comparing against the last seen value makes the filter explicit.
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

		await connectAll(ctx);
	});

	pi.on("session_shutdown", async () => {
		// Clear the footer first and forget the context: below, a clean shutdown
		// marks every connected server "error", and repainting that would end the
		// session by reporting failures that never happened.
		//
		// Guarded because everything that actually matters happens after it. A UI
		// that has already gone away throwing here would skip the `client.close()`
		// below and orphan every stdio server we started — a leaked process is a
		// steep price for a footer we were erasing anyway.
		try {
			if (statusContext?.hasUI) statusContext.ui.setStatus("mcp", undefined);
		} catch {
			// Nothing to do about it, and nowhere left to say so.
		}
		// Before the teardown below starts marking servers "error": a listener still
		// attached would repaint the footer with failures that never happened, which
		// is the same reason the entry is cleared above.
		try {
			unwatchRenderer?.();
		} catch {
			/* the store has already forgotten us */
		}
		unwatchRenderer = undefined;
		// Withdraw from the border bar for the same reason the footer entry is
		// cleared: a moment from now every connected server is marked "error" to
		// tear it down, and a bar left holding the last snapshot would spend the end
		// of the session reporting failures that never happened.
		publish("mcp", undefined);
		statusContext = undefined;
		await Promise.all([...servers.values()].map((state) => state.client?.close().catch(() => {})));
		for (const state of servers.values()) {
			state.client = undefined;
			if (state.status === "ready") state.status = "error";
		}
	});

	pi.registerCommand("mcp", {
		description: "MCP servers: /mcp [enable|disable|toggle|login|logout|tools|resources|log|reconnect] [server]",
		getArgumentCompletions: (prefix: string) => completeArguments(prefix),
		handler: async (args, ctx) => {
			const [subcommand = "", target = ""] = args.trim().split(/\s+/);

			if (subcommand === "enable" || subcommand === "disable" || subcommand === "on" || subcommand === "off") {
				const enabled = subcommand === "enable" || subcommand === "on";
				if (!target) {
					ctx.ui.notify(`Usage: /mcp ${subcommand} <server>. Known: ${[...servers.keys()].join(", ") || "none"}`, "warning");
					return;
				}
				await setEnabled(target, enabled, ctx);
				return;
			}

			if (subcommand === "toggle") {
				let name = target;
				if (!name) {
					if (servers.size === 0) {
						ctx.ui.notify("no servers configured", "warning");
						return;
					}
					// Label each option with its current state so the picker doubles as an overview.
					const labels = new Map<string, string>();
					for (const state of servers.values()) {
						const on = state.status !== "disabled";
						labels.set(`[${on ? "on " : "off"}] ${state.config.name}${on ? ` — ${state.tools.size} tools` : ""}`, state.config.name);
					}
					const picked = await ctx.ui.select("Toggle MCP server", [...labels.keys()]);
					if (!picked) return;
					name = labels.get(picked) ?? "";
				}
				const state = servers.get(name);
				if (!state) {
					ctx.ui.notify(`No MCP server named "${name}". Known: ${[...servers.keys()].join(", ") || "none"}`, "warning");
					return;
				}
				await setEnabled(name, state.status === "disabled", ctx);
				return;
			}

			if (subcommand === "login") {
				const state = servers.get(target);
				if (!state || !state.config.url) {
					const remote = [...servers.values()].filter((s) => s.config.url).map((s) => s.config.name);
					ctx.ui.notify(`Usage: /mcp login <remote server>. Known: ${remote.join(", ") || "none"}`, "warning");
					return;
				}
				const provider =
					state.oauth ??
					new OAuthProvider({
						serverUrl: state.config.url,
						clientId: state.config.clientId,
						clientSecret: state.config.clientSecret,
						scope: state.config.scope,
					});
				state.oauth = provider;
				try {
					ctx.ui.notify(`mcp: opening browser to authorize "${target}"…`, "info");
					await provider.login({
						wwwAuthenticate: state.challenge,
						timeoutMs: 300_000,
					});
					ctx.ui.notify(`mcp: authorized "${target}", reconnecting…`, "info");
					await connectAll(ctx, target);
					const updated = servers.get(target);
					ctx.ui.notify(
						`${target}: ${updated?.status}${updated?.status === "ready" ? ` (${updated.tools.size} tools)` : ` (${updated?.error ?? ""})`}`,
						updated?.status === "ready" ? "info" : "warning",
					);
				} catch (error) {
					ctx.ui.notify(`mcp login failed: ${(error as Error).message}`, "error");
				}
				return;
			}

			if (subcommand === "logout") {
				const state = servers.get(target);
				if (!state?.config.url) {
					ctx.ui.notify("Usage: /mcp logout <remote server>", "warning");
					return;
				}
				const provider = state.oauth ?? new OAuthProvider({ serverUrl: state.config.url });
				provider.logout();
				await state.client?.close().catch(() => {});
				state.client = undefined;
				state.status = "needs auth";
				state.error = `logged out — run /mcp login ${target}`;
				updateStatus(ctx);
				ctx.ui.notify(`mcp: cleared stored credentials for "${target}"`, "info");
				return;
			}

			if (subcommand === "reconnect") {
				ctx.ui.notify(`mcp: reconnecting${target ? ` ${target}` : " all servers"}…`, "info");
				await connectAll(ctx, target || undefined);
				const list = [...servers.values()].filter((s) => !target || s.config.name === target);
				ctx.ui.notify(
					list.map((s) => `${s.config.name}: ${s.status}${s.error ? ` (${s.error})` : ` (${s.tools.size} tools)`}`).join("\n") ||
						"no servers configured",
					"info",
				);
				return;
			}

			if (subcommand === "log") {
				const state = servers.get(target);
				if (!state) {
					ctx.ui.notify(`Usage: /mcp log <server>. Known: ${[...servers.keys()].join(", ") || "none"}`, "warning");
					return;
				}
				const log = state.client?.log ?? [];
				ctx.ui.notify(log.length ? log.slice(-40).join("\n") : "(no diagnostics)", "info");
				return;
			}

			if (subcommand === "resources") {
				const state = servers.get(target);
				if (!state?.client) {
					ctx.ui.notify(`Usage: /mcp resources <connected server>. Known: ${[...servers.keys()].join(", ") || "none"}`, "warning");
					return;
				}
				if (!state.client.supports("resources")) {
					ctx.ui.notify(`Server "${target}" does not expose resources`, "warning");
					return;
				}
				const resources = await state.client.listResources(ctx.signal);
				ctx.ui.notify(
					resources.length
						? resources.map((r) => `${r.uri}${r.name ? ` — ${r.name}` : ""}`).join("\n")
						: "(no resources)",
					"info",
				);
				return;
			}

			if (subcommand === "tools") {
				const lines: string[] = [];
				for (const state of servers.values()) {
					if (target && state.config.name !== target) continue;
					lines.push(`${state.config.name} [${state.status}]`);
					for (const [name, tool] of state.tools) {
						const summary = (tool.description ?? tool.title ?? tool.name).split("\n")[0].slice(0, 100);
						lines.push(`  ${name} — ${summary}`);
					}
				}
				ctx.ui.notify(lines.join("\n") || "No MCP tools registered", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(configFiles.length ? `config: ${configFiles.join(", ")}` : "config: none found (see /mcp help in extension header)");
			for (const error of configErrors) lines.push(`  ! ${error}`);
			if (servers.size === 0) {
				lines.push("no servers configured");
			}
			for (const state of servers.values()) {
				const icon =
					state.status === "ready" ? "●" : state.status === "error" ? "✗" : state.status === "needs auth" ? "⚿" : "○";
				const off =
					state.status === "disabled"
						? state.config.disabled
							? " (disabled in config)"
							: ` (off — /mcp enable ${state.config.name})`
						: "";
				const suffix =
					state.status === "ready"
						? ` — ${state.tools.size} tool${state.tools.size === 1 ? "" : "s"}`
						: state.error
							? ` — ${state.error}`
							: "";
				// Only mention auth when it is actually in play (logged in, or login needed).
				const auth =
					state.oauth && (state.oauth.hasCredentials() || state.status === "needs auth")
						? ` [auth: ${state.oauth.describe()}]`
						: "";
				lines.push(`${icon} ${describe(state)} [${state.status}]${off}${suffix}${auth}`);
			}
			lines.push("");
			lines.push(
				"subcommands: enable <server> · disable <server> · toggle [server] · login <server> · logout <server> · tools [server] · resources <server> · log <server> · reconnect [server]",
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

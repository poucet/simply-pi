/**
 * Minimal, dependency-free MCP (Model Context Protocol) client.
 *
 * Supports two transports:
 *   - "stdio": spawns a local server process, newline-delimited JSON-RPC.
 *   - "http":  Streamable HTTP (POST JSON-RPC, JSON or SSE responses).
 *
 * Only the subset of MCP that pi needs is implemented: initialize, tools/list,
 * tools/call, resources/list, resources/read, prompts/list, plus progress and
 * list_changed notifications.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface Transport {
	start(): Promise<void>;
	send(message: JsonRpcMessage): Promise<void>;
	close(): Promise<void>;
	onMessage?: (message: JsonRpcMessage) => void;
	onClose?: (reason: string) => void;
	/** Human readable diagnostics (stderr for stdio, status text for http). */
	log: string[];
}

function pushLog(log: string[], line: string): void {
	log.push(line);
	if (log.length > 200) log.splice(0, log.length - 200);
}

/* ------------------------------------------------------------------ stdio */

export interface StdioOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export class StdioTransport implements Transport {
	onMessage?: (message: JsonRpcMessage) => void;
	onClose?: (reason: string) => void;
	readonly log: string[] = [];

	private child?: ChildProcessWithoutNullStreams;
	private buffer = "";
	private closed = false;
	private readonly options: StdioOptions;

	constructor(options: StdioOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		const child = spawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env: { ...process.env, ...(this.options.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.child = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (line.trim()) pushLog(this.log, line.trimEnd());
			}
		});
		child.on("error", (err) => {
			pushLog(this.log, `process error: ${err.message}`);
			this.finish(`process error: ${err.message}`);
		});
		child.on("exit", (code, signal) => {
			this.finish(`process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
		});

		// Fail fast if the command could not be spawned at all.
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(new Error(`failed to spawn ${this.options.command}: ${err.message}`));
			child.once("error", onError);
			setTimeout(() => {
				child.off("error", onError);
				resolve();
			}, 50);
		});
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			try {
				this.onMessage?.(JSON.parse(line) as JsonRpcMessage);
			} catch {
				pushLog(this.log, `non-JSON stdout: ${line.slice(0, 200)}`);
			}
		}
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.child || this.child.killed) throw new Error("transport is closed");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	async close(): Promise<void> {
		this.finish("closed by client");
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		try {
			child.stdin.end();
		} catch {
			// ignore
		}
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 2000).unref?.();
	}

	private finish(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose?.(reason);
	}
}

/* ------------------------------------------------------------------- http */

export interface HttpOptions {
	url: string;
	headers?: Record<string, string>;
	/** "auto" tries Streamable HTTP first, then falls back to the legacy HTTP+SSE transport. */
	mode?: "auto" | "streamable" | "sse";
	/** Retries for connection-level failures (not for server error responses). */
	maxRetries?: number;
	/** Called when the server drops our session; the client re-initializes. */
	onSessionExpired?: () => void;
	/**
	 * Supplies the `Authorization` header value (e.g. "Bearer …").
	 * Called before each request and again — with the challenge — after a 401,
	 * so OAuth tokens can be refreshed transparently.
	 */
	getAuthorization?: (context: { retry: boolean; wwwAuthenticate?: string }) => Promise<string | undefined>;
}

/** Thrown when the server requires OAuth and no usable token is available. */
export class UnauthorizedError extends Error {
	readonly wwwAuthenticate?: string;
	constructor(message: string, wwwAuthenticate?: string) {
		super(message);
		this.name = "UnauthorizedError";
		this.wwwAuthenticate = wwwAuthenticate;
	}
}

/** Thrown when the server reports an unknown/expired MCP session (HTTP 404 with a session id). */
export class SessionExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionExpiredError";
	}
}

/** Parse an SSE byte stream, invoking `onEvent(eventName, data)` per event. */
async function parseSseStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (eventName: string, data: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			if (signal?.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
				const rawEvent = buffer.slice(0, sep);
				const match = /\r?\n\r?\n/.exec(buffer.slice(sep));
				buffer = buffer.slice(sep + (match?.[0].length ?? 2));

				let eventName = "message";
				const dataLines: string[] = [];
				for (const line of rawEvent.split(/\r?\n/)) {
					if (line.startsWith("event:")) eventName = line.slice(6).trim();
					else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
				}
				if (dataLines.length) onEvent(eventName, dataLines.join("\n"));
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Remote transport for MCP servers over HTTP.
 *
 * Speaks the current Streamable HTTP transport, and transparently falls back to
 * the legacy HTTP+SSE transport (GET /sse -> `endpoint` event -> POST messages)
 * used by many deployed remote servers.
 */
export class HttpTransport implements Transport {
	onMessage?: (message: JsonRpcMessage) => void;
	onClose?: (reason: string) => void;
	readonly log: string[] = [];

	private readonly options: HttpOptions;
	private readonly abort = new AbortController();
	private mode: "streamable" | "sse";
	private sessionId?: string;
	/** POST target: the base url for streamable, or the endpoint advertised by legacy SSE. */
	private postUrl: string;
	private closed = false;
	private notificationStream?: Promise<void>;

	constructor(options: HttpOptions) {
		this.options = options;
		this.mode = options.mode === "sse" ? "sse" : "streamable";
		this.postUrl = options.url;
	}

	private baseHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"mcp-protocol-version": PROTOCOL_VERSION,
			...(this.options.headers ?? {}),
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		return headers;
	}

	async start(): Promise<void> {
		if (this.mode === "sse") await this.openLegacySse();
	}

	/* -------------------------------------------------- legacy HTTP+SSE mode */

	/** Open the GET event stream and wait for the `endpoint` event that names the POST url. */
	private async openLegacySse(): Promise<void> {
		const authorization = await this.options.getAuthorization?.({ retry: false });
		const response = await fetch(this.options.url, {
			method: "GET",
			headers: {
				...this.baseHeaders(),
				...(authorization ? { authorization } : {}),
				accept: "text/event-stream",
			},
			signal: this.abort.signal,
		});
		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			throw new Error(`SSE connect failed: HTTP ${response.status} ${response.statusText} ${text.slice(0, 200)}`);
		}

		let resolveEndpoint: (() => void) | undefined;
		let rejectEndpoint: ((error: Error) => void) | undefined;
		const endpointReady = new Promise<void>((resolve, reject) => {
			resolveEndpoint = resolve;
			rejectEndpoint = reject;
		});

		this.notificationStream = parseSseStream(
			response.body,
			(eventName, data) => {
				if (eventName === "endpoint") {
					this.postUrl = new URL(data.trim(), this.options.url).toString();
					pushLog(this.log, `sse endpoint: ${this.postUrl}`);
					resolveEndpoint?.();
					return;
				}
				this.dispatchPayload(data);
			},
			this.abort.signal,
		)
			.catch((error: Error) => {
				if (!this.closed) pushLog(this.log, `sse stream error: ${error.message}`);
			})
			.finally(() => {
				rejectEndpoint?.(new Error("SSE stream ended before an endpoint event was received"));
				if (!this.closed) this.finish("sse stream closed by server");
			});

		const timer = setTimeout(() => rejectEndpoint?.(new Error("timed out waiting for SSE endpoint event")), 15_000);
		timer.unref?.();
		try {
			await endpointReady;
		} finally {
			clearTimeout(timer);
		}
	}

	/* ------------------------------------------------------ streamable mode */

	/** Optional GET stream so servers can push notifications outside of request/response. */
	private openNotificationStream(): void {
		if (this.mode !== "streamable" || this.notificationStream || this.closed) return;
		this.notificationStream = (async () => {
			try {
				const authorization = await this.options.getAuthorization?.({ retry: false });
				const response = await fetch(this.options.url, {
					method: "GET",
					headers: {
						...this.baseHeaders(),
						...(authorization ? { authorization } : {}),
						accept: "text/event-stream",
					},
					signal: this.abort.signal,
				});
				// 405/404 simply means the server does not offer a standalone stream.
				if (!response.ok || !response.body) return;
				await parseSseStream(response.body, (_event, data) => this.dispatchPayload(data), this.abort.signal);
			} catch (error) {
				if (!this.closed) pushLog(this.log, `notification stream ended: ${(error as Error).message}`);
			}
		})();
	}

	/* ------------------------------------------------------------- send/recv */

	async send(message: JsonRpcMessage): Promise<void> {
		if (this.closed) throw new Error("transport is closed");

		const maxRetries = this.options.maxRetries ?? 2;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				await this.post(message);
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				// Only connection-level failures are safe-ish to retry; protocol errors are not.
				const retriable = lastError.name === "TypeError" || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(lastError.message);
				if (!retriable || attempt === maxRetries || this.closed) throw lastError;
				const delay = 250 * 2 ** attempt;
				pushLog(this.log, `retry ${attempt + 1}/${maxRetries} after ${lastError.message} (waiting ${delay}ms)`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		throw lastError ?? new Error("send failed");
	}

	/** @param authOverride credentials obtained while handling a 401; also marks this as the retry attempt. */
	private async post(message: JsonRpcMessage, authOverride?: string): Promise<void> {
		const authorization = authOverride ?? (await this.options.getAuthorization?.({ retry: false }));
		const response = await fetch(this.postUrl, {
			method: "POST",
			headers: {
				...this.baseHeaders(),
				...(authorization ? { authorization } : {}),
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(message),
			signal: this.abort.signal,
		});

		const newSession = response.headers.get("mcp-session-id");
		if (newSession && newSession !== this.sessionId) this.sessionId = newSession;

		if (!response.ok) {
			const text = await response.text().catch(() => "");

			// OAuth: refresh/obtain a token from the challenge and replay the request once.
			if (response.status === 401) {
				const challenge = response.headers.get("www-authenticate") ?? undefined;
				if (!authOverride && this.options.getAuthorization) {
					const refreshed = await this.options.getAuthorization({ retry: true, wwwAuthenticate: challenge });
					if (refreshed && refreshed !== authorization) {
						pushLog(this.log, "401 received; retrying with refreshed credentials");
						await this.post(message, refreshed);
						return;
					}
				}
				pushLog(this.log, `unauthorized: ${challenge ?? text.slice(0, 200)}`);
				throw new UnauthorizedError(
					`Unauthorized (HTTP 401)${text ? `: ${text.slice(0, 200)}` : ""}`,
					challenge,
				);
			}

			// Server forgot our session: surface a typed error so the client can re-initialize.
			if (response.status === 404 && this.sessionId) {
				pushLog(this.log, "session expired (HTTP 404)");
				this.sessionId = undefined;
				this.options.onSessionExpired?.();
				throw new SessionExpiredError("MCP session expired");
			}

			// Some remote servers only implement the legacy SSE transport.
			if (
				this.mode === "streamable" &&
				this.options.mode !== "streamable" &&
				(response.status === 404 || response.status === 405 || response.status === 400)
			) {
				pushLog(this.log, `streamable HTTP rejected (${response.status}); falling back to legacy SSE transport`);
				this.mode = "sse";
				await this.openLegacySse();
				await this.post(message, authOverride);
				return;
			}

			pushLog(this.log, `HTTP ${response.status}: ${text.slice(0, 300)}`);
			const hint = response.status === 403 ? " — token lacks the required scope" : "";
			throw new Error(`HTTP ${response.status} ${response.statusText}${hint}: ${text.slice(0, 300)}`);
		}

		if (this.mode === "streamable") this.openNotificationStream();

		// Notifications and legacy-SSE posts get 202 Accepted with no body.
		if (response.status === 202 || !response.body) return;

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			await parseSseStream(response.body, (_event, data) => this.dispatchPayload(data), this.abort.signal);
			return;
		}

		const text = await response.text();
		if (text.trim()) this.dispatchPayload(text);
	}

	private dispatchPayload(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || trimmed === "[DONE]") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			pushLog(this.log, `non-JSON payload: ${trimmed.slice(0, 200)}`);
			return;
		}
		const messages = Array.isArray(parsed) ? parsed : [parsed];
		for (const message of messages) this.onMessage?.(message as JsonRpcMessage);
	}

	/** Drop session state so the next request re-initializes from scratch. */
	resetSession(): void {
		this.sessionId = undefined;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const sessionId = this.sessionId;
		this.abort.abort();
		if (sessionId && this.mode === "streamable") {
			try {
				await fetch(this.options.url, {
					method: "DELETE",
					headers: { ...(this.options.headers ?? {}), "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
				});
			} catch {
				// best effort
			}
		}
		this.finish("closed by client");
	}

	private finish(reason: string): void {
		this.onClose?.(reason);
	}
}

/* ----------------------------------------------------------------- client */

export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export interface McpResourceInfo {
	uri: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content?: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

export interface McpServerInfo {
	name?: string;
	version?: string;
	title?: string;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (progress: number, total?: number, message?: string) => void;
	/** Internal: prevents recursive re-initialization while recovering a session. */
	noSessionRecovery?: boolean;
}

export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly progressHandlers = new Map<number, NonNullable<RequestOptions["onProgress"]>>();
	private closedReason?: string;
	private reinitializing?: Promise<void>;

	serverInfo?: McpServerInfo;
	capabilities: Record<string, unknown> = {};
	onToolsChanged?: () => void;

	readonly serverName: string;
	private readonly transport: Transport;
	private readonly defaultTimeoutMs: number;

	constructor(serverName: string, transport: Transport, defaultTimeoutMs = 60_000) {
		this.serverName = serverName;
		this.transport = transport;
		this.defaultTimeoutMs = defaultTimeoutMs;
		transport.onMessage = (message) => this.handleMessage(message);
		transport.onClose = (reason) => this.handleClose(reason);
	}

	get log(): string[] {
		return this.transport.log;
	}

	get closed(): boolean {
		return this.closedReason !== undefined;
	}

	async connect(timeoutMs: number): Promise<void> {
		await this.transport.start();
		await this.handshake(timeoutMs);
	}

	private async handshake(timeoutMs: number): Promise<void> {
		const result = (await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { roots: { listChanged: false } },
				clientInfo: { name: "pi", version: "1.0.0" },
			},
			{ timeoutMs, noSessionRecovery: true },
		)) as { serverInfo?: McpServerInfo; capabilities?: Record<string, unknown> };

		this.serverInfo = result?.serverInfo;
		this.capabilities = result?.capabilities ?? {};
		await this.notify("notifications/initialized");
	}

	/**
	 * Remote servers expire sessions (idle timeouts, redeploys). Re-run the
	 * handshake once so in-flight tool calls survive a recycled session.
	 */
	private async recoverSession(timeoutMs: number): Promise<void> {
		if (!this.reinitializing) {
			this.reinitializing = this.handshake(timeoutMs).finally(() => {
				this.reinitializing = undefined;
			});
		}
		await this.reinitializing;
	}

	supports(capability: "tools" | "resources" | "prompts"): boolean {
		return Boolean(this.capabilities[capability]);
	}

	async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = (await this.request("tools/list", cursor ? { cursor } : {}, { signal })) as {
				tools?: McpToolInfo[];
				nextCursor?: string;
			};
			tools.push(...(page?.tools ?? []));
			cursor = page?.nextCursor;
		} while (cursor);
		return tools;
	}

	async listResources(signal?: AbortSignal): Promise<McpResourceInfo[]> {
		const resources: McpResourceInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = (await this.request("resources/list", cursor ? { cursor } : {}, { signal })) as {
				resources?: McpResourceInfo[];
				nextCursor?: string;
			};
			resources.push(...(page?.resources ?? []));
			cursor = page?.nextCursor;
		} while (cursor);
		return resources;
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<{ contents?: McpContentBlock[] }> {
		return (await this.request("resources/read", { uri }, { signal })) as { contents?: McpContentBlock[] };
	}

	async callTool(name: string, args: Record<string, unknown>, options: RequestOptions = {}): Promise<McpCallToolResult> {
		return (await this.request("tools/call", { name, arguments: args ?? {} }, options)) as McpCallToolResult;
	}

	async request(method: string, params: unknown = {}, options: RequestOptions = {}): Promise<unknown> {
		if (this.closedReason) throw new Error(`MCP server "${this.serverName}" is disconnected: ${this.closedReason}`);

		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

		const payload: Record<string, unknown> = { ...(params as Record<string, unknown>) };
		if (options.onProgress) {
			payload._meta = { ...(payload._meta as object | undefined), progressToken: id };
			this.progressHandlers.set(id, options.onProgress);
		}

		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.settle(id, undefined, new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
				void this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
		});

		const onAbort = () => {
			this.settle(id, undefined, new Error(`MCP request "${method}" aborted`));
			void this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await this.transport.send({ jsonrpc: "2.0", id, method, params: payload });
		} catch (error) {
			const expired = error instanceof SessionExpiredError;
			if (expired && !options.noSessionRecovery) {
				try {
					// Re-handshake with the remote server, then replay this request once.
					await this.recoverSession(timeoutMs);
					await this.transport.send({ jsonrpc: "2.0", id, method, params: payload });
				} catch (retryError) {
					this.settle(id, undefined, retryError instanceof Error ? retryError : new Error(String(retryError)));
				}
			} else {
				this.settle(id, undefined, error instanceof Error ? error : new Error(String(error)));
			}
		}

		try {
			return await promise;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			this.progressHandlers.delete(id);
		}
	}

	async notify(method: string, params: unknown = {}): Promise<void> {
		try {
			await this.transport.send({ jsonrpc: "2.0", method, params });
		} catch {
			// notifications are best-effort
		}
	}

	async close(): Promise<void> {
		await this.transport.close().catch(() => {});
		this.handleClose("closed by client");
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
			if (message.error) {
				this.settle(message.id, undefined, new Error(`${message.error.message} (code ${message.error.code})`));
			} else {
				this.settle(message.id, message.result, undefined);
			}
			return;
		}

		if (message.method === "notifications/progress") {
			const params = (message.params ?? {}) as {
				progressToken?: number | string;
				progress?: number;
				total?: number;
				message?: string;
			};
			const handler = this.progressHandlers.get(Number(params.progressToken));
			handler?.(params.progress ?? 0, params.total, params.message);
			return;
		}

		if (message.method === "notifications/tools/list_changed") {
			this.onToolsChanged?.();
			return;
		}

		// Server-initiated requests we do not implement (sampling, roots, elicitation).
		if (message.id !== undefined && message.method) {
			void this.transport.send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: `Method not supported by pi mcp client: ${message.method}` },
			});
		}
	}

	private settle(id: number, result: unknown, error: Error | undefined): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (error) pending.reject(error);
		else pending.resolve(result);
	}

	private handleClose(reason: string): void {
		if (this.closedReason) return;
		this.closedReason = reason;
		for (const id of [...this.pending.keys()]) {
			this.settle(id, undefined, new Error(`MCP server "${this.serverName}" disconnected: ${reason}`));
		}
	}
}

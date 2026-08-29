/**
 * OAuth 2.1 support for remote MCP servers.
 *
 * Implements what the MCP authorization spec requires, with no dependencies:
 *   - RFC 9728 protected-resource metadata discovery (from the `WWW-Authenticate`
 *     challenge, with well-known fallbacks)
 *   - RFC 8414 / OIDC authorization-server metadata discovery
 *   - RFC 7591 dynamic client registration (when the server supports it)
 *   - Authorization code flow with PKCE (S256) via a loopback redirect
 *   - RFC 8707 `resource` binding, refresh-token rotation, token persistence
 *
 * Tokens live in ~/.pi/agent/mcp-auth.json (chmod 600).
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

export const DEFAULT_STORE_PATH = join(homedir(), ".pi", "agent", "mcp-auth.json");

export interface AuthServerMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	code_challenge_methods_supported?: string[];
	grant_types_supported?: string[];
}

export interface StoredAuth {
	resource: string;
	accessToken?: string;
	refreshToken?: string;
	/** Epoch ms. */
	expiresAt?: number;
	scope?: string;
	clientId?: string;
	clientSecret?: string;
	redirectUri?: string;
	metadata?: AuthServerMetadata;
}

type Store = Record<string, StoredAuth>;

function readStore(path: string): Store {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Store;
	} catch {
		return {};
	}
}

function writeStore(path: string, store: Store): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best effort on platforms without POSIX modes
	}
}

/** Canonical resource identifier for RFC 8707 (origin + path, no query/fragment). */
export function canonicalResource(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	parsed.search = "";
	if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") parsed.pathname = parsed.pathname.slice(0, -1);
	return parsed.toString();
}

/** Pull `resource_metadata="..."` out of a WWW-Authenticate challenge. */
export function parseResourceMetadataUrl(header: string | null | undefined): string | undefined {
	if (!header) return undefined;
	const match = /resource_metadata="([^"]+)"/i.exec(header) ?? /resource_metadata=([^,\s]+)/i.exec(header);
	return match?.[1];
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | undefined> {
	try {
		const response = await fetch(url, init);
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}

function base64url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url: string): void {
	// Headless / remote sessions: print-only, the caller shows the URL.
	if (process.env.PI_MCP_NO_BROWSER === "1") return;
	const command =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(command, args, { stdio: "ignore", detached: true }).unref();
	} catch {
		// caller prints the URL as a fallback
	}
}

export interface OAuthOptions {
	/** MCP endpoint url. */
	serverUrl: string;
	storePath?: string;
	/** Pre-registered client credentials, if the server does not support DCR. */
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	log?: (message: string) => void;
	/** Called with the authorization URL so the UI can show/open it. */
	onAuthorizationUrl?: (url: string) => void;
}

export class OAuthProvider {
	private readonly serverUrl: string;
	private readonly storePath: string;
	private readonly options: OAuthOptions;
	private readonly resource: string;
	private refreshing?: Promise<string | undefined>;

	constructor(options: OAuthOptions) {
		this.options = options;
		this.serverUrl = options.serverUrl;
		this.storePath = options.storePath ?? DEFAULT_STORE_PATH;
		this.resource = canonicalResource(options.serverUrl);
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private load(): StoredAuth {
		return readStore(this.storePath)[this.resource] ?? { resource: this.resource };
	}

	private save(entry: StoredAuth): void {
		const store = readStore(this.storePath);
		store[this.resource] = { ...store[this.resource], ...entry, resource: this.resource };
		writeStore(this.storePath, store);
	}

	hasCredentials(): boolean {
		return Boolean(this.load().accessToken);
	}

	/** Access token for a request, refreshing when expired. Never prompts. */
	async getAccessToken(): Promise<string | undefined> {
		const entry = this.load();
		if (!entry.accessToken) return undefined;
		const expiresSoon = entry.expiresAt !== undefined && entry.expiresAt - Date.now() < 30_000;
		if (!expiresSoon) return entry.accessToken;
		if (!entry.refreshToken) return entry.accessToken; // let the 401 path handle it
		return (await this.refresh()) ?? entry.accessToken;
	}

	/** Force a refresh-token exchange. Returns undefined if refresh is impossible. */
	async refresh(): Promise<string | undefined> {
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			const entry = this.load();
			if (!entry.refreshToken || !entry.metadata?.token_endpoint) return undefined;

			const body = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: entry.refreshToken,
				resource: this.resource,
			});
			if (entry.clientId) body.set("client_id", entry.clientId);
			if (entry.clientSecret) body.set("client_secret", entry.clientSecret);
			if (entry.scope) body.set("scope", entry.scope);

			const response = await fetch(entry.metadata.token_endpoint, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body,
			});
			if (!response.ok) {
				this.log(`token refresh failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
				// Refresh token is dead; drop it so we fall back to a fresh login.
				this.save({ ...entry, refreshToken: undefined, accessToken: undefined, expiresAt: undefined });
				return undefined;
			}
			const token = (await response.json()) as {
				access_token: string;
				refresh_token?: string;
				expires_in?: number;
				scope?: string;
			};
			this.save({
				...entry,
				accessToken: token.access_token,
				refreshToken: token.refresh_token ?? entry.refreshToken,
				expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
				scope: token.scope ?? entry.scope,
			});
			this.log("access token refreshed");
			return token.access_token;
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	/* ------------------------------------------------------------ discovery */

	async discover(wwwAuthenticate?: string): Promise<AuthServerMetadata> {
		const serverOrigin = new URL(this.serverUrl).origin;
		const serverPath = new URL(this.serverUrl).pathname.replace(/\/$/, "");

		// 1. Protected resource metadata (RFC 9728).
		const candidates = [
			parseResourceMetadataUrl(wwwAuthenticate),
			serverPath ? `${serverOrigin}/.well-known/oauth-protected-resource${serverPath}` : undefined,
			`${serverOrigin}/.well-known/oauth-protected-resource`,
		].filter(Boolean) as string[];

		let issuer: string | undefined;
		let scope: string | undefined;
		for (const candidate of candidates) {
			const prm = await fetchJson<{ authorization_servers?: string[]; scopes_supported?: string[] }>(candidate);
			if (prm?.authorization_servers?.length) {
				issuer = prm.authorization_servers[0];
				scope = prm.scopes_supported?.join(" ");
				this.log(`protected resource metadata: ${candidate} -> ${issuer}`);
				break;
			}
		}
		issuer ??= serverOrigin;

		// 2. Authorization server metadata (RFC 8414, with OIDC fallback).
		const issuerUrl = new URL(issuer);
		const issuerPath = issuerUrl.pathname.replace(/\/$/, "");
		const metadataUrls = [
			issuerPath ? `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}` : undefined,
			`${issuerUrl.origin}/.well-known/oauth-authorization-server`,
			issuerPath ? `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration` : undefined,
			`${issuerUrl.origin}/.well-known/openid-configuration`,
		].filter(Boolean) as string[];

		for (const url of metadataUrls) {
			const metadata = await fetchJson<AuthServerMetadata>(url);
			if (metadata?.authorization_endpoint && metadata.token_endpoint) {
				this.log(`authorization server metadata: ${url}`);
				return { ...metadata, scopes_supported: metadata.scopes_supported ?? (scope ? scope.split(" ") : undefined) };
			}
		}

		// 3. Spec-default endpoints.
		this.log(`no AS metadata found; assuming default endpoints on ${issuer}`);
		return {
			issuer,
			authorization_endpoint: `${issuer.replace(/\/$/, "")}/authorize`,
			token_endpoint: `${issuer.replace(/\/$/, "")}/token`,
			registration_endpoint: `${issuer.replace(/\/$/, "")}/register`,
			scopes_supported: scope ? scope.split(" ") : undefined,
		};
	}

	private async register(metadata: AuthServerMetadata, redirectUri: string, scope?: string): Promise<{ clientId: string; clientSecret?: string }> {
		if (this.options.clientId) return { clientId: this.options.clientId, clientSecret: this.options.clientSecret };
		if (!metadata.registration_endpoint) {
			throw new Error(
				`Server ${this.resource} does not support dynamic client registration; set "clientId" (and "clientSecret") for this server in mcp.json`,
			);
		}

		const response = await fetch(metadata.registration_endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				client_name: "pi coding agent",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				...(scope ? { scope } : {}),
			}),
		});
		if (!response.ok) {
			throw new Error(`Dynamic client registration failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
		}
		const registered = (await response.json()) as { client_id: string; client_secret?: string };
		this.log(`registered oauth client ${registered.client_id}`);
		return { clientId: registered.client_id, clientSecret: registered.client_secret };
	}

	/* ------------------------------------------------------- interactive login */

	/** Full authorization-code + PKCE login. Opens a browser and waits for the redirect. */
	async login(options: { wwwAuthenticate?: string; timeoutMs?: number } = {}): Promise<string> {
		const metadata = await this.discover(options.wwwAuthenticate);
		const scope = this.options.scope ?? metadata.scopes_supported?.join(" ");

		const { server, port } = await startLoopbackServer();
		const redirectUri = `http://127.0.0.1:${port}/callback`;

		try {
			const existing = this.load();
			// Reuse a registered client only when the redirect matches what it was registered with.
			const client =
				existing.clientId && existing.redirectUri === redirectUri
					? { clientId: existing.clientId, clientSecret: existing.clientSecret }
					: await this.register(metadata, redirectUri, scope);

			const verifier = base64url(randomBytes(32));
			const challenge = base64url(createHash("sha256").update(verifier).digest());
			const state = base64url(randomBytes(16));

			const authUrl = new URL(metadata.authorization_endpoint);
			authUrl.searchParams.set("response_type", "code");
			authUrl.searchParams.set("client_id", client.clientId);
			authUrl.searchParams.set("redirect_uri", redirectUri);
			authUrl.searchParams.set("code_challenge", challenge);
			authUrl.searchParams.set("code_challenge_method", "S256");
			authUrl.searchParams.set("state", state);
			authUrl.searchParams.set("resource", this.resource);
			if (scope) authUrl.searchParams.set("scope", scope);

			this.options.onAuthorizationUrl?.(authUrl.toString());
			openBrowser(authUrl.toString());

			const code = await server.waitForCode(state, options.timeoutMs ?? 300_000);

			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: client.clientId,
				code_verifier: verifier,
				resource: this.resource,
			});
			if (client.clientSecret) body.set("client_secret", client.clientSecret);

			const response = await fetch(metadata.token_endpoint, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body,
			});
			if (!response.ok) {
				throw new Error(`Token exchange failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
			}
			const token = (await response.json()) as {
				access_token: string;
				refresh_token?: string;
				expires_in?: number;
				scope?: string;
			};

			this.save({
				resource: this.resource,
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
				scope: token.scope ?? scope,
				clientId: client.clientId,
				clientSecret: client.clientSecret,
				redirectUri,
				metadata,
			});
			this.log("oauth login complete");
			return token.access_token;
		} finally {
			server.close();
		}
	}

	logout(): void {
		const store = readStore(this.storePath);
		delete store[this.resource];
		writeStore(this.storePath, store);
	}

	describe(): string {
		const entry = this.load();
		if (!entry.accessToken) return "not authenticated";
		if (entry.expiresAt) {
			const remaining = entry.expiresAt - Date.now();
			if (remaining <= 0) return entry.refreshToken ? "token expired (will refresh)" : "token expired";
			return `authenticated (expires in ${Math.round(remaining / 60_000)} min)`;
		}
		return "authenticated";
	}
}

/* ------------------------------------------------------- loopback redirect */

interface LoopbackServer {
	waitForCode(expectedState: string, timeoutMs: number): Promise<string>;
	close(): void;
}

async function startLoopbackServer(): Promise<{ server: LoopbackServer; port: number }> {
	let resolveCode: ((code: string) => void) | undefined;
	let rejectCode: ((error: Error) => void) | undefined;
	let expected: string | undefined;

	const http = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!url.pathname.startsWith("/callback")) {
			res.writeHead(404).end("not found");
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");

		const reply = (status: number, message: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><meta charset="utf-8"><title>pi</title>
<body style="font-family:system-ui;padding:3rem;text-align:center">
<h2>${message}</h2><p>You can close this tab and return to pi.</p></body>`);
		};

		if (error) {
			reply(400, `Authorization failed: ${error}`);
			rejectCode?.(new Error(`Authorization denied: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim()));
			return;
		}
		if (!code) {
			reply(400, "Authorization failed: no code returned");
			rejectCode?.(new Error("No authorization code in redirect"));
			return;
		}
		if (expected && state !== expected) {
			reply(400, "Authorization failed: state mismatch");
			rejectCode?.(new Error("OAuth state mismatch (possible CSRF)"));
			return;
		}
		reply(200, "Authorized \u2713");
		resolveCode?.(code);
	});

	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (http.address() as AddressInfo).port;

	const server: LoopbackServer = {
		waitForCode(expectedState, timeoutMs) {
			expected = expectedState;
			return new Promise<string>((resolve, reject) => {
				resolveCode = resolve;
				rejectCode = reject;
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for OAuth redirect after ${timeoutMs}ms`)), timeoutMs);
				timer.unref?.();
			});
		},
		close() {
			http.close();
		},
	};

	return { server, port };
}

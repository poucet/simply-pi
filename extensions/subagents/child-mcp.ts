/**
 * pi's built-in MCP support, narrowed to the servers a child was given.
 *
 * Loaded *inside* a child (`-e <this file>`) in place of `builtin:mcp`, and only
 * when the child's scope names particular servers. A child with no scope gets
 * no MCP extension at all, and a child scoped to `"*"` gets `builtin:mcp`
 * itself; see `childExtensionArgs` in manager.ts, which makes that choice.
 *
 * ## Why not `builtin:mcp` plus a filter
 *
 * The builtin connects every enabled server in `mcp.json` the moment a session
 * starts. `--tools` and `--exclude-tools` can hide a server's tools, but its
 * connection (a process for a stdio server, an OAuth round trip for a remote
 * one) still happens, in every child, on every spawn: exactly the cost the
 * allowlist in `shared/mcp-scope.ts` exists to avoid. The builtin offers one
 * seam that decides which servers exist, its factory's `loadConfig` option, so
 * this file builds the builtin from its own factory with that option set.
 *
 * ## Reaching the factory
 *
 * `createMcpExtension` is not exported from the package root, so it is loaded
 * from the installed package's `dist/` by path, located from the pi executable
 * this process is running. That ties this file to the layout of pi's `dist/`;
 * when the layout moves, loading fails loudly (an extension load error naming
 * the missing file) rather than leaving a child silently without its servers.
 * The copy loaded this way is the same version as the running pi, but a second
 * module instance beside its bundle: harmless here, because the extension talks
 * to pi only through the `ExtensionAPI` it is handed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { childMcpScope, mcpScopeAllows } from "../shared/mcp-scope.ts";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** The shape of `loadMcpConfig`'s result that this file relies on. */
interface LoadedMcpConfig {
	servers: Array<{ name: string }>;
	[key: string]: unknown;
}

/**
 * A loaded config with only the servers the scope allows.
 *
 * Everything else (errors, the project config, `autoEnableCodemode`) is kept:
 * a config error in a server the child will never boot is still a config error.
 */
export function scopeMcpConfig<T extends LoadedMcpConfig>(loaded: T, scope: readonly string[]): T {
	return { ...loaded, servers: loaded.servers.filter((server) => mcpScopeAllows(scope, server.name)) };
}

/**
 * The installed pi package's root, found from the executable that started this
 * process (`dist/bundle/cli.js` or `dist/cli.js` today).
 */
export function piPackageRoot(executable: string | undefined = process.argv[1]): string | undefined {
	if (!executable) return undefined;
	let dir: string;
	try {
		dir = dirname(realpathSync(executable));
	} catch {
		return undefined;
	}
	while (dir !== dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				if (JSON.parse(readFileSync(manifest, "utf-8")).name === PI_PACKAGE_NAME) return dir;
			} catch {
				/* not a manifest we can read; keep walking */
			}
		}
		dir = dirname(dir);
	}
	return undefined;
}

/** Import one module from pi's `dist/`, failing with the path it looked for. */
async function importPiDist(root: string, ...parts: string[]): Promise<any> {
	const file = join(root, "dist", ...parts);
	if (!existsSync(file)) {
		throw new Error(`cannot scope MCP servers: ${file} is missing (pi's dist layout changed?)`);
	}
	return import(pathToFileURL(file).href);
}

export default async function scopedMcp(pi: ExtensionAPI): Promise<void> {
	// Outside a child this file has no scope to apply; it is only ever loaded by
	// the manager, but loading it by hand must not quietly hide servers.
	const scope = childMcpScope();
	if (!scope || scope.length === 0) return;

	const root = piPackageRoot();
	if (!root) {
		throw new Error(`cannot scope MCP servers: no ${PI_PACKAGE_NAME} package above ${process.argv[1]}`);
	}
	const [mcp, mcpConfig, config] = await Promise.all([
		importPiDist(root, "extensions", "mcp", "index.js"),
		importPiDist(root, "extensions", "mcp", "config.js"),
		importPiDist(root, "config.js"),
	]);
	const install = mcp.createMcpExtension({
		// The same call the builtin's own default makes, then narrowed.
		loadConfig: (ctx: { cwd: string; isProjectTrusted(): boolean }) =>
			scopeMcpConfig(
				mcpConfig.loadMcpConfig({
					agentDir: config.getAgentDir(),
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
				}) as LoadedMcpConfig,
				scope,
			),
	});
	await install(pi);
}

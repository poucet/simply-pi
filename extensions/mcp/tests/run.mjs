/**
 * Test runner for the MCP badges extension.
 *
 * The extension is TypeScript that pi loads through jiti; node's native
 * strip-only TypeScript support cannot load everything in this repo, so the
 * tests are loaded through jiti with the same module aliases pi uses, and
 * `node:test` reports the results. Same pattern as
 * `extensions/subagents/tests/run.mjs`.
 *
 *   node extensions/mcp/tests/run.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The extension reads the builtin's config from `getAgentDir()`, which is
// `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. Point both at scratch directories
// for the whole suite — before jiti loads anything — so no test can read the
// developer's real `mcp.json`. Tests that want a config write their own agent
// dir and set `PI_CODING_AGENT_DIR` themselves.
process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-mcp-tests-home-"));
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-mcp-tests-agent-"));

// `POLL_MS` is read once, at module import. The default two seconds is right
// for a session and hopeless for a test suite, so the poll tests get a fast
// clock before jiti loads `index.ts`.
process.env.PI_MCP_BADGE_POLL_MS = "25";

/** Locate the installed pi package, whose node_modules we borrow. */
function piPackageRoot() {
	if (process.env.PI_PACKAGE_ROOT) return process.env.PI_PACKAGE_ROOT;
	let bin;
	try {
		bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf-8" }).trim());
	} catch {
		throw new Error("cannot find the pi CLI on PATH; set PI_PACKAGE_ROOT to the package directory");
	}
	let dir = path.dirname(bin);
	while (dir !== path.dirname(dir)) {
		if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "node_modules"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`cannot locate the pi package from ${bin}; set PI_PACKAGE_ROOT`);
}

const root = piPackageRoot();
// Resolved by path rather than by `require.resolve`: these packages only declare
// an `import` condition, so CJS resolution refuses their subpaths.
const dep = (...parts) => {
	const file = path.join(root, "node_modules", ...parts);
	if (!existsSync(file)) throw new Error(`missing dependency for tests: ${file}`);
	return file;
};

const piAiCompat = dep("@earendil-works", "pi-ai", "dist", "compat.js");
const alias = {
	"@earendil-works/pi-coding-agent": path.join(root, "dist", "index.js"),
	"@earendil-works/pi-agent-core": dep("@earendil-works", "pi-agent-core", "dist", "index.js"),
	"@earendil-works/pi-tui": dep("@earendil-works", "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-ai/compat": piAiCompat,
	"@earendil-works/pi-ai": piAiCompat,
};

const { createJiti } = await import(path.join(root, "node_modules", "jiti", "lib", "jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias, interopDefault: true, moduleCache: false });

const files = process.argv.slice(2).length
	? process.argv.slice(2).map((f) => path.resolve(f))
	: readdirSync(here)
			.filter((f) => f.endsWith(".test.ts"))
			.sort()
			.map((f) => path.join(here, f));

for (const file of files) await jiti.import(file);

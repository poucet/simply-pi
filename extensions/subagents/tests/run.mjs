/**
 * Test runner for the subagents extension.
 *
 * The extension is TypeScript that pi loads through jiti, and node's native
 * strip-only TypeScript support rejects the parameter properties this code uses
 * (`constructor(private options: …)`), so `node --test --experimental-strip-types`
 * cannot load it. We therefore load the tests through jiti exactly like pi does,
 * with the same module aliases, and let `node:test` report the results.
 *
 *   node extensions/subagents/tests/run.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Everything the extension persists — the registry, shared notes, child session
// directories — hangs off `PI_CODING_AGENT_DIR` via `subagentsRoot()`. Point it
// at a scratch directory for the whole suite so no test can write into the
// user's real `~/.pi/agent`, whatever it forgets to isolate for itself.
process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(path.join(tmpdir(), "pi-subagents-tests-"));

// The suite may itself be running inside a subagent, where the extension
// correctly suppresses its UI. The parent-side tests need the parent behaviour.
delete process.env.PI_SUBAGENT;
delete process.env.PI_SUBAGENT_NAME;
// `PI_SUBAGENT_PARENT` too, and it is the one that actually bit: `isSubagentBoot`
// ignores it, but `sessionIdentity` reads it and reports `isChild: true` — so
// `surveyRegistry` returned early and two cold-start tests failed, but *only*
// when the suite was run from inside a subagent. Clearing the boot flags without
// clearing the parentage was a half-isolation.
delete process.env.PI_SUBAGENT_PARENT;
delete process.env.PI_SUBAGENT_NOTES;
delete process.env.PI_SUBAGENT_ANSWERS;

/** Locate the installed pi package, whose node_modules we borrow. */
function piPackageRoot() {
	if (process.env.PI_PACKAGE_ROOT) return process.env.PI_PACKAGE_ROOT;
	let bin;
	try {
		bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf-8" }).trim());
	} catch {
		throw new Error("cannot find the pi CLI on PATH; set PI_PACKAGE_ROOT to the package directory");
	}
	// .../@earendil-works/pi-coding-agent/dist/cli.js
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
const typebox = dep("typebox", "build", "index.mjs");
const alias = {
	"@earendil-works/pi-coding-agent": path.join(root, "dist", "index.js"),
	"@earendil-works/pi-agent-core": dep("@earendil-works", "pi-agent-core", "dist", "index.js"),
	"@earendil-works/pi-tui": dep("@earendil-works", "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-ai/providers/all": dep("@earendil-works", "pi-ai", "dist", "providers", "all.js"),
	"@earendil-works/pi-ai/compat": piAiCompat,
	"@earendil-works/pi-ai/oauth": dep("@earendil-works", "pi-ai", "dist", "oauth.js"),
	"@earendil-works/pi-ai": piAiCompat,
	typebox: typebox,
	"typebox/compile": dep("typebox", "build", "compile", "index.mjs"),
	"typebox/value": dep("typebox", "build", "value", "index.mjs"),
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

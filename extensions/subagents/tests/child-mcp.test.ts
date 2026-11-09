/**
 * Which MCP servers and tools a child is launched with.
 *
 * pi's built-in MCP support is off in a child unless the launch brings it back
 * (`--no-extensions` disables built-ins too), so the mapping from MCP scope to
 * extensions and tools is what decides whether a child can call its servers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { piPackageRoot, scopeMcpConfig } from "../child-mcp.ts";
import { PI_BUILTIN_EXTENSIONS, childExtensionArgs, childToolsArg } from "../manager.ts";

const INHERITED = ["/ext/simply-pi/index.ts", "builtin:llama.cpp", "builtin:codemode", "builtin:tool-search", "builtin:mcp"];
const never = () => false;

test("every built-in pi ships is asked for", () => {
	assert.deepEqual([...PI_BUILTIN_EXTENSIONS].sort(), ["codemode", "llama.cpp", "mcp", "tool-search"]);
});

test("no scope: no MCP extension at all, the other built-ins stay", () => {
	const args = childExtensionArgs(INHERITED, [], true);
	assert.deepEqual(args, ["/ext/simply-pi/index.ts", "builtin:llama.cpp", "builtin:codemode", "builtin:tool-search"]);
	assert.deepEqual(childExtensionArgs(INHERITED, undefined, true), args, "unset is the empty scope");
});

test('"*" keeps the builtin, every configured server', () => {
	assert.ok(childExtensionArgs(INHERITED, ["*"], true).includes("builtin:mcp"));
});

test("named servers swap the builtin for the scoped extension", () => {
	const args = childExtensionArgs(INHERITED, ["linear"], true);
	assert.ok(!args.includes("builtin:mcp"));
	assert.equal(args.filter((a) => a.endsWith("child-mcp.ts")).length, 1);
});

test("a user who disabled builtin:mcp is not given MCP by a scope", () => {
	const withoutMcp = INHERITED.filter((e) => e !== "builtin:mcp");
	const args = childExtensionArgs(withoutMcp, ["linear"], true);
	assert.ok(!args.some((a) => a === "builtin:mcp" || a.endsWith("child-mcp.ts")));
});

test("untrusted paths are existence-checked, built-ins are not", () => {
	assert.deepEqual(childExtensionArgs(INHERITED, [], false, never), [
		"builtin:llama.cpp",
		"builtin:codemode",
		"builtin:tool-search",
	]);
});

test("a tools allowlist gains codemode only when the child has MCP and codemode", () => {
	const scoped = childExtensionArgs(INHERITED, ["linear"], true);
	assert.equal(childToolsArg(["read"], scoped), "read,codemode,report_to_parent,shared_notes");
	const unscoped = childExtensionArgs(INHERITED, [], true);
	assert.equal(childToolsArg(["read"], unscoped), "read,report_to_parent,shared_notes");
	const noCodemode = scoped.filter((a) => a !== "builtin:codemode");
	assert.equal(childToolsArg(["read"], noCodemode), "read,report_to_parent,shared_notes");
	assert.equal(childToolsArg(["read", "codemode"], scoped), "read,codemode,report_to_parent,shared_notes");
	assert.equal(childToolsArg(undefined, scoped), undefined, "no allowlist: pi's defaults, and MCP activates codemode");
});

test("the scoped config keeps only allowed servers, case-insensitively, and everything else", () => {
	const loaded = {
		servers: [{ name: "flux" }, { name: "Linear" }, { name: "tussen" }],
		errors: ["bad entry"],
		autoEnableCodemode: true,
	};
	const scoped = scopeMcpConfig(loaded, ["linear"]);
	assert.deepEqual(scoped.servers, [{ name: "Linear" }]);
	assert.deepEqual(scoped.errors, ["bad entry"]);
	assert.equal(scoped.autoEnableCodemode, true);
	assert.equal(scopeMcpConfig(loaded, ["*"]).servers.length, 3);
});

test("pi's package root is found from a symlinked executable", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "child-mcp-")));
	try {
		const pkg = join(dir, "lib", "pi");
		mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
		writeFileSync(join(pkg, "dist", "bundle", "cli.js"), "");
		mkdirSync(join(dir, "bin"));
		symlinkSync(join(pkg, "dist", "bundle", "cli.js"), join(dir, "bin", "pi"));
		assert.equal(piPackageRoot(join(dir, "bin", "pi")), pkg);
		assert.equal(piPackageRoot(join(dir, "nowhere")), undefined);
		assert.equal(piPackageRoot(undefined), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

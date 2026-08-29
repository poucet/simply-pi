/**
 * Which MCP servers a subagent is allowed to see.
 *
 * Children inherit the `mcp` extension now (it used to be denied outright), so
 * the thing standing between a delegated task and ~90 tools booting inside every
 * child is this filter. Two properties are load-bearing and neither is obvious
 * from reading `loadMcpConfig`:
 *
 *   1. **An unscoped child sees nothing.** The allowlist is empty by default, so
 *      the change of policy cannot widen anybody's children by accident.
 *   2. **A child cannot reach out of itself.** Its scope arrives in its own
 *      environment, and `mcp-state.json` — which is global across projects *and*
 *      processes — is neither read nor written inside a child. That is what makes
 *      two concurrent children with different scopes non-interacting rather than
 *      merely unlikely to collide.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadDisabledServers, loadMcpConfig, saveDisabledServers } from "../config.ts";
import {
	decodeMcpScope,
	encodeMcpScope,
	MCP_SCOPE_ENV,
	mcpScopeAllows,
	childMcpScope,
	parseMcpScope,
} from "../../shared/mcp-scope.ts";

const STATE_FILE = path.join(homedir(), ".pi", "agent", "mcp-state.json");

/**
 * Run `body` as if this process were a subagent with the given scope.
 *
 * The variables are restored afterwards because the whole suite shares one
 * process: a leaked `PI_SUBAGENT` would make every later test think it is a
 * child, and the failure would land somewhere unrelated.
 */
function asChild<T>(scope: string[] | undefined, body: () => T): T {
	const previous = {
		flag: process.env.PI_SUBAGENT,
		name: process.env.PI_SUBAGENT_NAME,
		scope: process.env[MCP_SCOPE_ENV],
	};
	process.env.PI_SUBAGENT = "1";
	delete process.env.PI_SUBAGENT_NAME;
	process.env[MCP_SCOPE_ENV] = encodeMcpScope(scope);
	try {
		return body();
	} finally {
		if (previous.flag === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = previous.flag;
		if (previous.name === undefined) delete process.env.PI_SUBAGENT_NAME;
		else process.env.PI_SUBAGENT_NAME = previous.name;
		if (previous.scope === undefined) delete process.env[MCP_SCOPE_ENV];
		else process.env[MCP_SCOPE_ENV] = previous.scope;
	}
}

/**
 * A config file with three servers, pointed at by `PI_MCP_CONFIG`.
 *
 * `cleanup` restores the variable rather than merely deleting the directory:
 * one process runs the whole suite, and a `PI_MCP_CONFIG` left behind would
 * hand this file's servers to every later test — which is exactly the kind of
 * order-dependent failure the runner's HOME redirect exists to prevent.
 */
function config(): { dir: string; cleanup: () => void } {
	const previous = process.env.PI_MCP_CONFIG;
	const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-scope-"));
	const file = path.join(dir, "mcp.json");
	writeFileSync(
		file,
		JSON.stringify({
			mcpServers: {
				notion: { url: "https://example.com/notion" },
				linear: { url: "https://example.com/linear" },
				grafana: { url: "https://example.com/grafana" },
			},
		}),
	);
	process.env.PI_MCP_CONFIG = file;
	return {
		dir,
		cleanup() {
			if (previous === undefined) delete process.env.PI_MCP_CONFIG;
			else process.env.PI_MCP_CONFIG = previous;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function names(cwd: string): string[] {
	return loadMcpConfig(cwd).servers.map((server) => server.name).sort();
}

// --- parsing ----------------------------------------------------------------

test("an absent scope is not an empty one", () => {
	// The distinction matters one layer up: `undefined` lets the install-wide
	// default apply, `[]` is a deliberate "no servers" that must beat it.
	assert.equal(parseMcpScope(undefined), undefined);
	assert.equal(parseMcpScope("notion"), undefined);
	assert.deepEqual(parseMcpScope([]), []);
});

test("entries are trimmed, de-duplicated and ordered", () => {
	// A stable shape is what lets a revive compare the new scope against the old.
	assert.deepEqual(parseMcpScope([" notion ", "linear", "notion", "", 42]), ["linear", "notion"]);
});

test("the wire format survives a round trip, and an unset variable is empty", () => {
	assert.deepEqual(decodeMcpScope(encodeMcpScope(["notion", "linear"])), ["notion", "linear"]);
	assert.deepEqual(decodeMcpScope(encodeMcpScope([])), []);
	assert.deepEqual(decodeMcpScope(undefined), []);
});

test("matching is case-insensitive, and the wildcard admits everything", () => {
	// Server names come from hand-written JSON; a child silently losing `Notion`
	// because the config said `notion` would be the same silent drop this whole
	// mechanism exists to prevent.
	assert.equal(mcpScopeAllows(["notion"], "Notion"), true);
	assert.equal(mcpScopeAllows(["notion"], "linear"), false);
	assert.equal(mcpScopeAllows(["*"], "anything-at-all"), true);
	assert.equal(mcpScopeAllows([], "notion"), false);
});

test("the scope is inert outside a subagent", () => {
	// Otherwise a stray PI_SUBAGENT_MCP exported in somebody's shell profile would
	// quietly narrow their *own* MCP servers, with nothing to explain why.
	const previous = process.env[MCP_SCOPE_ENV];
	process.env[MCP_SCOPE_ENV] = "notion";
	try {
		assert.equal(childMcpScope({ [MCP_SCOPE_ENV]: "notion" }), undefined);
	} finally {
		if (previous === undefined) delete process.env[MCP_SCOPE_ENV];
		else process.env[MCP_SCOPE_ENV] = previous;
	}
});

// --- what a child actually loads --------------------------------------------

test("the parent sees every configured server", () => {
	const { dir, cleanup } = config();
	try {
		assert.deepEqual(names(dir), ["grafana", "linear", "notion"]);
	} finally {
		cleanup();
	}
});

test("an unscoped child boots no servers at all", () => {
	const { dir, cleanup } = config();
	try {
		// The default that keeps this change from widening anyone's children: the
		// same observable behaviour as when `mcp` was on the denylist.
		assert.deepEqual(asChild([], () => names(dir)), []);
	} finally {
		cleanup();
	}
});

test("a scoped child boots exactly its subset", () => {
	const { dir, cleanup } = config();
	try {
		assert.deepEqual(asChild(["notion"], () => names(dir)), ["notion"]);
		assert.deepEqual(asChild(["notion", "grafana"], () => names(dir)), ["grafana", "notion"]);
	} finally {
		cleanup();
	}
});

test("a server outside the scope is invisible, not merely unconnected", () => {
	const { dir, cleanup } = config();
	try {
		// Filtered in `loadMcpConfig`, which every consumer goes through, so an
		// out-of-scope server cannot appear in the status line or be re-enabled
		// with `/mcp enable` from inside the child.
		const loaded = asChild(["notion"], () => loadMcpConfig(dir));
		assert.equal(loaded.servers.find((s) => s.name === "linear"), undefined);
		// Config *files* are still reported, so genuine config errors still surface.
		assert.equal(loaded.files.length, 1);
	} finally {
		cleanup();
	}
});

test("the wildcard gives a child the parent's whole set", () => {
	const { dir, cleanup } = config();
	try {
		assert.deepEqual(asChild(["*"], () => names(dir)), ["grafana", "linear", "notion"]);
	} finally {
		cleanup();
	}
});

test("two scopes evaluated back to back do not bleed into each other", () => {
	const { dir, cleanup } = config();
	try {
		// Concurrent children are separate processes with separate environments;
		// this is the strongest statement available in one process, and it is the
		// property that would break if the scope were ever cached in a module-level
		// variable or written to a shared file.
		const a = asChild(["notion"], () => names(dir));
		const b = asChild(["linear"], () => names(dir));
		assert.deepEqual(a, ["notion"]);
		assert.deepEqual(b, ["linear"]);
		assert.deepEqual(names(dir), ["grafana", "linear", "notion"], "the parent is unaffected");
	} finally {
		cleanup();
	}
});

// --- the global state file --------------------------------------------------

test("a child neither reads nor writes the shared disabled-servers state", () => {
	rmSync(STATE_FILE, { force: true });
	// The parent's own `/mcp disable linear`.
	saveDisabledServers(new Set(["linear"]));
	assert.deepEqual([...loadDisabledServers()], ["linear"]);

	asChild(["notion", "linear"], () => {
		// Not read: the child's server set is decided by its scope alone, so an
		// unrelated toggle in the parent cannot narrow it further behind its back.
		assert.deepEqual([...loadDisabledServers()], []);
		// Not written: `/mcp disable` inside a child would otherwise reach out of
		// that child and turn the server off for the parent and every sibling.
		saveDisabledServers(new Set(["notion", "grafana"]));
	});

	assert.deepEqual(
		[...loadDisabledServers()],
		["linear"],
		"the parent's state survived the child untouched",
	);
	rmSync(STATE_FILE, { force: true });
});

test("a child does not create the state file even when none exists", () => {
	rmSync(STATE_FILE, { force: true });
	asChild([], () => saveDisabledServers(new Set(["notion"])));
	assert.equal(existsSync(STATE_FILE), false);
});

/**
 * The derivation: observable facts in, `StatusServer`s out.
 *
 * Everything here is pure (`observe.ts` has no pi imports), so the tests are
 * plain data in both directions. The properties that matter are the ones a
 * wrong derivation would misreport on a real install: a hidden tool counted as
 * visible, a `-` in a server name failing to match its `_` namespace, config
 * losing to a registered duplicate, or a server the builtin is demonstrably
 * running being dropped because this observer could not find its config.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { deriveServers, mcpNamespace, mergeByName, parseMcpJson, readMcpEntries, type ObservedServer, type ObservedTool } from "../observe.ts";

const server = (name: string, enabled = true): ObservedServer => ({ name, enabled });
const tool = (namespace: string, exposure?: string): ObservedTool => ({
	exposure,
	namespace: { name: namespace },
});

// --- mcpNamespace -----------------------------------------------------------

test("the namespace is mcp__ plus the name with dashes flattened", () => {
	assert.equal(mcpNamespace("docs"), "mcp__docs");
	assert.equal(mcpNamespace("my-server"), "mcp__my_server");
	assert.equal(mcpNamespace("a-b-c"), "mcp__a_b_c");
});

// --- parseMcpJson -----------------------------------------------------------

test("a well-formed mcpServers map parses with its enabled flags", () => {
	const entries = parseMcpJson(
		JSON.stringify({
			mcpServers: {
				docs: { url: "https://example.com/mcp" },
				off: { command: "x", enabled: false },
			},
		}),
	);
	assert.deepEqual(entries, [
		{ name: "docs", enabled: true },
		{ name: "off", enabled: false },
	]);
});

test("entries the builtin would reject still count as enabled", () => {
	// Over-counting shows one more "connecting" chip; under-counting hides a
	// server the builtin may well be running. The builtin reports config errors
	// itself, so this observer does not judge shapes.
	const entries = parseMcpJson(JSON.stringify({ mcpServers: { odd: "https://bare-string" } }));
	assert.deepEqual(entries, [{ name: "odd", enabled: true }]);
});

test("garbage and wrong shapes contribute nothing, silently", () => {
	assert.deepEqual(parseMcpJson("not json at all"), []);
	assert.deepEqual(parseMcpJson("null"), []);
	assert.deepEqual(parseMcpJson(JSON.stringify({})), []);
	assert.deepEqual(parseMcpJson(JSON.stringify({ mcpServers: [] })), []);
	assert.deepEqual(parseMcpJson(JSON.stringify({ mcpServers: "nope" })), []);
});

// --- readMcpEntries ---------------------------------------------------------

test("a missing file reads as no servers", () => {
	assert.deepEqual(readMcpEntries(path.join(tmpdir(), "definitely", "not", "mcp.json")), []);
});

test("an unreadable or garbage file reads as no servers", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-observe-"));
	const file = path.join(dir, "mcp.json");
	writeFileSync(file, "{ this is not json");
	assert.deepEqual(readMcpEntries(file), []);
});

// --- mergeByName ------------------------------------------------------------

test("the project file replaces global entries with the same name", () => {
	const merged = mergeByName(
		[server("docs"), server("linear")],
		[server("docs", false)], // project switches docs off
	);
	assert.deepEqual(merged, [
		{ name: "docs", enabled: false },
		{ name: "linear", enabled: true },
	]);
});

// --- deriveServers ----------------------------------------------------------

test("enabled with tools is ready; enabled without is connecting; disabled is disabled", () => {
	const derived = deriveServers(
		[server("up"), server("dialling"), server("off", false)],
		[],
		[tool("mcp__up"), tool("mcp__up"), tool("mcp__up")],
	);
	assert.deepEqual(derived, [
		{ status: "ready", tools: 3 },
		{ status: "connecting", tools: 0 },
		{ status: "disabled", tools: 0 },
	]);
});

test("hidden tools are not counted — they are the builtin's withdrawn tools", () => {
	const derived = deriveServers(
		[server("docs")],
		[],
		[tool("mcp__docs"), tool("mcp__docs", "hidden"), tool("mcp__docs", "direct")],
	);
	assert.deepEqual(derived, [{ status: "ready", tools: 2 }]);
});

test("a server left with only hidden tools reads as connecting, not ready", () => {
	const derived = deriveServers([server("docs")], [], [tool("mcp__docs", "hidden")]);
	assert.deepEqual(derived, [{ status: "connecting", tools: 0 }]);
});

test("a dashed server name matches its underscored namespace", () => {
	const derived = deriveServers([server("my-server")], [], [tool("mcp__my_server")]);
	assert.deepEqual(derived, [{ status: "ready", tools: 1 }]);
});

test("registered servers join the set beside the configured ones", () => {
	const derived = deriveServers(
		[server("configured")],
		[server("registered"), server("registered-off", false)],
		[tool("mcp__registered")],
	);
	assert.deepEqual(derived, [
		{ status: "connecting", tools: 0 },
		{ status: "ready", tools: 1 },
		{ status: "disabled", tools: 0 },
	]);
});

test("config wins over a registered server of the same name, as the builtin's does", () => {
	const derived = deriveServers([server("docs", false)], [server("docs", true)], []);
	assert.deepEqual(derived, [{ status: "disabled", tools: 0 }]);
});

test("the collision is matched on namespace, so docs-x in config overrides a registered docs_x", () => {
	const derived = deriveServers([server("docs-x", false)], [server("docs_x", true)], []);
	assert.deepEqual(derived, [{ status: "disabled", tools: 0 }]);
});

test("an mcp__* namespace matching no known server still counts, as ready", () => {
	// The builtin is demonstrably running it — its tools exist — whatever this
	// observer failed to find in config (an untrusted project file, a source a
	// future pi grows).
	const derived = deriveServers([], [], [tool("mcp__mystery"), tool("mcp__mystery")]);
	assert.deepEqual(derived, [{ status: "ready", tools: 2 }]);
});

test("an unknown namespace with only hidden tools introduces nothing", () => {
	assert.deepEqual(deriveServers([], [], [tool("mcp__gone", "hidden")]), []);
});

test("tools without a namespace, or outside mcp__, are ignored entirely", () => {
	const derived = deriveServers([server("docs")], [], [
		{ exposure: "direct" }, // a plain pi tool
		tool("read"), // namespaced, but not MCP
		tool("mcp__docs"),
	]);
	assert.deepEqual(derived, [{ status: "ready", tools: 1 }]);
});

test("nothing observable derives to nothing", () => {
	assert.deepEqual(deriveServers([], [], []), []);
});

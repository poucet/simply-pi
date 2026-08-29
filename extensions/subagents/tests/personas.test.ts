import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describePersonas, discoverPersonas, findPersona, parseToolList } from "../personas.ts";

// --- parseToolList --------------------------------------------------------

test("parseToolList reads a comma-separated string", () => {
	assert.deepEqual(parseToolList("read, bash ,grep"), ["read", "bash", "grep"]);
});

test("parseToolList reads a YAML sequence", () => {
	assert.deepEqual(parseToolList(["read", " bash "]), ["read", "bash"]);
});

test("parseToolList drops empties and non-strings", () => {
	assert.deepEqual(parseToolList(["read", "", 3, null]), ["read"]);
	assert.equal(parseToolList(""), undefined);
	assert.equal(parseToolList(" , "), undefined);
	assert.equal(parseToolList(undefined), undefined);
	assert.equal(parseToolList(42), undefined);
});

// --- discovery ------------------------------------------------------------

function persona(body: string): string {
	return body;
}

test("discoverPersonas reads user personas and honours project trust", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-personas-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(project, ".pi", "agents"), { recursive: true });

	writeFileSync(
		join(agentDir, "agents", "reviewer.md"),
		persona("---\nname: reviewer\ndescription: reviews diffs\ntools: read, bash\nmodel: x/y\n---\nBe strict.\n"),
	);
	// No frontmatter name: the filename wins.
	writeFileSync(join(agentDir, "agents", "scout.md"), persona("Scout the code.\n"));
	// Empty body: not a persona.
	writeFileSync(join(agentDir, "agents", "blank.md"), persona("---\nname: blank\n---\n\n"));
	// Not markdown: ignored.
	writeFileSync(join(agentDir, "agents", "notes.txt"), persona("nope"));
	writeFileSync(
		join(project, ".pi", "agents", "reviewer.md"),
		persona("---\nname: reviewer\ndescription: project override\n---\nProject rules.\n"),
	);

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const userOnly = discoverPersonas(project, false);
		assert.deepEqual(
			userOnly.map((p) => p.name).sort(),
			["reviewer", "scout"],
		);
		const reviewer = findPersona(userOnly, "REVIEWER");
		assert.equal(reviewer?.source, "user");
		assert.deepEqual(reviewer?.tools, ["read", "bash"]);
		assert.equal(reviewer?.model, "x/y");
		assert.match(reviewer!.systemPrompt, /Be strict/);
		assert.equal(findPersona(userOnly, "scout")?.description, "");

		// Trusted project: the project persona wins over the user one.
		const withProject = discoverPersonas(join(project, "nested", "deeper"), true);
		const overridden = findPersona(withProject, "reviewer");
		assert.equal(overridden?.source, "project");
		assert.equal(overridden?.description, "project override");

		assert.match(describePersonas(userOnly), /reviewer — reviews diffs/);
		assert.equal(describePersonas([]), "none");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverPersonas returns nothing when the user directory is absent", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-personas-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "missing");
	try {
		assert.deepEqual(discoverPersonas(root, true), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

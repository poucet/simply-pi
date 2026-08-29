/**
 * Persona discovery.
 *
 * A persona is a markdown file with YAML frontmatter that gives a child agent a
 * role, a default model, a tool allowlist and a default context mode. Personas
 * are optional: a child with no persona simply inherits the parent's model,
 * thinking level and tools.
 *
 *     ---
 *     name: reviewer
 *     description: Reviews a diff and reports blocking issues
 *     tools: read, grep, find, ls, bash
 *     model: anthropic/claude-sonnet-4-5
 *     context: fresh
 *     ---
 *     You are a meticulous reviewer. ...
 *
 * The body becomes the child's system prompt with whole-line `@path` mentions
 * expanded (see mentions.ts), resolving against the persona file's own
 * directory — a project persona can @ shared project docs, a user persona can
 * @ other files under `~/.pi/agent`. A mention of a file that doesn't exist
 * contributes nothing, which is what lets a generic role reference optional
 * per-repo hooks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { expandMentions } from "./mentions.ts";
import type { ContextMode } from "./types.ts";

export interface Persona {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	context?: ContextMode;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

type PersonaFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	context?: unknown;
};

const CONTEXT_MODES: readonly ContextMode[] = ["auto", "fresh", "forked", "compacted"];

/**
 * `context: fresh` and friends set a persona's default context mode. An absent,
 * mistyped or unknown value is `undefined` (fall through to the next layer of
 * the precedence: spawn param > persona > "auto") rather than an error — a bad
 * frontmatter key must never brick the persona it sits in.
 */
export function parseContextMode(value: unknown): ContextMode | undefined {
	return typeof value === "string" && CONTEXT_MODES.includes(value as ContextMode)
		? (value as ContextMode)
		: undefined;
}

/**
 * `tools: read, bash` and `tools: [read, bash]` are both valid YAML and both in use.
 *
 * A `"*"` anywhere in the list means "inherit everything": pi's `--tools` is a
 * plain name allowlist that matches literal tool names, so a `"*"` that reached it
 * would strip the child's tools instead of granting them. It returns the
 * no-restriction value (`undefined`) instead, and any names listed alongside a
 * `"*"` are ignored — they were already granted.
 */
export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	if (tools.includes("*")) return undefined;
	return tools.length > 0 ? tools : undefined;
}

function loadDir(dir: string, source: "user" | "project"): Persona[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const personas: Persona[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue; // One unreadable file must not break discovery for the rest.
		}

		const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(content);
		const name =
			typeof frontmatter.name === "string" ? frontmatter.name : path.basename(entry.name, ".md");
		if (!body.trim()) continue;

		// Mentions resolve against the persona file's directory, and the persona
		// file itself seeds the dedup set, so a persona cannot @ itself into a loop.
		const { text: systemPrompt } = expandMentions(body, path.dirname(filePath), filePath);

		personas.push({
			name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			context: parseContextMode(frontmatter.context),
			systemPrompt,
			source,
			filePath,
		});
	}
	return personas;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function nearestProjectPersonaDir(cwd: string): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Personas are re-read on every call so they can be edited mid-session.
 *
 * Project personas are only loaded for trusted projects: a persona is an
 * instruction file that runs with your credentials, so an untrusted repo must
 * not be able to introduce one.
 */
export function discoverPersonas(cwd: string, includeProject: boolean): Persona[] {
	const user = loadDir(path.join(getAgentDir(), "agents"), "user");
	const projectDir = includeProject ? nearestProjectPersonaDir(cwd) : null;
	const project = projectDir ? loadDir(projectDir, "project") : [];

	const byName = new Map<string, Persona>();
	for (const persona of user) byName.set(persona.name.toLowerCase(), persona);
	for (const persona of project) byName.set(persona.name.toLowerCase(), persona); // project wins
	return [...byName.values()];
}

export function findPersona(personas: Persona[], name: string): Persona | undefined {
	return personas.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

export function describePersonas(personas: Persona[]): string {
	if (personas.length === 0) return "none";
	return personas.map((p) => `${p.name}${p.description ? ` — ${p.description}` : ""}`).join("; ");
}

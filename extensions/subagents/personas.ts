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
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	parseFrontmatter,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expandMentions } from "./mentions.ts";
import type { ContextMode } from "./types.ts";

export interface Persona {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	context?: ContextMode;
	systemPrompt: string;
	source: PersonaSource;
	filePath: string;
}

/** Where a persona came from; later sources win a name collision. */
export type PersonaSource = "package" | "user" | "project";

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

function loadDir(dir: string, source: PersonaSource): Persona[] {
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
 * The persona directories installed pi packages declare.
 *
 * pi packages carry extensions, skills, prompts and themes, but no personas, so
 * a package names its persona directories under its own manifest key:
 *
 *     { "pi": { "personas": ["./agents"] } }
 *
 * Paths are directories relative to the package root. Packages come from the
 * same settings pi reads (`packages` in `~/.pi/agent/settings.json`, and in the
 * project's `.pi/settings.json` when the project is trusted), resolved to where
 * they are installed; one that isn't installed contributes nothing. Never
 * throws: a broken manifest costs its own personas, not discovery.
 */
export function packagePersonaDirs(cwd: string, includeProject: boolean): string[] {
	let packages: { scope: string; installedPath?: string }[];
	try {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		packages = manager.listConfiguredPackages();
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const pkg of packages) {
		if (!pkg.installedPath) continue;
		if (pkg.scope === "project" && !includeProject) continue;
		dirs.push(...manifestPersonaDirs(pkg.installedPath));
	}
	return dirs;
}

/** `pi.personas` of the package at `root`, as absolute directories that exist. */
export function manifestPersonaDirs(root: string): string[] {
	let manifest: any;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
	} catch {
		return [];
	}
	const declared = manifest?.pi?.personas;
	const entries = Array.isArray(declared) ? declared : typeof declared === "string" ? [declared] : [];
	return entries
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => path.resolve(root, entry))
		.filter(isDirectory);
}

/**
 * Personas are re-read on every call so they can be edited mid-session.
 *
 * Three layers, later wins a name collision: installed packages' personas
 * (`pi.personas`), the user's `~/.pi/agent/agents`, and the nearest project
 * `.pi/agents`. Project personas — and personas from project-scoped packages —
 * are only loaded for trusted projects: a persona is an instruction file that
 * runs with your credentials, so an untrusted repo must not be able to
 * introduce one.
 */
export function discoverPersonas(cwd: string, includeProject: boolean): Persona[] {
	const fromPackages = packagePersonaDirs(cwd, includeProject).flatMap((dir) => loadDir(dir, "package"));
	const user = loadDir(path.join(getAgentDir(), "agents"), "user");
	const projectDir = includeProject ? nearestProjectPersonaDir(cwd) : null;
	const project = projectDir ? loadDir(projectDir, "project") : [];

	const byName = new Map<string, Persona>();
	for (const persona of [...fromPackages, ...user, ...project]) {
		byName.set(persona.name.toLowerCase(), persona);
	}
	return [...byName.values()];
}

export function findPersona(personas: Persona[], name: string): Persona | undefined {
	return personas.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

export function describePersonas(personas: Persona[]): string {
	if (personas.length === 0) return "none";
	return personas.map((p) => `${p.name}${p.description ? ` — ${p.description}` : ""}`).join("; ");
}

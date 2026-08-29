/**
 * `@path` mention expansion for markdown prompt content — the templating layer
 * for personas and the user orchestrator files.
 *
 * The grammar is deliberately narrow: a mention is a line that is **only**
 * `@<path>` (`^@(\S+)$`, whole line, nothing before or after). An inline
 * `@foo` mid-sentence stays literal text — agents @mention each other in
 * prompts, and expanding those would corrupt meaning. Only the author who
 * dedicates a whole line to a mention gets an include.
 *
 * Resolution: relative paths resolve against the *mentioning file's directory*
 * (so a persona can @ shared docs next to itself), `/`-rooted paths are
 * absolute, and `~/` expands to home. Symlinks are followed — that is a
 * feature: a template can @ a symlinked shared file (see the repo's own
 * `SYSTEM.md` convention).
 *
 * The load-bearing semantic is **fail-silent includes for absent targets**: a
 * mention of a file that does not exist contributes nothing and raises nothing.
 * That is what makes shared generic templates scalable — a shared `SYSTEM.md`
 * can reference an optional per-repo hook (`@.pi/PROJECT.md`) that fires where
 * it exists and contributes nothing where it doesn't. Prompt assembly becomes
 * composition instead of copying. Absent is distinguished from
 * **exists-but-unreadable** (EACCES etc.): someone created that file and
 * something is wrong with it, so that path is reported to the console on every
 * expansion, while an absent one is reported at most once per process.
 *
 * Included files are expanded recursively with two guards: a file already
 * included anywhere in this expansion contributes once (dedup, which also
 * terminates any cycle), and a chain deeper than MAX_DEPTH is cut as
 * belt-and-braces. A mention whose target is empty, absent, or already
 * included leaves no blank line behind; runs of blank lines are normalized so
 * an include slot collapses cleanly rather than accordioning.
 *
 * What is *not* expanded: the bundled `orchestrator.md` (code-adjacent
 * mechanics, authored as final — expanding it would let a typo'd mention
 * silently delete guidance) and the child protocol generated in manager.ts
 * (generated, not markdown-authored). Only user-authored markdown is expanded.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A whole line that is only `@path` — the mention grammar. Inline `@foo` is not this. */
const MENTION_RE = /^@(\S+)$/;
/** Belt-and-braces inclusion-depth cap; the dedup set already terminates cycles. */
const MAX_DEPTH = 5;

export interface ExpansionResult {
	/** The text with every expandable mention line replaced by its target's content. */
	text: string;
	/**
	 * Absolute targets a mention named but which did not contribute: missing,
	 * unreadable, or deeper than the cap. Deduped/cycled targets are *not* here —
	 * including a file once per prompt is normal operation, not a skip to report.
	 */
	skipped: string[];
}

interface SkipState {
	missing: string[];
	unreadable: string[];
	tooDeep: string[];
}

/** Paths whose absence has already been reported once this process. */
const reportedOnce = new Set<string>();

/**
 * Resolve a mention target the way a shell would: `~/` → home, `/` → absolute,
 * anything else relative to the directory of the file containing the mention.
 */
export function resolveMentionPath(spec: string, fromDir: string): string {
	if (spec === "~") return os.homedir();
	if (spec.startsWith("~/")) return path.join(os.homedir(), spec.slice(2));
	if (path.isAbsolute(spec)) return spec;
	return path.resolve(fromDir, spec);
}

/**
 * Canonical form for dedup: the real path when the link chain can be walked,
 * else the resolved path. Two mentions of a file and a symlink to it are the
 * same include.
 */
function canonical(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function expandLines(
	lines: string[],
	fromDir: string,
	seen: Set<string>,
	depth: number,
	state: SkipState,
): string[] {
	const out: string[] = [];
	for (const raw of lines) {
		// Tolerate CRLF prompts without letting the carriage return defeat `$`.
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const match = MENTION_RE.exec(line);
		if (!match) {
			out.push(raw);
			continue;
		}

		const target = resolveMentionPath(match[1], fromDir);
		if (seen.has(canonical(target))) continue; // cycle or dedup: contributes nothing
		if (depth >= MAX_DEPTH) {
			state.tooDeep.push(target);
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(target, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") state.missing.push(target); // absent: silent, expected
			else state.unreadable.push(target); // exists but wrong: loud, every time
			continue;
		}

		seen.add(canonical(target));
		// Mentions inside the include resolve against the include's own directory.
		out.push(...expandLines(content.split("\n"), path.dirname(target), seen, depth + 1, state));
	}
	return out;
}

/**
 * Expand whole-line `@path` mentions in `text`, the content of the file at
 * `rootPath` (or of a virtual document whose mentions resolve from `fromDir`).
 *
 * `rootPath` — when the caller knows the file this text came from — seeds the
 * dedup set, so a file that @s itself (directly or around a cycle) contributes
 * once instead of recursing.
 */
export function expandMentions(text: string, fromDir: string, rootPath?: string): ExpansionResult {
	const seen = new Set<string>();
	if (rootPath !== undefined) {
		const root = canonical(rootPath);
		if (!seen.has(root)) seen.add(root);
	}

	const state: SkipState = { missing: [], unreadable: [], tooDeep: [] };
	const lines = expandLines(text.split("\n"), fromDir, seen, 0, state);
	// Collapse the blank lines an emptied include slot leaves behind, so the
	// surrounding text closes up over the gap instead of accordioning.
	const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n");

	for (const p of state.missing) {
		if (!reportedOnce.has(p)) {
			reportedOnce.add(p);
			console.error(`subagents: @mention target missing, skipped: ${p}`);
		}
	}
	for (const p of state.unreadable) {
		console.error(`subagents: @mention target unreadable, skipped: ${p}`);
	}
	for (const p of state.tooDeep) {
		if (!reportedOnce.has(p)) {
			reportedOnce.add(p);
			console.error(`subagents: @mention chain deeper than ${MAX_DEPTH}, skipped: ${p}`);
		}
	}

	return { text: joined, skipped: [...state.missing, ...state.unreadable, ...state.tooDeep] };
}

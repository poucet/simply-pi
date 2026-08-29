/**
 * Where a child's task text lives, and the one-line label that stands in for it.
 *
 * ## Why the task is not in the registry
 *
 * `registry.json` is read at startup, rewritten on every transition, and holds
 * one node per child *for the whole machine*. It was also holding every child's
 * full task text: measured on a real registry, `task` and `output` together were
 * 85% of a 133 KB file across 16 nodes, and the genuine metadata was ~15 KB.
 *
 * The cost is not disk, it is write amplification. The registry is rewritten
 * whole-file on every transition, so a few dozen kilobytes of free text ride
 * along with every status change of every child, and each rewrite is a window in
 * which the file can be truncated.
 *
 * A task is also exactly the wrong shape for that file: written once at spawn,
 * never modified, and read in full by only two places (the revive nudge and the
 * "its task was" restore line). Everything else wants a label. So the text goes
 * to a file in the child's own directory, beside the `system-prompt.md` and
 * `session.jsonl` that are already there, and the registry keeps the label.
 *
 * ## Why a summary and not a truncation
 *
 * The registry used to render listings with `task.slice(0, 160)`. That reads
 * fine in a unit test and is nearly useless in practice, because real tasks open
 * with boilerplate — a fleet of research children all begin "READ-ONLY research
 * inside a shallow clone of the Go project…" and truncate to *the same 160
 * characters*. The listing then distinguishes them only by name.
 *
 * A summary is therefore a distinct, deliberately lossy field rather than a
 * shortened `task`: `task.md` stays the full text, `taskSummary` is a label
 * chosen to tell two children apart.
 *
 * It is never produced by a model. Summarizing at spawn would add latency, cost
 * and a failure mode to the one operation that must stay cheap and must not fail
 * for a cosmetic reason.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The task text file inside a child's session directory. */
export const TASK_FILE = "task.md";

/** Longest summary we will store. Long enough to be distinguishing, short enough to list. */
const SUMMARY_MAX = 120;

/**
 * Derive a one-line label from task markdown.
 *
 * Takes the first line with content, strips the markdown that makes a heading or
 * a bullet, and collapses whitespace. Cutting on a word boundary rather than
 * mid-word because this is read by a human scanning a list.
 *
 * The caller's own summary is always preferred; this is the fallback for when
 * nobody supplied one.
 */
export function deriveTaskSummary(task: string, max = SUMMARY_MAX): string {
	const line = task
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry !== "");
	if (!line) return "";

	const cleaned = line
		// Heading markers, blockquote markers, and list bullets: all decoration
		// around the first line, none of it information.
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		// Emphasis and inline code fences read as noise in a one-line label.
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length <= max) return cleaned;
	const cut = cleaned.slice(0, max);
	const boundary = cut.lastIndexOf(" ");
	// A single word longer than the cap has no boundary to cut on; take the hard
	// slice rather than returning nothing.
	return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * Pick the summary to store: the caller's words when it offered any, else derived.
 *
 * Never throws and never returns `undefined` for a non-empty task — an empty
 * summary is a cosmetic problem, and this runs on the spawn path where a thrown
 * error would be a real one.
 */
export function resolveTaskSummary(task: string, supplied?: string): string {
	const offered = (supplied ?? "").replace(/\s+/g, " ").trim();
	if (offered) {
		return offered.length <= SUMMARY_MAX ? offered : deriveTaskSummary(offered);
	}
	return deriveTaskSummary(task);
}

/** Absolute path of a child's task file, given its session directory. */
export function taskFilePath(sessionDir: string): string {
	return join(sessionDir, TASK_FILE);
}

/**
 * Write the task text beside the child's transcript.
 *
 * Atomic (temp + rename in the same directory) for the same reason the registry
 * is: a crash mid-write must leave the previous file intact rather than a
 * half-written one. Best-effort — a task we could not persist costs the revive
 * nudge some context, and is not a reason to fail a spawn.
 */
export function writeTaskFile(sessionDir: string, task: string): boolean {
	if (!task) return false;
	const target = taskFilePath(sessionDir);
	const temporary = `${target}.tmp`;
	try {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(temporary, task, { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, target);
		return true;
	} catch {
		try {
			if (existsSync(temporary)) unlinkSync(temporary);
		} catch {
			// The temp file is already the failure path; nothing further to do.
		}
		return false;
	}
}

/**
 * Read a child's task text back.
 *
 * Returns `undefined` when there is nothing to read, which the caller is
 * expected to degrade from (to the summary) rather than treat as an error: the
 * directory may have been cleaned up, and a missing task must never stop a
 * child being revived.
 */
export function readTaskFile(sessionDir: string | undefined): string | undefined {
	if (!sessionDir) return undefined;
	try {
		const target = taskFilePath(sessionDir);
		if (!existsSync(target)) return undefined;
		const text = readFileSync(target, "utf-8");
		return text.trim() ? text : undefined;
	} catch {
		return undefined;
	}
}


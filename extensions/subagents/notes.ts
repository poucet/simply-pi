/**
 * The shared mission notes file.
 *
 * The parent and every child in a session append to the same scratchpad from
 * separate processes, so the write must be a single O_APPEND write: a
 * read-modify-write loses whatever a sibling appended in between, silently.
 * Both `index.ts` (parent) and `child-extension.ts` (children) go through here
 * so the two sides cannot drift apart.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_NOTE_CHARS = 8_000;

export function readNotes(path: string): string {
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Append one authored section. Returns the text that was written.
 *
 * `mode` only applies when the file is created; an existing file keeps its own
 * permissions.
 */
export function appendNote(path: string, author: string, text: string): string {
	const body = String(text ?? "").slice(0, MAX_NOTE_CHARS).trim();
	if (!body) throw new Error("shared notes append requires text");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const section = `\n## ${author} — ${new Date().toISOString()}\n\n${body}\n`;
	appendFileSync(path, section, { encoding: "utf-8", mode: 0o600 });
	return section;
}

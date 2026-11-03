/**
 * Reading a child's session file.
 *
 * A running child appends to its `session.jsonl` continuously, so the last line
 * may be half-written when we read it. We therefore parse line by line and drop
 * anything that does not parse, instead of using `SessionManager.open()` — which
 * would also open a writer against a file another process owns.
 *
 * The `message` payload of a `message` entry is exactly the `AgentMessage` the
 * interactive UI renders, so backfilled history is rendered by the very same
 * components as live traffic.
 */

import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Loose shape: we hand these straight to pi's message components. */
export type LoggedMessage = any;

/**
 * Parse session-file lines, dropping blanks and anything that is not JSON.
 *
 * A line that does not parse is a record we do not understand or the
 * half-written tail of a file another process is appending to; neither is worth
 * failing over.
 */
export function parseSessionLines(lines: Iterable<string>): any[] {
	const entries: any[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* see above */
		}
	}
	return entries;
}

/** The renderable message a session entry carries, if it carries one. */
export function loggedMessageOf(entry: any): LoggedMessage | undefined {
	if (entry?.type !== "message") return undefined;
	const role = entry.message?.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return undefined;
	return entry.message;
}

/** The file operations a {@link SessionFileTail} needs; swappable in tests. */
export interface TailFs {
	statSync(path: string): { size: number };
	openSync(path: string, flags: string): number;
	readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
	closeSync(fd: number): void;
}

const NODE_FS: TailFs = { statSync, openSync, readSync, closeSync };

export interface TailRead {
	/** Complete entries appended since the previous read, in file order. */
	entries: any[];
	/**
	 * The file got shorter than what was already read: it was replaced, so what
	 * the reader built from it is stale. `entries` then starts from the top.
	 */
	reset: boolean;
}

/**
 * Follow a session file another process is appending to.
 *
 * Cheap by construction, because it runs on a timer: one `stat` when nothing
 * changed, and otherwise only the bytes appended since the last read. A trailing
 * line without its newline is held back until it is complete — the writer may be
 * mid-line — and bytes are kept as bytes until then, so a multi-byte character
 * split across two reads is never mangled.
 *
 * Never throws: a missing or unreadable file reads as "nothing new", which is
 * what keeps a broken transcript from taking the UI down with it.
 */
export class SessionFileTail {
	private offset = 0;
	private pending: Buffer = Buffer.alloc(0);

	constructor(
		readonly file: string,
		private readonly fs: TailFs = NODE_FS,
	) {}

	read(): TailRead {
		let size: number;
		try {
			size = this.fs.statSync(this.file).size;
		} catch {
			return { entries: [], reset: false };
		}
		let reset = false;
		if (size < this.offset) {
			this.offset = 0;
			this.pending = Buffer.alloc(0);
			reset = true;
		}
		if (size === this.offset) return { entries: [], reset };

		const chunk = Buffer.alloc(size - this.offset);
		let fd: number | undefined;
		let got = 0;
		try {
			fd = this.fs.openSync(this.file, "r");
			while (got < chunk.length) {
				const n = this.fs.readSync(fd, chunk, got, chunk.length - got, this.offset + got);
				if (n <= 0) break;
				got += n;
			}
		} catch {
			return { entries: [], reset };
		} finally {
			if (fd !== undefined) {
				try {
					this.fs.closeSync(fd);
				} catch {
					/* nothing to recover */
				}
			}
		}
		this.offset += got;

		const buffer = Buffer.concat([this.pending, chunk.subarray(0, got)]);
		const end = buffer.lastIndexOf(0x0a);
		if (end < 0) {
			this.pending = buffer;
			return { entries: [], reset };
		}
		this.pending = Buffer.from(buffer.subarray(end + 1));
		const lines = buffer.subarray(0, end).toString("utf-8").split("\n");
		return { entries: parseSessionLines(lines), reset };
	}
}

/** Flatten a user message's content to the text the UI shows. */
export function userMessageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
}

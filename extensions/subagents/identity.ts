/**
 * Who am I, and whose child am I?
 *
 * Three different questions used to be answered by one environment variable
 * (`PI_SUBAGENT_NAME`):
 *
 *   1. "Am I running inside a subagent?"  — a boot-time fact.
 *   2. "Which subagent am I?"             — an identity.
 *   3. "Should this extension register a UI?" — a policy that depends on (1).
 *
 * Conflating them broke as soon as nesting became allowed: a display name is
 * chosen by the spawning model and is unique only inside one parent's manager,
 * so two parents can each have a `reviewer` and mail keyed by name becomes
 * ambiguous. Worse, "am I a subagent" was *inferred* from a label rather than
 * being a fact about the session.
 *
 * The split this module implements:
 *
 *   - **Identity is the session uuid.** Every pi session has one
 *     (`sessionManager.getSessionId()`), and `context.ts` seeds a child session
 *     header with `id` plus `parentSession` (the parent's session *file*). Both
 *     ends therefore know both ids without anybody having to agree on a name.
 *   - **Parentage is a session fact**, read back with `getHeader().parentSession`.
 *     Not an env var, not a process name, not a naming convention.
 *   - **`PI_SUBAGENT=1` is a boot flag and nothing else.** The UI-suppression
 *     guard has to run inside the extension factory, *before* any session
 *     exists, so it genuinely cannot consult the session. It gets a one-bit
 *     signal and no identity at all.
 *
 * Names survive as *labels*: human- and model-facing text used to address a
 * child within one parent's own children, resolved to a uuid locally.
 */

import { closeSync, openSync, readSync } from "node:fs";

/**
 * Boot-time flag: "this process is a subagent".
 *
 * Deliberately carries no identity. Anything that wants to know *which* agent
 * this is must ask the session, which is the only place that can answer without
 * lying after a resume, a fork or a revive.
 */
export const SUBAGENT_BOOT_ENV = "PI_SUBAGENT";

/**
 * The parent's session uuid, passed to a child at spawn.
 *
 * The session header records the parent's session *file*; this is the uuid the
 * registry is keyed by. It is a convenience, not the source of truth: the
 * registry itself records parentage for every node.
 */
export const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT";

/** Display label for this child. Cosmetic: it names logs and notes entries. */
export const SUBAGENT_LABEL_ENV = "PI_SUBAGENT_NAME";

/** Shared mission notes path (see notes.ts). */
export const NOTES_ENV = "PI_SUBAGENT_NOTES";

/** Directory the parent writes `ask_parent` answers into (see ask.ts). */
export const ANSWERS_ENV = "PI_SUBAGENT_ANSWERS";

/**
 * Am I booting inside a subagent?
 *
 * The one thing that can be known before a session exists. Used by the UI guard
 * in `index.ts` and by nothing else — every other consumer should ask the
 * session, because a boot flag cannot tell you *which* agent you are.
 *
 * `PI_SUBAGENT_NAME` is still honoured so a child started by an older parent (or
 * an older record) keeps suppressing its UI. It is a compatibility shim, not the
 * contract.
 */
export function isSubagentBoot(env: NodeJS.ProcessEnv = process.env): boolean {
	const flag = env[SUBAGENT_BOOT_ENV];
	if (typeof flag === "string" && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false") {
		return true;
	}
	return Boolean(env[SUBAGENT_LABEL_ENV]);
}

/** What a session knows about itself and its parent. */
export interface SessionIdentity {
	/** This session's uuid, when there is a session at all. */
	sessionId?: string;
	/** Path to this session's own file, when it is persisted. */
	sessionFile?: string;
	/** Path to the parent's session file, from the seeded header. */
	parentSessionFile?: string;
	/** The parent's session uuid, when the spawn passed it down. */
	parentSessionId?: string;
	/**
	 * Whether this session is a child of another agent.
	 *
	 * A *session* fact — `parentSession` in the header — not an environment
	 * variable. It stays true across a resume of the child's own session file,
	 * which is exactly when an env var would be gone.
	 */
	isChild: boolean;
}

/**
 * Read identity off an extension context.
 *
 * Total and non-throwing: a context without a session (RPC startup, tests, a
 * shutdown that has already torn the session down) yields an identity with no
 * ids rather than an exception. Identity is used on hot paths — every spawn,
 * every lifecycle write — and none of them should be able to fail on it.
 */
export function sessionIdentity(
	ctx: any,
	env: NodeJS.ProcessEnv = process.env,
): SessionIdentity {
	const sessionId = readString(() => ctx?.sessionManager?.getSessionId?.());
	const sessionFile = readString(() => ctx?.sessionManager?.getSessionFile?.());
	const header = readObject(() => ctx?.sessionManager?.getHeader?.());
	const parentSessionFile = typeof header?.parentSession === "string" && header.parentSession
		? header.parentSession
		: undefined;
	const parentSessionId = readString(() => env[PARENT_SESSION_ENV]);
	return {
		...(sessionId ? { sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		// Either half is sufficient: the header is authoritative for a session that
		// was seeded by us, and the env var covers a child whose header predates
		// this scheme.
		isChild: Boolean(parentSessionFile) || Boolean(parentSessionId),
	};
}

/**
 * The child session uuid recorded in a seeded session file.
 *
 * The parent writes the header itself (`context.ts`), so it already knows this
 * id at spawn — but a revive after a cold start has only the file. Reading the
 * first line back is cheap and keeps one definition of "the child's id".
 */
export function readSessionHeader(path: string): { id?: string; parentSession?: string } | undefined {
	let raw: string;
	try {
		// The header is the first line; reading the whole file would mean reading a
		// transcript that can be megabytes.
		raw = firstLine(path);
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || value.type !== "session") return undefined;
		return {
			...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
			...(typeof value.parentSession === "string" && value.parentSession
				? { parentSession: value.parentSession }
				: {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Read just the first line of a file.
 *
 * Deliberately synchronous and bounded: called from startup and from revive,
 * both of which are already doing filesystem work and neither of which wants to
 * pull a transcript that can be megabytes into memory to read its header.
 */
function firstLine(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(8192);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, read).toString("utf-8");
		const newline = text.indexOf("\n");
		return newline >= 0 ? text.slice(0, newline) : text;
	} finally {
		closeSync(fd);
	}
}

function readString(get: () => unknown): string | undefined {
	try {
		const value = get();
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function readObject(get: () => unknown): any {
	try {
		const value = get();
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

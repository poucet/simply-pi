/**
 * What a spawn says while it is happening.
 *
 * `spawn` does a surprising amount of synchronous work before the child process
 * exists: read the parent conversation, decide a context mode, possibly run a
 * full LLM summarization of the whole parent transcript (the slow one — up to
 * 8k output tokens), write a session file, write a system prompt, launch the
 * process and hand it its task. The tool receives an `onUpdate` callback and
 * used to ignore it, so all of that showed up as an inert "Working…" and read
 * as a hang.
 *
 * These are the steps, as text. Kept here rather than inline so the wording is
 * in one place, testable, and identical between the tool result and any other
 * caller: an `onUpdate` payload is a real `AgentToolResult`, so whatever this
 * says is what `renderResult` draws with `isPartial` set.
 */

export type SpawnStage =
	| "context"
	| "summarizing"
	| "summary-cached"
	| "seeding"
	| "starting"
	| "accepted";

export interface SpawnProgress {
	stage: SpawnStage;
	name: string;
	/** Parent messages involved, where the step depends on them. */
	messages?: number;
	/** Resolved context mode, once it is known. */
	mode?: string;
}

/** One line, present tense, naming the thing that is slow. */
export function describeSpawnStage(progress: SpawnProgress): string {
	const { stage, name, messages, mode } = progress;
	const count = typeof messages === "number" ? messages : undefined;
	switch (stage) {
		case "context":
			return `${name}: reading parent context`;
		case "summarizing":
			// The only genuinely slow step, and the one worth naming precisely: it is
			// a full LLM pass, and the human should know why the wait is happening.
			return count === undefined
				? `${name}: summarizing parent context`
				: `${name}: summarizing parent context (${count} message${count === 1 ? "" : "s"})`;
		case "summary-cached":
			return `${name}: reusing the parent context summary`;
		case "seeding":
			return mode
				? `${name}: seeding child session (${mode} context)`
				: `${name}: seeding child session`;
		case "starting":
			return `${name}: starting child process`;
		case "accepted":
			return `${name}: child accepted the task`;
	}
}

/** Callback shape the manager needs; a subset of pi's `AgentToolUpdateCallback`. */
export type SpawnProgressReporter = (progress: SpawnProgress) => void;

/**
 * Adapt pi's `onUpdate` into a reporter.
 *
 * Every announcement is a well-formed partial tool result so pi renders it
 * through the same `renderResult` path as the final one. Failures are swallowed:
 * progress reporting must never be able to fail a spawn.
 */
export function progressReporter(
	onUpdate: ((partial: any) => void) | undefined,
): SpawnProgressReporter {
	if (!onUpdate) return () => {};
	return (progress) => {
		try {
			onUpdate({
				content: [{ type: "text", text: describeSpawnStage(progress) }],
				details: { agent: progress.name, stage: progress.stage },
			});
		} catch {
			/* a spawn is not allowed to fail because the UI did */
		}
	};
}

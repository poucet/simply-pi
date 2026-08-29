/**
 * One summarization per conversation point, not one per spawn.
 *
 * `compacted` context costs a full LLM pass over the parent conversation at up
 * to 8k output tokens, synchronously, before the child process starts. Fanning
 * out three agents from the same point in the conversation used to pay for that
 * three times, in series, for three near-identical summaries — the parent
 * transcript is byte-for-byte the same for all of them; only the task differs.
 *
 * So the summary is cached against the parent's **leaf entry id**, which is
 * exactly "where the conversation currently is". The moment the parent says or
 * does anything else the leaf moves and the cache misses, which is the correct
 * invalidation: a stale summary is worse than a slow one.
 *
 * Two deliberate choices:
 *
 *   - **The task is not part of the key.** `summarizeForChild` does pass the
 *     task into the prompt, so a per-task summary would be marginally better
 *     tailored. It is not worth a second full-conversation LLM call: the bulk of
 *     the value is the parent's own history, which is identical, and the child
 *     is told its task verbatim in its system prompt regardless. This trade is
 *     the entire point of the cache and is why the first task wins.
 *   - **In memory only, single slot.** A summary is derived data about a live
 *     conversation; persisting it would mean invalidating it across restarts,
 *     forks and compactions for no benefit. Only the newest leaf is ever worth
 *     keeping, so one slot is the whole cache.
 *
 * In-flight calls are shared too: two spawns issued back to back (the common
 * fan-out shape) hit the same promise rather than racing to compute the same
 * thing twice.
 */

export interface SummaryCacheEntry {
	leafId: string;
	summary: Promise<string>;
}

export class SummaryCache {
	private entry?: SummaryCacheEntry;

	/** Whether a call with this leaf would be served without a summarization. */
	has(leafId: string | null | undefined): boolean {
		return typeof leafId === "string" && leafId.length > 0 && this.entry?.leafId === leafId;
	}

	/**
	 * Summarize once per leaf.
	 *
	 * A null/empty leaf id (a session with no entries yet, or a host that does not
	 * report one) is never cached: without an identity for the conversation point
	 * there is nothing to invalidate against, and serving a stale summary would be
	 * worse than the extra call.
	 */
	async get(leafId: string | null | undefined, compute: () => Promise<string>): Promise<string> {
		if (typeof leafId !== "string" || leafId.length === 0) return compute();
		if (this.entry?.leafId === leafId) return this.entry.summary;

		const summary = compute();
		this.entry = { leafId, summary };
		// A failed summarization must not be remembered: the next spawn should get
		// a real attempt rather than a cached rejection. Cleared only if this entry
		// is still the current one, so a newer leaf's result is never dropped.
		summary.catch(() => {
			if (this.entry?.summary === summary) this.entry = undefined;
		});
		return summary;
	}

	clear(): void {
		this.entry = undefined;
	}
}

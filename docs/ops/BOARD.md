# Board

Line-items only; what belongs here is stated once in SYSTEM.md §2. Live state
(what is running right now) lives in `docs/live/` — gitignored, invisible to
lanes; a lane gets its context from its brief, not from here.

Legend: 🚧 in flight · ✅ landed · ⏸ deferred.

## In flight

## Milestones

## Queued

| Status | Date | Pri | Label | What |
|---|---|---|---|---|
| 🚧 | 2026-08-29 | P1 | authority | design doc (PROPOSAL): per-role write authority for subagents — ROLE-WRITE-AUTHORITY.md awaits human review (workspace `.workspaces/authority`) |
| 🚧 | 2026-08-30 | P1 | epoch-research | research: can ../epoch (CoW checkpointed overlay FS) serve the subagents workflow — fencing or fast lane workspaces? |

## Deferred by decision

## Landed index

| Status | Date | Pri | Label | What |
|---|---|---|---|---|
| ✅ | 2026-08-30 | P1 | orchestrator | subagents ext: head/tail overlay files for the orchestrator prompt · nvoslonyvptt |
| ✅ | 2026-08-30 | P1 | protocol | subagents ext: built-in child protocol's cwd line is advice that yields to the task's brief (test-pinned) |
| ✅ | 2026-08-30 | P1 | frontmatter | subagents ext: persona `context:` frontmatter + `tools: "*"` allow-all · sxzvkuxyzyrv |

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
| 🚧 | 2026-08-30 | P2 | model-routing | cost-aware model routing: orchestrator guidance to spawn simple tasks on cheaper models; role files prespecify `model:` (mechanism exists — spawn param > persona > parent, manager.ts:751) |
| 🚧 | 2026-08-30 | P1 | orchestrator-single | replace the three-file head/tail overlay design with a single user `subagents-orchestrator.md` composed BEFORE the bundled mechanics (supersedes the overlay feature landed earlier today) |

## Deferred by decision

## Landed index

| Status | Date | Pri | Label | What |
|---|---|---|---|---|
| ✅ | 2026-08-30 | P1 | md-mentions | subagents ext: whole-line `@path` mention expansion (fail-silent includes) for persona bodies + the user orchestrator file · snztvzrnutrr |
| ✅ | 2026-08-30 | P1 | orchestrator-single | subagents ext: orchestrator prompt — one user file (`~/.pi/agent/orchestrator.md`) prepended to the bundled guidance; head/tail overlays and the old wholesale name deleted · xytxyolt |
| ✅ | 2026-08-30 | P1 | epoch-research | research (docs/research/epoch/EPOCH.md): epoch not viable as the fence or as workspace replacement today — rename(2) broken + symlink ENOSYS in macOS mounts block jj-in-mount; real value: 0.25 s mounts, containment-by-construction, `.vfs/debug/overlay` write-audit for scratch lanes |
| ✅ | 2026-08-30 | P1 | orchestrator | subagents ext: head/tail overlay files for the orchestrator prompt · nvoslonyvptt |
| ✅ | 2026-08-30 | P1 | protocol | subagents ext: built-in child protocol's cwd line is advice that yields to the task's brief (test-pinned) |
| ✅ | 2026-08-30 | P1 | model-routing | subagents ext: orchestrator.md teaches matching child models to work weight (README + test-pinned) · kupxnwosrqrz |
| ✅ | 2026-08-30 | P1 | frontmatter | subagents ext: persona `context:` frontmatter + `tools: "*"` allow-all · sxzvkuxyzyrv |

# Changelog

What got added, per landing — dated with a clock and the jj change id. The entry
format is stated once in SYSTEM.md §2.

## Unreleased

#### Orchestrator prompt: one user file, prepended · 2026-08-30 00:53 · xytxyolt

The three-file overlay design (wholesale + `-head.md` + `-tail.md`) is gone;
the head name was procedural, it was long, and it leaked the `orchestrator.md`
naming detail. One file now: `~/.pi/agent/orchestrator.md`, whose
non-empty content is **prepended** to the bundled `orchestrator.md`
(blank-line joined). Deliberate behavior change: a user file no longer replaces
the bundled prompt — identity first, mechanics always after, so the bundled
stall/reaping/anti-double-work guidance stays current with the code without
the user copying it. No back-compat kept: the superseded design is hours old
and has one user.

#### epoch research: fencing and fast spin-up verdicts · 2026-08-30 · rmluqlnnksxl

`docs/research/epoch/EPOCH.md` measures `../epoch` (CoW checkpointed overlay
FS) against the two candidate uses and answers no-for-now on both, with the
evidence: rename(2) arrives at epoch with empty names under the installed
macFUSE 5.3.1 (so `jj` and editors' atomic saves fail inside any mount),
symlink/readlink is ENOSYS (which alone breaks this repo's `SYSTEM.md` and
`.pi/agents`), there is no read-deny mechanism and no export/landing tooling,
and concurrent mounts cannot share a state store (`DatabaseAlreadyOpen`).
What is real and worth keeping: 0.25 s mounts independent of tree size,
containment-by-construction (a wrong write provably never touches the tree),
and a complete write-audit record via `.vfs/debug/overlay` — a good fit for
consequence-free scratch lanes once the two POSIX gaps are fixed upstream.

#### Orchestrator prompt head/tail overlays · 2026-08-30 00:08 · nvoslonyvptt

`~/.pi/agent/subagents-orchestrator-head.md` and `-tail.md` now compose
(blank-line-joined) around whichever base is in effect — a non-empty wholesale
`subagents-orchestrator.md` copy as before, else the bundled `orchestrator.md` —
so a role/identity overlay no longer has to duplicate the guidance it wraps.
Absent or whitespace-only files contribute nothing; existing setups behave
identically.

#### The built-in child protocol presents the cwd as advice, not a prohibition · 2026-08-30 00:06 · muzwxpnq

`buildSystemPrompt`'s cwd line no longer says "Stay inside it" — it says to stay
inside your own tree *unless the task explicitly sends you elsewhere*, because
scribe/integrator lanes share the default workspace and designer lanes write
evidence to absolute paths. A test now pins the sentence (manager.test.ts).
Code change: yooutwkn.

#### Personas: `context:` frontmatter and `tools: "*"` allow-all · 2026-08-30 00:08 · sxzvkuxyzyrv

Persona frontmatter accepts an optional `context:` (`fresh | forked | compacted | auto`),
used when a spawn omits its own `context` (spawn param > persona > `auto`); unknown
values are ignored, never fatal. In `tools:`, a `"*"` anywhere in the list now
means inherit-everything instead of a literal (previously toolless) allowlist
entry; names listed alongside a `"*"` are ignored.

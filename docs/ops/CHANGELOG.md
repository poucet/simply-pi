# Changelog

What got added, per landing — dated with a clock and the jj change id. The entry
format is stated once in SYSTEM.md §2.

## Unreleased

#### `@path` mention expansion for markdown prompts · 2026-08-30 00:58 · snztvzrnutrr

Persona bodies and the user orchestrator file (`~/.pi/agent/orchestrator.md`)
now expand whole-line `@path` mentions — a line that is only `@path` — into the
target file's content. Relative paths resolve against the mentioning file's
directory, `~/` to home, symlinks follow; includes nest with per-prompt dedup
(each file contributes once, which also terminates cycles) and a depth cap of
five. The load-bearing semantic is **fail-silent includes**: a mention of an
absent file contributes nothing (one stderr note per path per process), so a
shared generic template can reference optional per-repo hooks (`@.pi/PROJECT.md`)
that fire where they exist and contribute nothing where they don't — prompt
assembly by composition instead of copying. Exists-but-unreadable targets are
reported on every expansion. The bundled orchestrator.md and the generated child
protocol are deliberately not expanded. New mentions.ts; 20 new tests
(gate 624 pass).

#### Orchestrator guidance for matching models to the work · 2026-08-30 00:57 · kupxnwosrqrz

The bundled `orchestrator.md` — injected into every orchestrating parent — now
has a "Matching the model to the work" section: `spawn`'s `model` param beats a
persona's frontmatter `model:`, which beats the parent's model; cheap/fast for
lookups, sweeps and plumbing, strongest for architecture and contract
decisions, and persona presets are overridable floors. README documents the
precedence chain (Personas) and points at the guidance (Orchestrator mode);
one test pins the section heading. No code changes — the mechanism
(`manager.ts` precedence) already existed; this lane shipped the missing
judgment.

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

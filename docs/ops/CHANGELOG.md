# Changelog

What got added, per landing — dated with a clock and the jj change id. The entry
format is stated once in SYSTEM.md §2.

## Unreleased

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
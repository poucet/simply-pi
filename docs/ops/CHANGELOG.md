# Changelog

What got added, per landing — dated with a clock and the jj change id. The entry
format is stated once in SYSTEM.md §2.

## Unreleased

#### Personas: `context:` frontmatter and `tools: "*"` allow-all · 2026-08-30 00:08 · sxzvkuxyzyrv

Persona frontmatter accepts an optional `context:` (`fresh | forked | compacted | auto`),
used when a spawn omits its own `context` (spawn param > persona > `auto`); unknown
values are ignored, never fatal. In `tools:`, a `"*"` anywhere in the list now
means inherit-everything instead of a literal (previously toolless) allowlist
entry; names listed alongside a `"*"` are ignored.

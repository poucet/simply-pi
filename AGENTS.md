This is a jj repository with a set of extensions for pi.dev (the coding harness you're running in).

## The system

Work here runs per **@SYSTEM.md** (a symlink to `~/projects/simply/dev/AGENTS.md`).
Read it before doing anything non-trivial: the roles, the doc web, the lane
lifecycle, the landing rules. Its eight role definitions are available as
subagent personas — `coder`, `researcher`, `tech-lead`, `designer`, `foreman`,
`integrator`, `scribe`, `co-developer` — via the `subagent` tool's `persona`
parameter. The persona files are **not** in this repo: they live at
`~/projects/simply/dev/agents` and are wired in at the user level
(`~/.pi/agent/agents` is a symlink to that directory), with the default
`co-developer` role set in `~/.pi/agent/AGENTS.md`.

### Recreating the links (fresh clone)

The links are machine-specific absolute symlinks and are gitignored; this file
is their record.

    # in this repo
    ln -sfn ~/projects/simply/dev/AGENTS.md SYSTEM.md

    # user-level (once per machine, not per clone)
    ln -sfn ~/projects/simply/dev/agents ~/.pi/agent/agents

## What is true of this project alone

- **No build step.** TypeScript, executed directly by pi. The gate is the test
  suite: `node extensions/subagents/tests/run.mjs` (a single file: append its
  path). Gates run unfiltered, verbatim in the report.
- The human channel is `docs/live/` (gitignored); live state is
  `docs/live/` (gitignored) — see SYSTEM.md §2 for the split.

## How this repo is wired into pi

pi auto-discovers global extensions at `~/.pi/agent/extensions/*.ts` and
`~/.pi/agent/extensions/<dir>/index.ts`. A subdirectory contributes **exactly one**
entry point — its `index.ts` — and nothing else inside it is loaded.

This repo is therefore mounted with a single symlink:

```
~/.pi/agent/extensions/                 <- a real directory
  simply-pi -> <this repo>/extensions   <- the one symlink
  *.ts                                  <- personal, machine-specific extensions
```

Two consequences worth knowing before you change anything:

- **`extensions/index.ts` is the repo's only entry point.** It is an aggregator that
  imports each top-level extension and installs it. When you add a new top-level
  extension to this repo, you must add it to the list in `extensions/index.ts` —
  otherwise pi never loads it, silently. Files inside `extensions/` that are not
  reachable from that aggregator are dead code as far as pi is concerned.
- **Personal, machine-specific config does not belong in this repo.** Because the
  real `~/.pi/agent/extensions` directory is no longer the repo itself, loose `.ts`
  files can live there alongside the `simply-pi` symlink and be picked up by
  discovery without being tracked here. Provider credentials, employer-specific
  model routing and personal branding go there, not in version control.

Each sub-extension is installed independently by the aggregator: one that throws is
reported to the console and skipped rather than taking the rest of the repo's
extensions down with it.

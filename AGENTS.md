This is a jj repository with a set of extensions for pi.dev (the coding harness you're running in).

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

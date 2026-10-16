# MCP status badges for pi

A **read-only status overlay** for pi's built-in MCP support. It connects to
nothing, registers no tools and no commands — the builtin owns all of that,
including `/mcp` — and only answers one question durably: *what are my MCP
servers doing right now?*

The builtin shows its status only inside `/mcp`, visible when you ask. But
connecting to a remote server takes seconds, servers fail quietly, and a
disabled server changes what the model can see — none of which should need
asking about. This extension publishes a row of badges:

```
░ mcp ░ 2/2 ░ 91 tools ░
```

to the shared border-badges registry (`extensions/shared/border-badges.ts`),
where the extension that owns the input editor — `extensions/subagents` here —
draws them into its top border. When nothing is drawing that bar, the same
facts go to the footer status line instead: badges in a terminal, a sentence
(`mcp: 2/2 servers, 91 tools`) everywhere that cannot show colour.

## History

This directory used to be a full MCP client: transports, OAuth 2.1, tool
registration, the `/mcp` command. pi has since grown all of that as a builtin
(`createMcpExtension` in pi's dist), which reads the same `mcp.json`, owns
`/mcp`, and registers tools as `mcp__<server>__<tool>`. Everything operational
was deleted rather than left to fight the builtin over the command name and the
tool names; the badges — the one thing the builtin does not do — are what
remain.

## What is observable, and what is not

The builtin exposes **no API for its connection state**: no event for a failed
connect, nothing to ask about OAuth. `observe.ts` derives everything from what
an extension *can* see:

| Source | What it tells us |
|---|---|
| `<agentDir>/mcp.json`, `<cwd>/.pi/mcp.json` | the configured servers, and which are `enabled: false` (project entries replace global ones by name, as the builtin merges them) |
| `pi.getMcpServers()` | servers other extensions registered (config wins on a name collision, matched on namespace — the builtin's precedence) |
| `pi.getAllTools()` | each MCP tool carries `namespace.name === "mcp__<server with - as _>"`; a tool the server dropped is re-registered with `exposure: "hidden"` and is not counted |

Any `mcp__*` namespace seen in the tools that matches no known server also
counts, as enabled — the builtin is demonstrably running it, whatever this
observer failed to find in config (an untrusted project file, say).

The phase mapping is the honest subset:

- `enabled: false` → **disabled** (the `·1` riding on the ratio chip)
- enabled, ≥ 1 visible tool → **ready**
- enabled, no tools yet → **connecting**

A server that *failed*, or is waiting for a login, also has no tools — so it
shows as "connecting". That is the limit of what is observable; a badge that
said "failed" on this evidence would be guessing. The "error" and "needs auth"
phases survive in `status.ts` (pure, tested) so the renderings are ready the
day pi exposes those facts.

## Repaint triggers

- `session_start` — initial paint; every enabled server reads "connecting",
  which is exactly right before the builtin's connects settle.
- `mcp_servers_change` — an extension registered or unregistered a server.
- a ~2 s poll (`PI_MCP_BADGE_POLL_MS` to override) — pi fires no event when the
  builtin's tools register, so polling is the only way to watch the counts
  climb. `publish()` skips unchanged badge lists and the footer write is
  idempotent, so an unchanged poll costs nothing and notifies nobody.

## The rendering

What the line *says* is decided by the pure `statusBadges`/`formatStatus` in
`status.ts` (headlessly tested in `tests/status.test.ts`); what each state
*means* is derived by the pure `observe.ts` (`tests/observe.test.ts`);
`index.ts` owns only the tone → theme-token mapping and the painting
(`tests/wiring.test.ts`).

The chips, when everything is up, when something is off, and at startup:

```
░ mcp ░ connecting 2… ░          before the builtin's connects settle
░ mcp ░ 2/2 ░ 91 tools ░         everything is up
░ mcp ░ 2/2·1 ░ 91 tools ░       one server disabled in config
░ mcp ░ 2 off ░                  everything disabled
```

Decisions that look arbitrary but are not:

- **The disabled count rides on the ratio** (`2/2·1`, never `2/3`): the ratio
  means "of the servers that should be up, how many are", so a deliberate
  disable must not look like a failure, and a chip is too expensive a unit to
  spend on one digit.
- **One tone per chip**: a chip is painted as a single run; multi-run chips
  would disturb the exact-width arithmetic the border bar depends on.
- **Padding is a single space per side**: pi's footer collapses runs of literal
  spaces, so a two-space pad would come back as one. The space *between* chips
  survives only because escape sequences sit either side of it.
- **Fallbacks are all-or-nothing**: a client that is not a terminal
  (`ctx.mode !== "tui"`), a theme that paints nothing, or a theme missing a
  token all get the full sentence rather than a half-painted badge line, which
  would still look authoritative while having dropped exactly the facts that
  mattered.
- **Painting never throws**: it runs on a timer and in lifecycle events, and a
  status line is not worth an extension error.

### Bar or footer, never both

The badges are published to the registry **unconditionally** — they are data,
not paint — but the footer copy is written only when `hasRenderer()` says
nothing is drawing the bar:

```ts
ctx.ui.setStatus("mcp", hasRenderer() ? undefined : renderStatus(ctx, states));
```

That branch is why `hasRenderer()` exists: only the extension holding
`setEditorComponent` can draw in the border, and it may be disabled or not
installed — those users keep the footer line instead of silently losing their
MCP indicator. Load order is arbitrary, so the footer entry is often written
*before* the editor mounts its bar; a subscription to the registry repaints on
the presence transition and takes the duplicate back down (and restores it if
the bar goes away on a reload).

Tone → theme tokens are recommended once in the registry
(`RECOMMENDED_TOKENS`) and copied as `BADGE_STYLE` in `index.ts`, because the
registry cannot name pi's token unions without importing pi. A test asserts the
two are identical, so a badge cannot be green in the footer and grey in the
border.

With no MCP servers configured the footer entry is cleared and nothing is
published, so a user without MCP sees nothing anywhere.

## Install

The repo's aggregator (`extensions/index.ts`) installs this under the name
`mcp`; nothing to configure. Servers are configured for the **builtin**, in
`~/.pi/agent/mcp.json` or `<project>/.pi/mcp.json` — see pi's own docs.

## Tests

```
node extensions/mcp/tests/run.mjs
```

`status.test.ts` and `observe.test.ts` are pure; `wiring.test.ts` drives the
real extension against a stub pi whose `getAllTools()` the tests mutate to play
the builtin registering tools; `border-badges.test.ts` covers the shared
registry (it lives here because this is the suite wired to a runner).

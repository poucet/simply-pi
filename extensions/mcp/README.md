# MCP extension for pi

Connects pi to **remote MCP servers** (and, if you need them, local stdio ones) and
exposes their tools to the model as normal pi tools named `mcp__<server>__<tool>`.

No npm dependencies — the MCP client, Streamable HTTP / legacy HTTP+SSE transports
(`client.ts`) and the OAuth 2.1 flow (`oauth.ts`) are implemented here.

## Install

Point pi at the directory (it exports `index.ts`):

```json
// ~/.pi/agent/settings.json
{ "extensions": ["/path/to/simply-pi/extensions/mcp"] }
```

Or drop/symlink it into `~/.pi/agent/extensions/mcp` or `.pi/extensions/mcp`.

## Configure servers

Config files, merged in increasing precedence:

| File | Scope |
|------|-------|
| `~/.pi/agent/mcp.json` | global |
| `<cwd>/.mcp.json` | project (shared convention) |
| `<cwd>/.pi/mcp.json` | project (pi specific) |
| `$PI_MCP_CONFIG` | colon-separated extra files |

```json
{
  "mcpServers": {
    "linear":  { "url": "https://mcp.linear.app/mcp", "bearerToken": "${LINEAR_TOKEN}" },
    "docs":    "https://example.com/mcp",
    "internal": {
      "url": "https://tools.corp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${CORP_TOKEN}", "X-Team": "platform" },
      "includeTools": ["search", "create_ticket"],
      "timeoutMs": 60000
    },
    "legacy":  { "url": "https://old.example.com/sse", "type": "sse" },
    "fs":      { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

`${VAR}`, `${VAR:-default}` and `$VAR` are expanded from the environment anywhere in a
server entry, so tokens stay out of the config file.

### Server options

| Key | Meaning |
|-----|---------|
| `url` | Remote endpoint (primary path). A bare string value is shorthand for this. |
| `bearerToken` / `apiKey` | Static token → `Authorization: Bearer …`. |
| `bearerTokenCommand` | Shell command whose stdout is the token (vault / CLI-issued keys). |
| `headers` | Extra HTTP headers (tenant routing, …). |
| `auth` | `auto` (default: OAuth on 401), `oauth`, or `none`. |
| `clientId` / `clientSecret` / `scope` | For servers without dynamic client registration. |
| `type` / `transport` | `http` (Streamable HTTP), `sse` (legacy), `stdio`. Default: auto-detect. |
| `maxRetries` | Retries for connection-level failures. Default `2`. |
| `command`, `args`, `env`, `cwd` | Local stdio server instead of `url`. |
| `includeTools` / `excludeTools` | Allow/deny list of MCP tool names. |
| `toolPrefix` | Override the `mcp__<server>__` pi tool prefix. |
| `timeoutMs`, `connectTimeoutMs` | Per-call and connect timeouts. |
| `disabled` | Keep the entry but do not connect (config-level off switch). |

Environment overrides: `PI_MCP_TIMEOUT_MS`, `PI_MCP_CONNECT_TIMEOUT_MS`, `PI_MCP_MAX_TEXT`.

## Remote behaviour

- **Streamable HTTP** (`2025-06-18`) with `Mcp-Session-Id` tracking and `DELETE` on shutdown.
- **Automatic fallback** to the legacy HTTP+SSE transport (`GET /sse` → `endpoint` event →
  `POST` messages) when a server rejects Streamable HTTP.
- **Session recovery**: a `404` on an established session triggers a re-handshake and the
  request is replayed once, so idle timeouts and server redeploys don't break a tool call.
- **Retries with backoff** for connection-level failures (not for protocol errors).
- **Server-push stream**: an optional `GET` SSE stream picks up notifications such as
  `notifications/tools/list_changed`, which re-lists tools live.
- **Progress notifications** stream into the pi tool result while a call runs.
- `401`/`403` responses are reported with a hint to check the token/headers.

## Authentication

Remote MCP servers mostly use OAuth 2.1, which this extension speaks natively — no
tokens to copy around:

- **Discovery** — RFC 9728 protected-resource metadata (from the `WWW-Authenticate`
  challenge, with `.well-known` fallbacks) → RFC 8414 / OIDC authorization-server metadata
  → spec-default endpoints.
- **Dynamic client registration** (RFC 7591) when the server supports it, otherwise set
  `clientId`/`clientSecret`.
- **Authorization code + PKCE (S256)** through a loopback redirect on `127.0.0.1`, with
  `state` validation and the RFC 8707 `resource` parameter.
- **Refresh** happens automatically, including a transparent retry when a server returns
  401 mid-session with a stale token.
- Tokens are stored in `~/.pi/agent/mcp-auth.json` (chmod 600), keyed by canonical resource.

Startup never opens a browser: a server that needs authorization is reported as
`needs auth`, and you run the flow when you want it.

```
/mcp login notion    # opens the browser, completes the flow, reconnects
/mcp logout notion   # forgets stored tokens
```

Set `PI_MCP_NO_BROWSER=1` on headless/SSH boxes — pi prints the URL instead of opening it.
For servers that use static credentials, `bearerToken`, `bearerTokenCommand` or plain
`headers` still work, and OAuth stays out of the way (`auth: "none"` to be explicit).

## Commands

```
/mcp                     server status, auth state, tool counts, config files, errors
/mcp enable <server>     turn a server on: connect and expose its tools
/mcp disable <server>    turn a server off: disconnect and hide its tools
/mcp toggle [server]     flip a server; with no argument, pick from a list
/mcp login <server>      OAuth login (browser) then reconnect
/mcp logout <server>     clear stored tokens
/mcp tools [server]      list registered tools
/mcp resources <server>  list resources exposed by a server
/mcp log <server>        recent transport diagnostics / stderr
/mcp reconnect [server]  re-read config and reconnect
```

Tab completes subcommands and server names: `/mcp en<tab>` → `/mcp enable `, then `<tab>`
lists every server annotated with its status and tool count, with the likely candidates
first (off servers for `enable`, running ones for `disable`, servers awaiting login for
`login`, and so on).

### The footer line

A persistent status entry says what the servers are doing without being asked, and updates
as they connect, fail, or are toggled. In a terminal it is a row of coloured badges, each
fact its own chip:

```
░ mcp ░ connecting 2… ░                       during startup — remote servers take seconds
░ mcp ░ 2/2 ░ 91 tools ░                       everything is up
░ mcp ░ 1/2 ░ 10 tools ░ 1 connecting ░        one is up, one still dialling
░ mcp ░ 1/2 ░ 10 tools ░ 1 failed ░            a failure is named, never just a smaller number
░ mcp ░ 2/2·1 ░ 91 tools ░                     one server switched off with /mcp disable
░ mcp ░ 3/4·1 ░ 27 tools ░ 1 needs login ░
░ mcp ░ 2 off ░                                everything switched off with /mcp disable
```

The colours carry the state, so the line can be read at a glance rather than parsed:

| Chip | Colour | Meaning |
|------|--------|---------|
| `mcp` | accent on `selectedBg`, bold | the label, so the row is identifiable among other extensions' statuses |
| `2/2` | green on `toolSuccessBg` | every server that is switched on is up |
| `1/2` | accent on `toolPendingBg` | something is still dialling |
| `0/2` | red on `toolErrorBg` | something failed |
| `1/2` | yellow on `toolErrorBg` | something needs a login |
| `2/2·1` | as the ratio above | …and one server is switched off (see below) |
| `91 tools` | default text on `userMessageBg` | the payload — what the model can actually see |
| `1 failed` | red on `toolErrorBg` | |
| `1 needs login` | yellow on `toolErrorBg` | a warning, not an error: nothing is broken and the fix is one command |
| `2 off` | muted on `userMessageBg` | only when there is no ratio to fold the count into |

The ratio chip repeats whatever the worst trailing chip says, because the ratio is where a
glance lands and it has to carry the bad news by itself. The word "servers" is dropped and
"connecting to 2 servers…" shortens to "connecting 2…": this line is shared with every
other extension's status, so columns are scarce.

**The switched-off count rides on the ratio** — `2/2·1`, not a chip of its own — for the
same reason. A chip costs its padding, its separator and a background the eye has to land
on, all to carry one digit that changes only when *you* change it. It is omitted entirely
at zero, so an install with nothing disabled still reads exactly `2/2`.

Two things about that notation are load-bearing:

- **The disabled server stays out of the ratio.** It is `2/2·1`, never `2/3`. The ratio
  means "of the servers that should be up, how many are", which is what makes anything
  below `N/N` a reliable at-a-glance "something is wrong"; moving a deliberate
  `/mcp disable` into the denominator would make your own choice look like a failure. Its
  stale tool count stays out of the tool total on the same grounds — the model cannot see
  those tools.
- **The whole chip takes one tone**, the one the ratio would have had alone. A chip is
  painted as a single run, so there is no way to mute just the `·1` without multi-run
  chips, and those would disturb the exact-width arithmetic the border bar depends on.
  `3/4·1` with a failure is red throughout, and that is the right emphasis anyway.

The two states with no ratio to fold into — startup (`connecting 2…`) and everything
switched off — keep the worded `N off` chip in `muted`, because losing a fact to a layout
detail is worse than spending a chip on it.

Badges are only used where they mean something. Everywhere else the same facts are written
as a sentence — `mcp: 2/2 servers, 91 tools, 1 off` — and that is what you get when:

- **the client is not a terminal.** RPC mode also has `hasUI: true`, but a client there
  renders the status itself and escape sequences are only something for it to strip, so
  the switch is on `ctx.mode === "tui"` rather than on `hasUI`.
- **the theme paints nothing.** Badges lean on their backgrounds to be separable; without
  colour `mcp 2/2 91 tools` is a run of numbers, which is worse than the prose it replaced.
- **the theme is missing a colour token.** pi's `fg`/`bg` throw on a token they do not
  know. The fallback is all-or-nothing: a half-painted line still looks authoritative while
  having dropped exactly the facts you needed.

The sentence keeps `1 off` in words rather than borrowing the badges' `2/2·1`. The
notation is something you look at, not something you read, and prose is exactly what these
places have instead of chips.

With no MCP servers configured the entry is cleared entirely, so a user without MCP sees
nothing. `--print` and JSON modes have no status line at all and are never written to.

What the line *says* is decided by the pure `statusBadges`/`formatStatus` in `status.ts`,
which has no pi imports so every state is testable headlessly (`tests/status.test.ts`);
`index.ts` owns only the tone → theme-token mapping and the rendering
(`tests/wiring.test.ts`).

Two constraints worth knowing before changing the rendering:

- **Padding is a single space per side.** pi's footer collapses runs of two or more literal
  spaces, so a two-space pad would come back as one and the badges would end up unevenly
  sized. The space *between* badges survives only because escape sequences sit either side
  of it.
- **Painting can never fail loudly.** The footer is cosmetic but `updateStatus` is called
  from the middle of connect, refresh and shutdown; a throw there could skip the
  `client.close()` that reaps an MCP server's child process. Every paint is guarded and
  degrades to a stale line instead.

One known seam: pi has no theme-change event for extensions and the footer keeps the string
it was given, so switching themes without touching a server leaves the old colours until
the next server event repaints.

### The badge bar in the editor border

The same badges are also published to `extensions/shared/border-badges.ts`, a small registry
that lets the extension owning the input editor draw everyone's badges into its top
border — a less crowded place than the status line.

It has to be a registry because `ctx.ui.setEditorComponent()` is a single slot: the last
extension to call it wins, silently, and `extensions/subagents` already claims it. So the
extension that owns the editor renders the bar, and everyone else publishes:

```ts
import { publish } from "../shared/border-badges.ts";

publish("mcp", statusBadges(states));  // undefined withdraws this source entirely
```

The store lives on `globalThis` under `Symbol.for("pi.border-badges")` rather than in module
scope, which is load-bearing rather than defensive: extensions are loaded through jiti and
are not guaranteed the same module instance, so a module-scoped singleton would hand each
side its own empty registry and the bar would sit blank with nothing reporting an error.
Groups are ordered by source name so the bar cannot reshuffle as servers report in.

The bar is rendered by `extensions/subagents` (`badge-bar.ts` + `editor.ts`), which lays the
chips into the right-hand end of the rule above the input box. pi's own scroll indicator is
anchored to the *left* of that same rule, so the two share the line rather than one
suppressing the other; when a border is too narrow to hold both, the indicator keeps it.

**Only one of the two is ever on screen.** The badges are published unconditionally — they
are data, not paint — but the footer copy is written only when `hasRenderer()` says nothing
is drawing the bar:

```ts
ctx.ui.setStatus("mcp", hasRenderer() ? undefined : renderStatus(ctx, states));
```

That branch is the whole reason `hasRenderer()` exists. Only the extension holding
`setEditorComponent` can draw in the border, and it may be disabled or simply not installed;
deleting this `setStatus` outright would have meant those users lose their MCP indicator
entirely, with nothing anywhere to explain why. So `renderStatus`/`renderBadges`/`BADGE_STYLE`
stay — they are the fallback, not dead code.

Extension load order is arbitrary, so mcp routinely paints its footer entry *before* the
editor has mounted one. `updateStatus` therefore also subscribes to the registry and repaints
on the presence transition, which takes the duplicate back down a moment later (and puts it
back if the bar goes away on a reload). It filters on the transition rather than on every
notification, so its own publishes do not cause pointless repaints.

Tone → theme tokens are recommended once, in the registry (`RECOMMENDED_TOKENS`), and
`index.ts` keeps a typed copy in `BADGE_STYLE` because the registry cannot name pi's token
unions without importing pi. A test asserts the two are identical, so a badge cannot end up
green in the footer and grey in the border.

### Toggling servers

`/mcp disable <server>` closes the connection and removes that server's tools from the
active tool set, so they disappear from the model's prompt without touching any other
tool. `/mcp enable <server>` reconnects and re-activates them.

The on/off choice is remembered in `~/.pi/agent/mcp-state.json` (global, all projects), so
a server stays off across sessions until you enable it again. Config files are never
rewritten — a server marked `"disabled": true` in `mcp.json` stays off and can only be
re-enabled by editing that file.

## Tests

```
node extensions/mcp/tests/run.mjs
```

`tests/status.test.ts` covers the footer content — both renderings — which is pure and
therefore testable without a terminal or a live server. `tests/wiring.test.ts` covers the
rest against the real extension and real stdio servers: whether the line is ever written,
the badge rendering, the fallbacks above, and that the badge line survives pi's footer
sanitising unchanged.

Every test must shut its harness down. A stdio server is a real child process, and one left
running keeps node's event loop alive, so the suite prints all its results and then hangs
instead of exiting. If a run does not come back, look for an orphan with
`pgrep -fl fake-server`.

## Notes

- Tool errors from MCP (`isError: true`) are thrown so pi marks the tool call failed.
- Text/image/embedded-resource content blocks are converted; text is truncated at
  `PI_MCP_MAX_TEXT` (default 60k chars).
- Sampling/roots/elicitation requests from servers are answered with "method not supported".

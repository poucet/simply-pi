# mcp-badges — 2026-10-02 19:09 · yznrqpnpnmpt

For you: the MCP badge row (border bar, or footer fallback) keeps working now
that pi's **built-in** MCP support owns connections, OAuth, `/mcp` and tool
registration — and this repo's extension no longer fights it for any of that.
The old in-repo MCP client (transports, OAuth 2.1, `/mcp` command, tool
registration, the `mcp-state.json` disabled-servers file) is deleted; what
remains is a read-only observer that derives server state from `mcp.json` +
`pi.getMcpServers()` + the `mcp__*` tool namespaces in `pi.getAllTools()`, and
publishes badges exactly as before.

One honest regression in vocabulary: pi exposes no failure/auth state to
extensions, so a failed or login-blocked server now shows as "connecting"
rather than "1 failed" / "needs login". The phases stay in the pure renderer
for the day pi exposes those facts.

Cost: ~1 session. Net −2,900 lines (client/oauth/config/scope tests deleted),
+150 lines `observe.ts` + tests. Gate: mcp suite 93/93; subagents suite
629/631 — the 2 failures pre-exist on clean main (verified in a scratch
workspace at `uoloonwu`), filed as an issue (badge-bar scroll-indicator regex
vs pi 1.0.0's new centered indicator).

# Changelog

What got added, per landing — dated with a clock and the jj change id. The entry
format is stated once in AGENTS.md §2. Lanes write `changelog.d/<LANE>.md`
(untracked, in the default workspace); it is folded in here on landing.

## Unreleased

#### Packages can ship personas, and a repo keeps its own agent tree · 2026-11-12 06:40 · yukwyuvr
- A pi package can now ship subagent personas: list their directories under `pi.personas` in its `package.json`. Your own `~/.pi/agent/agents` wins over a package's persona of the same name, and a trusted project's `.pi/agents` over both.
- The agent tree (registry, shared notes, children's transcripts) now lives in the repo, under `<repo>/.pi/subagents`, instead of `~/.pi/agent/subagents`, so it moves with the repo. `.pi/` gets a `.gitignore` of `*` if it has none. Outside a repository nothing changes.

#### The doc panel switches on `ctrl+]`, and follows your clicks in fullscreen · 2026-11-11 18:05 · onkszytq
- The doc panel's key is now `ctrl+]` (hidden → shown → focused → hidden), replacing `ctrl+shift+d`, which is pi's debug dump again. `ctrl+]` was the editor's "jump forward to character" key; while this extension is loaded the panel takes it.
- In fullscreen, clicking the panel gives it the keyboard, and clicking a tab's name in its top border also switches to that tab. Clicking anywhere in the chat while the panel has the keyboard hands it back to the input box, as Esc does; the panel stays shown. Dragging still selects text, and the wheel still scrolls the panel without taking the keyboard.
- The regular (non-fullscreen) screen is unchanged: no mouse reporting, so the terminal's own selection keeps working.

#### Badges stay in the input box's border when the input scrolls · 2026-11-11 08:06 · tqowyrrp

When your input grew taller than the box, the badges in its top border disappeared. They now stay put beside pi's centred "↑ N more" indicator. If there is no room for them beside it, the badges are dropped and the indicator stays.

#### The doc panel sits beside the chat, not on it · 2026-11-11 08:04 · zywxunks
- While the doc panel is shown, the chat (transcript, input box, footer) moves into the columns left of it, so nothing is covered any more. Hiding the panel (`alt+h`) or closing it gives the chat its full width back. Works in both fullscreen and the regular screen, and follows terminal resizes.
- The panel takes half the terminal, at least 40 columns while that leaves the chat 30.
- If the chat can't be narrowed, the panel falls back to covering the right half as before; typing is never affected.

#### ↓ no longer empties the input box · 2026-11-11 07:59 · opyvtzzr
- Reading a recalled prompt with ↓ and pressing it once too many no longer wipes the box: on the last line ↓ now just moves the cursor to the end of the line. Stepping between history entries, and back to text you had typed before browsing, works as before.
- Clearing the box stays on ctrl+c (pi's clear key).

#### Docs for you open beside the chat · 2026-11-10 12:18 · osmulvrr
- An agent that writes a doc for you (instructions, a checklist, a plan to answer) can now show it with `show_doc`: rendered as markdown in a panel covering the right half of the terminal, full height. The panel reloads whenever the file changes. If the agent calls `show_doc` again, the new doc replaces the old one.
- `/doc <path>` opens any markdown file yourself, `/doc` reopens the last one, `/doc close` closes it.
- The panel never takes your typing. `alt+h` hides it so you can read the chat under it, and shows it again. `alt+l` focuses it for scrolling (↑↓ j/k, PgUp/PgDn, g/G). `Esc` hands the keyboard back. While it is hidden, a `doc` badge in the editor border reminds you.

#### Subagents can call the MCP servers you give them · 2026-11-09 22:09 · opzkrylynwrq
- A subagent spawned with `mcp_servers` now boots exactly those servers and can call their tools through `codemode` (`tools.mcp__linear__list_teams({})`). Before, it had neither the servers nor `codemode`, whatever it was given.
- Subagents also inherit pi's other built-in extensions (`codemode`, `tool_search`, the llama.cpp provider), unless your `extensions` setting or `childDeny` turns one off.
- Unchanged: a subagent with no `mcp_servers` still boots no servers; `["*"]` boots them all.

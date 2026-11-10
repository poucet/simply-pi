# Changelog

What got added, per landing — dated with a clock and the jj change id. The entry
format is stated once in AGENTS.md §2. Lanes write `changelog.d/<LANE>.md`
(untracked, in the default workspace); it is folded in here on landing.

## Unreleased

#### Docs for you open beside the chat · 2026-11-10 12:18 · osmulvrr
- An agent that writes a doc for you (instructions, a checklist, a plan to answer) can now show it with `show_doc`: rendered as markdown in a panel covering the right half of the terminal, full height. The panel reloads whenever the file changes. If the agent calls `show_doc` again, the new doc replaces the old one.
- `/doc <path>` opens any markdown file yourself, `/doc` reopens the last one, `/doc close` closes it.
- The panel never takes your typing. `alt+h` hides it so you can read the chat under it, and shows it again. `alt+l` focuses it for scrolling (↑↓ j/k, PgUp/PgDn, g/G). `Esc` hands the keyboard back. While it is hidden, a `doc` badge in the editor border reminds you.


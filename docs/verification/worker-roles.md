# Worker roles in Settings, under Watcher

October 16, 2026. Branch `feat/worker-roles`, from `0b15b3ca5` on `origin/main`. Records [ADR-0091](../adr/0091-worker-roles-say-what-each-kind-of-work-starts-on.md), the prototype's variant C as Zach picked it, checked in the built app on Windows 11.

## What was run

`tests/e2e/worker-roles.spec.ts` launches the built app on the Owl track with the real Claude Code and Codex adapters over the fake CLIs. The fake Claude Code lists Opus 5.5, Sonnet 5.5 and Haiku 5.5; the fake Codex lists GPT-6.1 Sol, GPT-6 Astra and GPT-6 Luna. Muse and Grok Build are not set up. No new-thread default permission is chosen, so the ceiling is Ask for approval.

- **Defaults.** Settings, under Watcher, has a card per role. Orchestrating is on Opus 5.5 at High with Watcher's own Ask for approval, beside a drawing of Watcher's composer chips showing the same three. Building and UI are on Opus 5.5 at Extra high with Allow edits, and each says its workers start on "Ask for approval" with **Change it in Agents**. Code review's first default, Muse Wonder Full, reads **Not set up**, so it is on GPT-6.1 Sol at Extra high, **In use**. Research is on Haiku 5.5, whose effort field reads "Haiku 5.5 has none". Computer use is on GPT-6 Astra at Medium with Full access, held to "Ask for approval", with the line about Codex's sandbox on Windows. **Reset all to defaults** is disabled.
- **By keyboard.** Building's model chip is named "Choose Building's model. Now Opus 5.5". `Enter` opens the model list with focus in its search; `Escape` closes it and returns focus to the chip. `Enter`, typing "Sonnet", `ArrowDown` and `Enter` choose Sonnet 5.5: the card reads **Your choice** and the saved settings hold the whole row. The permission chip opens its list on Allow edits, and `Escape` returns focus to the chip.
- **A provider away.** Disconnecting Claude Code moves Orchestrating, UI and Research to their next defaults, each saying why, and a line over the cards says Claude Code is not connected and nothing you chose has changed. Building keeps Sonnet 5.5, reads **Your choice, not available**, and says workers start on GPT-6.1 Sol meanwhile. Connecting Claude Code again puts Building back on **Your choice**.
- **Reset.** Building's **Reset to default**, named "Reset Building to its default, Opus 5.5 at Extra high with Allow edits", puts Opus back and says so with **Undo**, which restores Sonnet. **Reset all to defaults** clears every row.
- **A start by role.** The Claude Code thread calls `delegate` as its agent would, naming only `code-review`. The delegated thread starts on Codex's GPT-6.1 Sol at Extra high with Ask for approval, and the result's `role` says it started as Code review from that role. A second delegation naming Codex's GPT-6 Luna for `research` starts on Luna, and its result says the request named the model.
- **Stable.** The same profile on the stable track has no Watcher tab in Settings and no worker role cards.

Both journeys passed (2 passed, 29 s).

## Fit and contrast

At 1600x1000, 1280x800 and 820x560, in dark and light, with the defaults and with Claude Code away: nothing overflows the window or the Settings form, no card, field or line in the defaults runs past its edges, and every piece of text in the panel measures at least 4.5:1 against the surface under it, checked in the running app. At 820x560 the cards stack in one column and Orchestrating's composer drawing goes under its fields.

## Captures

In `artifacts/worker-roles/`:

- `roles-dark-1280x800.png`, `roles-light-1280x800.png`: the defaults, Orchestrating beside Watcher's composer.
- `roles-dark-820x560.png`: the minimum size, one column.
- `roles-lower-dark-1600x1000.png`: Code review, Research and Computer use with their defaults and notes.
- `roles-building-chosen-dark-1280x800.png`: Building on Sonnet 5.5 as the user's choice, with Reset to default.
- `roles-claude-off-dark-1280x800.png`: Claude Code away, rows on their next default.

## Not covered here

When Watcher's own provider disconnects, offering a new Watcher on Orchestrating's next default when you send is not built yet (ADR-0091, Consequences). A paired host is not part of this journey; its start carries no role, which the integration suites check.

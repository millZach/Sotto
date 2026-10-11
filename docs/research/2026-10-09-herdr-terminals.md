# Herdr's terminals and Sotto's

Researched 9 October 2026 against Herdr v0.9.3 (29 September 2026) and Sotto at `efbd12be7`. The question: what Herdr does for people who live in terminals, what Sotto does today, and what Sotto should take.

## What Herdr is

Herdr is a single Rust binary that runs inside the terminal you already use (Ghostty, kitty, iTerm). A background server keeps real terminals alive for coding agents, and a text interface attaches to it, much as tmux does. It is free and Apache-2.0, has about 43k GitHub stars, and is stable on macOS and Linux with Windows in beta. ([herdr.dev](https://herdr.dev), [repo](https://github.com/herdrdev/herdr), [licence change](https://herdr.dev/blog/herdr-is-joining-y-combinator/))

Its pitch is one sentence: close the window and nothing dies, and you can always see which agent needs you.

## Side by side

| | Herdr | Sotto today |
|---|---|---|
| Organisation | Workspace, then tab, then pane; panes split and resize ([concepts](https://herdr.dev/docs/concepts/)) | Three surfaces: Terminal mode (per project, in the pane grid), the pane's Terminal drawer and the Tools panel terminal (per thread) (`CONTEXT.md:140-146`) |
| Closing the window | Processes keep running in the server and you reattach ([session state](https://herdr.dev/docs/session-state/)) | A window reload keeps the shells; quitting Sotto ends them (`src/main/terminals/service.ts:55-59`) |
| After a restart | The layout returns as fresh shells in the same folders, and Claude Code and Codex resume their own sessions with `claude --resume <id>` and `codex resume <id>` ([session state](https://herdr.dev/docs/session-state/)) | Terminal mode keeps nothing. A Tools or drawer shell comes back as Interrupted with empty output (`src/main/tools/terminal.ts:33`) |
| Agent state | Idle, working, blocked or done, read from the agent's process plus the live bottom of the screen against per-agent rules. Blocked needs a known approval or question prompt. Done stays marked until you look ([agents](https://herdr.dev/docs/agents/)) | Running if there was output in the last 4 seconds, otherwise Idle (`src/renderer/src/terminals/terminalFacts.ts:9`) |
| Rollup | A blocked pane marks its tab and workspace as blocked ([agents](https://herdr.dev/docs/agents/)) | None |
| Getting your attention | In-app, terminal or system toasts, off by default, held for about 1 second and skipped for the tab you are on. Separate sounds for done and for a request. A key jumps to whatever the last one was about ([config](https://herdr.dev/docs/config-reference/)) | None for terminals |
| Navigation | A picker that lists every agent and terminal, with search and filters for blocked, working, idle and done ([keyboard](https://herdr.dev/docs/keyboard/)) | The sidebar's terminal search (`terminalFacts.ts:107-132`) |
| Search in output | Copy mode with `/` and `?` search ([keyboard](https://herdr.dev/docs/keyboard/)) | None: only the fit and WebGL xterm addons are installed (`package.json:58-60`) |
| Links | Ctrl+click opens URLs and OSC 8 links | None |
| Scrollback | 10 MB per pane | 5,000 lines, with 512 KiB replayed after a reload (`src/renderer/src/tools/terminalView.ts:129`, `src/shared/terminal.ts:7`) |
| Images | Kitty graphics; paste a clipboard image into a pane | Image paste in Terminal mode only (`service.ts:352-374`) |
| Worktrees | `herdr worktree create`, grouped under the parent repo; removing it keeps the branch ([CLI](https://herdr.dev/docs/cli-reference/)) | Terminal mode can open in a new worktree on `sotto/terminal-*` (`service.ts:102-106`); nothing reclaims it when the terminal closes (`service.ts:342-351`) |
| Agents driving terminals | A local socket API: split, run, read, `agent wait --until blocked`, `agent prompt` ([socket API](https://herdr.dev/docs/socket-api/)) | No tool lets a thread read or drive a terminal |
| Remote | `herdr machine add <ssh-host>` merges that machine's agents into the sidebar ([machines](https://herdr.dev/docs/connecting-machines/)) | No terminal on a paired host or on the phone clients (ADR-0037, ADR-0049) |

What users say about Herdr: the praise is about rendering Claude Code's interface well and switching between agents quickly. The complaints are side effects in ordinary shell sessions and "what does this give me that splits don't". ([HN](https://news.ycombinator.com/item?id=49201003))

## What Sotto should not copy

- **Writing terminal output to disk.** Herdr's own `pane_history` is off by default because "pane output can include secrets, tokens, prompts, and command output." Sotto's privacy brief says the same thing more strongly. Sotto should bring a session back by resuming the agent, not by replaying saved output.
- **Detection rules fetched from a server.** Herdr updates its rules from herdr.dev. That would add a host, and Sotto would need an ADR first. Rules should ship in the app.
- **A prefix-key keymap.** It suits a TUI inside another terminal. Sotto is a desktop window with its own shortcuts and the dictation hotkey.

## What is broken or misleading today

Each of these was confirmed in the source.

1. An Interrupted shell says "The output below is what it showed before", but restored records always have empty output (`src/renderer/src/tools/TerminalSurface.tsx:194`, `src/main/tools/terminal.ts:33`).
2. The new-shell button says "A thread can keep 32 terminals" and counts per thread (`TerminalSurface.tsx:92,112`). The real limit is 32 across every thread, and dead sessions count towards it (`terminal.ts:73`).
3. The macOS hint says "⌘+C copies a selection or interrupts" (`src/renderer/src/terminals/TerminalPane.tsx:101`). ⌘C never interrupts; Ctrl+C does.
4. The drawer and Tools panel always start Windows PowerShell 5.1 (`terminal.ts:87-89`). Terminal mode prefers PowerShell 7 when it is on PATH (`service.ts:189-199`).
5. When a provider CLI exits in Terminal mode, the terminal ends with it, because the shell is replaced on macOS and Linux and runs a single `-Command` on Windows (`service.ts:229-232`).
6. Worktrees made for Terminal mode are never reclaimed.

## Options, ranked

The ranking weighs what a terminal user feels most against how much it costs.

1. **Fix the six problems above.** Small, and visible every day.
2. **Terminal basics:** search in output, clickable links (opened through main, since the window refuses `window.open`), font size with Ctrl+= and Ctrl+-, Unicode width, and image paste in the drawer. Each is an xterm addon or a few lines.
3. **Know what the agent in a terminal is doing.** Sotto starts the CLI itself, so it can do better than reading the screen. It can start Claude Code with its own session ID and with hooks that tell Sotto when Claude stops or asks for approval, and it can use Codex's notify hook the same way. Screen rules that ship in the app cover the rest, Grok included. That gives each terminal Idle, Working, Needs you and Done, with Done held until you look. The project row in the sidebar shows the most urgent state underneath it. Needs an ADR on how the hooks report to main.
4. **Bring terminals back after a restart.** Restore Terminal mode's layout as fresh shells in the same folders. Reopen a Claude or Codex terminal by resuming its own session from the ID Sotto recorded in step 3. Output is never written to disk.
5. **Attention and navigation.** A quiet, opt-in signal when a terminal you cannot see needs you (it follows Herdr's rules: skip the one you are looking at, wait a second). A picker filtered by state that lists threads and terminals together. A shortcut to the one that needs you.
6. **Replay a TUI correctly after a reload.** The 512 KiB raw tail can start in the middle of a full-screen redraw. Keeping a headless copy of the screen in main and sending its serialized state would fix this. To confirm in the running app before building.
7. **Let a thread use a terminal.** A tool in the style of `sotto_browser` that opens, reads and types into a project terminal, so a thread can run a dev server and watch it. A thread that types into a shell is running commands, so it needs an ADR on who answers.
8. **Later:** terminals that outlive Sotto itself (a separate PTY process), terminals on a paired host, and terminals on the phone clients. Each is large, and the remote one was deferred on 5 October (ADR-0025).

## What the owner picked

On 9 October 2026 the owner chose options 1 to 3 first. Needs you and Done are separate states, as in Herdr.

He also chose to have Terminal mode's terminals show on the iPhone in this round. Each appears with its state, and the phone answers a provider's approval prompt under Can answer, where the provider's hooks report that prompt. Paired phones already reach the desktop over the tailnet (ADR-0033), but host protocol version 1 has no terminals (`apps/ios/README.md:7`).

A live terminal on the phone, where you watch the screen and type into the shell, comes later. It needs its own ADR, because a phone that can type into a shell can run any command on the computer, which is more than Can answer allows.

## What the installed CLIs offer for option 3

Checked against the command-line tools installed on the development machine on 9 October 2026:

- **Claude Code** has `--session-id <uuid>` to start with an ID Sotto chooses, `--settings <file-or-json>` to pass the hooks for that one run, and `--resume <id>` to reopen it.
- **Codex** has `-c key=value` to set config overrides for one run, which can set its notify hook, and `codex resume <SESSION_ID>`. Codex picks its own session ID, so Sotto learns it from the hook rather than choosing it.

## The look the owner picked

The owner reviewed the prototype on 9 October 2026 (`docs/prototypes/terminal-agent-state-prototype.html`) and made three choices:

- **Variant B.** The Terminal-mode sidebar is ordered like the iPhone's Threads page: Needs you across all projects first, then Working, then the rest by project, then Closed. The pane that needs you gets a thin edge along its header. On the phone, terminals sit in the same Needs you, Working and Recent sections as threads, each marked with a terminal glyph, and the approval card offers No, Yes and More choices.
- **"Just finished"** for a terminal whose agent finished while you weren't looking, with the same dot and bold title threads use (ADR-0046). It holds until you view that terminal.
- **What is on screen earns nothing.** An agent that finishes in a pane you can see goes straight to Idle, focused or not, which is the rule threads follow.

When you answer from Sotto or the phone, the answer should go back to the agent through its hook rather than as keystrokes typed into the terminal. That way it can't land on a different prompt if the screen has changed since.

# Composer controls in desktop coding-agent apps

Studied on 2026-10-22 in worktree `39d2542a-224a-45c9-826a-4f52002d02d1`, on branch `feat/filled-cards-and-rectangle-buttons`. Research only: nothing was built, run, edited or committed. Visual appearance was not checked (see Basis).

The question: how do current desktop coding-agent apps show a composer's settings (model, reasoning effort, permission mode, workspace or worktree, branch, host) without boxed chips, and how do they handle a queued follow-up while the agent works? The three directions for Sotto are at the end.

## Basis and limits

- **Sources.** Vendor docs, changelogs, vendor blog posts and repo READMEs and docs first. Third-party write-ups (DataCamp, Codersera, search-snippet mirrors) and forum threads are marked as secondary wherever they are used.
- **How pages were read.** Pages were read with WebFetch, which answers from a summary of the page. Only two sources were checked against raw page text: the Claude Code VS Code page and the Claude Code interactive-mode page, both searched in the saved fetch output. Every other quote here is a summary and should be checked against the live page before it is quoted.
- **Redirects.** `developers.openai.com/codex/...` now redirects to `learn.chatgpt.com/docs/...`. The Codex pages are cited at the address they were read from.
- **Looks are not confirmed.** No fetched page described boxes, chips, borders, icon sizes or rest-versus-hover styling for any composer. Where this note says "dropdown", "slider", "text button" or "row", that is the control type the docs name, not a verified look. Screenshots were not viewed.
- **Hit-target sizes** are not stated by any source here.

## Findings by app

### 1. OpenAI Codex

**Codex desktop app.** The app's own docs are thin on the composer. Three facts are sourced:

- **Model and effort** are one slider beneath the composer in Work or Codex. The ends are labelled "Smarter" and "Faster". It starts at a "Power" setting that varies by account. "Advanced" opens controls for the model, reasoning effort or speed. Presets bundle a model with an effort (for example "Astra Medium"). Left and Right arrow keys adjust the power. No key to open the slider is stated. Source: <https://learn.chatgpt.com/docs/models> (summary, unverified verbatim).
- **Worktree and branch.** A "Worktree" control sits under the composer in the new chat view. A base-branch picker sits below the composer. After a task starts, the chat header offers "Open", "Create branch here" and "Hand off". The branch dialog has "Create branch", a "Branch name" field with a `codex/` prefix, and "Create". Defaults are not stated. A local environment selector is also under the composer, with no label stated. Source: <https://learn.chatgpt.com/docs/environments/git-worktrees> (read from <https://developers.openai.com/codex/app/worktrees>).
- **Queue, steer, predictions.** The app changelog for Codex app 26.1007 (2026-10-08) says "Fixed queued messages getting stuck on Sending and restored Steer in secondary app windows." So queued messages and Steer exist in the app. Their placement and keys are not stated. Composer predictions show an autocomplete-style follow-up in the message box. Tab accepts it as an editable draft, and it is not sent. The "Show predictions" toggle is under Settings, General, Composer. Source: <https://learn.chatgpt.com/docs/features/composer-predictions> and <https://developers.openai.com/codex/changelog> (read via <https://learn.chatgpt.com/docs/changelog>).

Not confirmed for the desktop app: where the permission mode is picked (the permissions page documents config profiles, not the in-app control, see <https://learn.chatgpt.com/docs/permissions>); any stop or busy control; any queue key. A "+"-style "Add" list (Files and folders, Attach Google Chrome, Goal, Plan mode) appears in a mock on <https://learn.chatgpt.com/docs/features>, with no placement stated.

The Codex CLI, not the app, has a change (0.163.0, 2026-10-15) that sends a follow-up while Codex is responding to steer it immediately. The changelog does not state the keys. Source: <https://developers.openai.com/codex/changelog>.

**Codex IDE extension.** <https://learn.chatgpt.com/docs/codex/ide> shows a sample composer with a "6-Sol" dropdown and a "Custom" dropdown below the prompt text. The text does not state what these control. "Continue in" offers "Work locally" and "Cloud". After a run, "Ask for follow-up changes" appears. Model effort, the permission modes, shortcuts and queue behaviour are not stated.

### 2. Claude desktop (Code tab) and Claude Code VS Code extension

**Claude desktop, Code tab.** Source: <https://code.claude.com/docs/en/desktop> (summary; the composer-row sentences were re-read as quoted text).

- **Row under the prompt box.** Before the first message, choose "the environment, project folder, permission mode, and model in the row under the prompt box". The environment selector is the first control. The project folder control sits next to it. The mode selector comes next, and the model picker sits "toward the right end of the row". The row can be changed during the session for mode and model. A usage ring sits next to the model picker. A "+" button offers attachments, slash commands, connectors, plugins and "Add folder".
- **Effort** is inside the model picker, under an "Effort" row, in the current layout. The page does not say whether effort is in the row.
- **Shortcuts** (macOS keys; Ctrl on Windows and Linux): Cmd Shift M opens the permission-mode menu, Cmd Shift I the model menu, Cmd Shift E the effort menu. Digits 1 to 9 select an item in an open menu. Ctrl O cycles view modes. The page says Shift+Tab does not cycle permission modes in Desktop, unlike the terminal.
- **Worktree.** Turn on "Worktree" in the project folder control before starting. It is off by default. There is no branch picker in the current layout, only a "Branch prefix" setting.
- **While Claude works.** Type a correction and press Enter to send it "without stopping the running action". Claude reads it "as soon as the current action completes". The stop button "interrupt[s] immediately", and Esc stops the response. The page does not name these as "steer" or "queue", and it does not describe a queue of several messages. Slash commands can be sent while Claude works.
- **Busy state.** The page names only the stop button and the session returning to idle. Its label and position are not stated.

**Claude Code VS Code extension.** Source: <https://code.claude.com/docs/en/vs-code>, read from the saved raw page.

- **Bottom of the prompt box** (the page says these sit there): a permission-mode indicator you click to switch modes, a model-name button that opens the model picker, a context indicator, and an agent count (for example "2 agents") that opens an agent map. The picker shows an "Effort" row when the model supports effort, and the model-name button shows the level. An "Ultracode" switch sits under that row when enabled.
- **Typed and menu paths.** "/" opens commands inline. "/model" opens the picker, and "Switch model…" is in the command menu. "/plan" switches to plan mode.
- **Queue.** "When you send a message while Claude is working, the extension announces 'Message queued.'" The queue mechanics are on the terminal page, <https://code.claude.com/docs/en/interactive-mode>. Enter queues while Claude works. Queued messages reach Claude at the next tool-call boundary within the turn, and the rest go out when the turn ends. Ctrl+Enter sends queued messages now (from v2.1.275). Esc interrupts the turn and keeps the queued draft. Up from the first line takes queued messages back into the box. The setting `useCtrlEnterToSend` swaps Enter and Ctrl/Cmd+Enter.
- **Busy state.** "When you click Stop or press Esc, the current turn ends" (from v2.1.286). Background agents keep running until stopped from the map.
- **Model and thinking keys.** The terminal page lists Option+P (Alt+P) to switch model without clearing the prompt, and Option+T (Alt+T) to toggle extended thinking. The VS Code page does not say whether the extension binds the same keys.

### 3. Cursor

Sources: <https://cursor.com/docs/agent/tools>, <https://cursor.com/docs/agent/chat/tabs>, <https://cursor.com/docs/agent/modes>, <https://cursor.com/changelog/3-0>.

- **Queue.** "Queue a message and it waits for the current task to finish." Press Enter to queue. Queued messages can be dragged to reorder and are handled one after another. Cmd+Enter "send[s] immediately, bypassing the queue" and attaches the message to the most recent user message. "Send now" (or Enter twice, per one passage) steers the active turn "at the agent's next tool call". Tab queues the message for after the turn. "Send now" is available on cursor.com/agents and "rolling out in the Agents Window". The docs also say that in Cursor's CLI, Enter steers at a safe boundary and a second Enter interrupts. The same page says Enter queues, so the Enter behaviour is contradictory in the docs.
- **Modes.** "A mode picker dropdown in Agent" switches modes. Shift+Tab rotates to Plan Mode from the chat input. Plan Mode "writes an implementation plan that you can edit before you click to build it". The model picker is not covered by this page.
- **Agents Window.** Opened with Cmd+Shift+P, then "Agents Window" (changelog 3.0, 2026-04-02). It runs agents "locally, in worktrees, in the cloud, or over remote SSH". The changelog does not say where the input sits, where the model picker sits or how an environment is chosen.
- **Chat input.** "Agent" opens in the sidepane with Cmd+I. A plus button at the top of the chat panel starts a side chat. "Restore Checkpoint" appears on earlier requests. "/side", "/btw" and "/goal" are typed in the chat input.
- **Busy state.** Cursor's docs do not name a stop control. Forum staff replies mention "Stop" and "Send Now" on queued follow-ups.
- **Secondary, unverified.** DataCamp describes "Agent Tabs" tiled side by side, the Agents Window sidebar listing local and cloud agents, and a `/worktree` command that works in the classic editor layout (<https://www.datacamp.com/blog/cursor-3>). Forum threads describe a Queue Messages setting under Settings, Agents, with "Send after current message" and "Send immediately" (<https://forum.cursor.com/t/every-agent-message-gets-queued-and-required-me-to-click-send-now/169100>), and say the Send now button relies on hover and is missing in the mobile web view (<https://forum.cursor.com/t/no-send-now-button-in-mobile-agents-mode/155685>). Neither is confirmed against Cursor's own docs.

### 4. Windsurf (now Devin Desktop)

Sources: <https://docs.devin.ai/desktop/models> (redirected from <https://docs.windsurf.com/windsurf/models>) and <https://docs.devin.ai/desktop/cascade/cascade>.

- **Model.** A model selection menu sits "Under the text input box". Its label and keyboard shortcut are not stated.
- **Mode.** Two modes, "Code" and "Chat". Where the switch sits and its shortcut are not stated. An older JetBrains-branded overview calls the first mode "Write" (secondary).
- **Opening.** Cmd/Ctrl+L opens Cascade. A dropdown in the top left switches between simultaneous Cascades.
- **Queue.** "Type it while Cascade is working and press Enter." Queued messages run in order after the current task. Enter on an empty box sends the queued item immediately. A message can be removed before it is sent, but the control is not named.
- **Busy state.** Not stated.

### 5. Zed

Source: <https://zed.dev/docs/ai/agent-panel> (summary). Profile names come from a search snippet of <https://zed.dev/docs/ai/agent-profiles> and are not verified.

- **Model.** The model selector is on the message editor. `cmd-alt-/` (`ctrl-alt-/`) opens it. Models can be starred as favourites. "alt-tab" (listed as "alt-l") cycles favourites without opening the selector. A "No tools" label marks models that cannot use tools.
- **Profile.** A profile selector sits in the message editor, near the token usage. Profiles choose which built-in and MCP tools are available. Built-in profiles are named Write, Ask and Minimal (snippet). Tool permissions are on a separate page and are not described in the panel text.
- **Worktree.** The worktree picker is in the title bar, not in the editor. It selects the worktree the agent runs in, or creates one.
- **Queue.** Messages sent while the agent works are queued by default and sent when it finishes. A "Steer" toggle on a queued message sends it at the agent's next step, between a tool call and a response. Steer works only with the Zed Agent. Queued messages can be edited or removed, one or all. Interrupting uses the stop button or "Send Now", which the page ties to a double Enter. No shortcut for the stop button is stated.

### 6. GitHub Copilot agent chat in VS Code

Sources: <https://code.visualstudio.com/docs/copilot/agents/local-agents> and <https://code.visualstudio.com/docs/agents/run/agent-harnesses>.

- **Agent picker.** "Ask", "Agent" and "Plan" for Local and Copilot harnesses. Its location is not stated.
- **Model.** Models are grouped under "Anthropic" and "Copilot" for Claude sessions, and under "Copilot" and "ChatGPT" for Codex sessions. Placement is not stated.
- **Session Target.** A dropdown in the editor's chat input hands a Local session off to another harness or to Cloud. In the Agents window, folder or repository is chosen when a session starts, and the page mentions choosing a folder or a worktree and running in a Dev Container. Labels for these are not stated.
- **Typed commands.** "/plan" and "/delegate" in the Copilot harness.
- **Permission level.** The input is not described. The page sends readers to separate approval pages.
- **Queue, steer, shortcuts.** Not stated.

### 7. T3 Code

Sources: <https://github.com/pingdotgg/t3code> (README), <https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md>, <https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md>.

- **Status.** The README calls it an "agent harness control surface", available as Electron desktop, web, iOS and Android. It says "We are very very early in this project. Expect bugs." It lists Codex, Claude, Cursor, Grok Build, OpenCode and Google Antigravity as providers. The license is MIT. The README does not say alpha.
- **Permission mode.** Four modes: "Supervised", "Auto-accept edits", "Auto" (a provider-run review) and "Full access". "Choose a mode in the message composer" sets it per thread. The default for new threads is under Settings, General, New threads, Permissions, and projects can override it. The page says the initial default is Full access.
- **Keys** (per the page's table, read through WebFetch; open the raw file before quoting): model picker `mod+shift+m` (Ctrl+Shift+M); provider switch `mod+shift+up` and `mod+shift+down`; access mode `mod+shift+a`; effort picker `mod+shift+e`; newline `Shift+Enter`; opposite queue-or-steer for one message `mod+Enter`; send the first queued message as a steer `mod+shift+Enter`; start in background `mod+alt+Enter`; interrupt the running turn `thread.stop` with no default key; "Composer: Cycle Host" with no default key. Queue or steer as the default for follow-ups is set in Settings. Increase and decrease effort have no default keys.
- **Secondary.** A Mintlify mirror describes each worktree thread getting its own branch with a `t3code/` prefix (<https://www.mintlify.com/pingdotgg/t3code/guides/git-workflow>). Not verified against the repo.

## Patterns across the apps

| Facet | Where it appears (as documented) | Control type named | Keyboard |
|---|---|---|---|
| Model | Codex app: under the composer, in a slider with "Advanced". Claude desktop: model picker at the right end of the row under the prompt. Claude VS Code: model-name button at the bottom of the prompt box. Windsurf: menu under the input. Zed: selector on the message editor. Copilot: placement not stated. Cursor: not stated. | Slider; button; menu | Claude desktop Cmd/Ctrl+Shift+I; T3 `mod+shift+m`; Zed `cmd-alt-/`; Codex slider arrows; Claude terminal Alt+P |
| Effort | Inside the model picker in Claude desktop and Claude VS Code. Inside the Codex slider's "Advanced". Not stated elsewhere. | Row in a menu; slider | Claude desktop Cmd/Ctrl+Shift+E; T3 `mod+shift+e` |
| Permission mode | Claude desktop: row under the prompt. Claude VS Code: indicator at the bottom of the prompt box. T3: "in the message composer". Cursor: "mode picker dropdown" (Agent and Plan). Codex app: not confirmed in the UI. Zed: profile selector; tool permissions elsewhere. | Indicator; dropdown; menu | Claude desktop Cmd/Ctrl+Shift+M; T3 `mod+shift+a`; Cursor Shift+Tab (modes, not permissions) |
| Workspace or worktree | Codex app: "Worktree" under the composer. Claude desktop: first control in the row, plus the folder control. Zed: title bar. Copilot: session start or Session Target. Cursor: Agents Window, placement not stated. T3: "Composer: Cycle Host", no visible placement stated. | Control under the composer; header; command | T3 has no default key for host cycling |
| Branch | Codex app: base-branch picker below the composer, "Create branch here" in the header. Claude desktop: "Branch prefix" setting only. Zed: not described. | Picker; header button | Not stated |
| Queue | Claude: Enter queues (terminal and VS Code), "Message queued." announced. Cursor: Enter queues, drag to reorder. Zed: queued by default, edit or remove. Windsurf: Enter queues. T3: setting chooses queue or steer by default. | Queue list; inline | See the queue table below |
| Steer | Claude desktop: Enter steers without stopping. Codex app: "Steer" restored (26.1007). Zed: per-message "Steer" toggle. Cursor: "Send now" or Enter twice. T3: `mod+Enter` flips one message. | Button; per-message toggle | See the queue table |
| Busy state | Claude desktop: stop button, Esc. Claude VS Code: Stop button, Esc. Zed: stop button. Cursor: "Stop" in forum replies only. Codex app, Windsurf, Copilot, T3 (beyond `thread.stop`): not stated. | Stop button; Esc | Esc in Claude; `thread.stop` in T3 (no default key) |

Queue and steer keys, as documented:

| App | Message while the agent works | Send now or steer | Interrupt | Source |
|---|---|---|---|---|
| Claude (terminal and VS Code) | Enter queues | Ctrl+Enter sends queued now (v2.1.275+); Ctrl+Enter-send setting available | Esc keeps the queued draft | interactive-mode page |
| Claude desktop | Enter steers (no queue of several documented) | Enter | Stop button; Esc | desktop page |
| Cursor | Enter queues | Cmd+Enter; "Send now" (steers at next tool call) | Stop (forum only) | Cursor docs, forum |
| Codex app | Queued messages exist (26.1007) | Not stated | Not stated | changelog |
| Codex CLI | A follow-up sent while responding steers immediately | Not stated | Not stated | changelog 0.163.0 |
| Cursor CLI | Enter steers at a safe boundary | Enter again | Second Enter interrupts the turn | Cursor docs (tools page) |
| Windsurf | Enter queues | Enter on an empty box | Not stated | Devin Desktop page |
| Zed | Queued by default | "Steer" toggle per message; "Send Now" | Stop button | Zed page |
| T3 | Default queue or steer chosen in Settings | `mod+Enter` flips one message; `mod+shift+Enter` sends first queued as steer | `thread.stop` (no default key) | keybindings page |
| Copilot | Not stated | Not stated | Not stated | local-agents page |

## Three directions for Sotto

These are structural options, not a recommendation. Each names the apps that do something like it, the keyboard path, and the risks. The AGENTS.md rules apply in every case: colour from theme tokens, light and dark checked, 1600x1000, 1280x800 and 820x560 verified, every control keyboard-reachable with an accessible name that says what a press does, Escape closes anything that opens, controls in the drag strip opt out of dragging, and a new chord is checked against the dictation hotkey.

### A. One quiet text line, no boxes

**What it is.** One line under the composer. Each setting is text with a chevron, showing its value: model, effort and permission, then a separator, then host, workspace and branch. No fills or borders at rest. A focus ring and a hover state appear only on interaction. The queued row uses text actions (Send now, Edit, Remove) rather than icon buttons.

**Apps that do something like it.** Claude desktop's row under the prompt (text selectors, environment first). Claude VS Code's bottom-of-box indicators (mode indicator and model name). Windsurf's dropdown under the input. Cursor's mode dropdown. Codex's worktree and base-branch controls under the composer.

**Keyboard path.** Tab moves across the line in visual order. Enter, Space or Down opens each menu. Escape closes it and returns focus to its control. Per-control shortcuts are optional. Claude desktop's Cmd/Ctrl+Shift+M/I/E and T3's `mod+shift+m/e/a` are the obvious models, but Sotto already claims `ctrl+shift+m` for pane zoom (`src/renderer/src/agents/ThreadPanes.tsx:227`), so one of them has to move. The queued row is reached from the textarea with a key that moves focus down into it. Claude's "Up takes queued messages back" is a model for an edit path.

**Risks.**
- *Discoverability.* Text can read as a caption. Chevrons, focus states and a clear value are needed.
- *Hit area.* Text targets are small. WCAG 2.2 AA (2.5.8) asks for 24 by 24 CSS pixels; this is a general standard, not one of the sources above. Padding is needed without making the line look boxed.
- *Narrow windows.* Six to eight items will not fit on one line at 820 px. The collapse order has to be designed, for example host, workspace and branch collapsing into one "forge · main" item first.
- *Screen readers.* Each item's accessible name has to carry its value and what a press does ("Model, Opus 5.5. Change model"). The line needs a group name.

### B. One combined settings button, plus a status line

**What it is.** The composer footer holds one combined trigger, for example "Opus 5.5 · High · Full access" with a chevron. It opens one menu with sections for model, effort and permission, optionally host, workspace and branch as well. Below the composer, one line of text shows where the thread runs ("forge · Current checkout · main"), with at most one link into the menu. The queued row keeps one "Send now" action and labelled Edit and Remove buttons.

**Apps that do something like it.** Codex's "Advanced" disclosure in the model slider groups model, effort and speed behind one control. Claude VS Code's model picker holds the Effort row, and its command menu holds "Switch model…". Claude desktop's numbered menu items (1 to 9) suit a keyboard path. No fetched app uses one button for every facet; this direction is a synthesis of these parts.

**Keyboard path.** One shortcut opens the combined menu (a chord to be checked against Sotto's bindings). Arrow keys move between sections. Digits or type-to-filter pick an item. Escape closes the menu and returns focus to the trigger. Tab order is trigger, status-line link, queued row.

**Risks.**
- *Hidden frequent controls.* Permission mode changes often during a run, and one menu level makes that a two-step action.
- *Discoverability.* Users may not know the menu holds host or branch.
- *Screen readers.* The button's name has to summarise state ("Thread settings: Opus 5.5, High, Full access"), not just its title. A single control announces less than a row of them.
- *Information twice.* The status line and the menu carry the same facts, so they need a rule for which is the source.
- *Narrow windows.* One button fits 820 px well. Branch names in the status line will truncate, so the full name needs a focus or tooltip path.

### C. Split by lifecycle: start-time facets go to the header, live controls stay as one composer line

**What it is.** Facets that decide where a thread runs (host, workspace as current checkout or new worktree, and base branch) are set when the thread starts and shown in the thread header, for example "forge · worktree · main", with a menu for handoff or creating a branch. The composer keeps only what changes mid-thread: one model-and-effort trigger, one permission trigger, and the queued row.

**Apps that do something like it.** Codex's worktree and base-branch controls sit under the composer before the first message, and after the task starts the header offers "Open", "Create branch here" and "Hand off". Claude desktop chooses environment, folder, permission mode and model in the row before the first message. Zed puts its worktree picker in the title bar. Copilot chooses the folder or repository when a session starts. T3 handles host cycling as a command, with no visible placement stated.

**Keyboard path.** A shortcut moves focus to the header region and back. Header controls sit in the drag strip, so each must opt out of dragging. Start-time choices take focus when a new thread opens, and Escape closes their menus.

**Risks.**
- *Less visible at send time.* A thread can go to the wrong host or branch if the choice is only in the header.
- *Narrow windows.* Title, host, branch and actions in one header will overflow at 820 px, and the header needs a collapse rule.
- *Panes.* Sotto's threads can be laid out in panes (`src/renderer/src/agents/ThreadPanes.tsx`). The design must say which header a control belongs to.
- *Mid-thread change.* Changing host or branch once a thread has started needs a path, such as the handoff that Codex and Copilot offer.
- *Keyboard focus order.* The header is outside the composer, so focus order has to be designed across both regions, not inherited.

## Notes that apply to all three directions

- **Enter and Ctrl/Cmd+Enter.** Enter queues while the agent works, and Ctrl/Cmd+Enter sends now in Cursor and Claude. Sotto's composer already maps Enter to send and Ctrl/Cmd+Enter to send (`src/renderer/src/agents/composerKeys.ts:24`). How Sotto's composer handles these keys while a thread is running was not checked here, and the queue or steer key needs a deliberate decision.
- **Hover.** Cursor's Send now on queued follow-ups relies on hover and is missing on touch (forum, secondary). The queued row must not depend on hover for any action.
- **Chords Sotto already claims.** The branch toolbar claims `mod+shift+g`, `mod+shift+x` and `mod+shift+l`, described in the code as "T3's chords" (`src/renderer/src/agents/branchToolbar.logic.ts:10`). Pane zoom claims `ctrl+shift+m` (`src/renderer/src/agents/ThreadPanes.tsx:227`). A chord is used only when the dictation hotkey does not already take it (`branchToolbar.logic.ts:196`, `src/renderer/src/agents/BranchToolbar.tsx:124`). Claude desktop and T3 use `mod+shift+m` for the model picker and `mod+shift+e` and `mod+shift+a` for effort and permission, so any direction that borrows those chords must resolve the zoom collision first.
- **Hit targets.** No source gives sizes for any composer control.

## Not confirmed, and the checks that would settle them

- **Looks.** No fetched text described boxes, chips, borders or icon sizes. The vendor pages have screenshots, but they were not viewed. Before the prototype, capture the composers from the live apps or the official pages.
- **Codex desktop app.** The in-app location of the permission mode; any stop or busy control; the queue key and its placement; the label of the environment selector.
- **Cursor.** The model picker's location and label in the editor and the Agents Window; the Enter behaviour, which its docs contradict on one page.
- **Copilot.** Placement of the agent and model pickers, and how a message sent while an agent runs is handled.
- **Windsurf.** Where the Code/Chat switch sits and its shortcut.
- **T3 Code.** Open the raw keybindings and permission-modes files and confirm the table before quoting it.
- **Zed.** The tool-permissions page and the stop button's shortcut.

## Sources

Primary (vendor docs, changelogs, repo docs):

- Codex: <https://learn.chatgpt.com/docs/environments/git-worktrees> (from <https://developers.openai.com/codex/app/worktrees>); <https://learn.chatgpt.com/docs/models>; <https://learn.chatgpt.com/docs/features/composer-predictions> (from <https://developers.openai.com/codex/features/composer-predictions>); <https://developers.openai.com/codex/changelog> (read via <https://learn.chatgpt.com/docs/changelog>); <https://learn.chatgpt.com/docs/codex/ide>; <https://learn.chatgpt.com/docs/permissions>; <https://learn.chatgpt.com/docs/features>; <https://learn.chatgpt.com/docs/app>
- Claude: <https://code.claude.com/docs/en/desktop>; <https://code.claude.com/docs/en/vs-code>; <https://code.claude.com/docs/en/interactive-mode>
- Cursor: <https://cursor.com/docs/agent/tools>; <https://cursor.com/docs/agent/chat/tabs>; <https://cursor.com/docs/agent/modes>; <https://cursor.com/docs/agent/overview>; <https://cursor.com/changelog/3-0>
- Windsurf / Devin Desktop: <https://docs.devin.ai/desktop/models> (from <https://docs.windsurf.com/windsurf/models>); <https://docs.devin.ai/desktop/cascade/cascade>
- Zed: <https://zed.dev/docs/ai/agent-panel>; <https://zed.dev/docs/ai/agent-profiles> (search snippet only)
- GitHub Copilot in VS Code: <https://code.visualstudio.com/docs/copilot/agents/local-agents>; <https://code.visualstudio.com/docs/agents/run/agent-harnesses>
- T3 Code: <https://github.com/pingdotgg/t3code>; <https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md>; <https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md>

Secondary (third-party or forum; marked where used):

- <https://www.datacamp.com/blog/cursor-3>
- <https://forum.cursor.com/t/every-agent-message-gets-queued-and-required-me-to-click-send-now/169100>
- <https://forum.cursor.com/t/no-send-now-button-in-mobile-agents-mode/155685>
- <https://www.mintlify.com/pingdotgg/t3code/guides/git-workflow>

Sotto code referenced:

- `src/renderer/src/agents/branchToolbar.logic.ts` (lines 10 and 196)
- `src/renderer/src/agents/BranchToolbar.tsx` (line 124)
- `src/renderer/src/agents/ThreadPanes.tsx` (lines 227 and 292)
- `src/renderer/src/agents/composerKeys.ts` (line 24)

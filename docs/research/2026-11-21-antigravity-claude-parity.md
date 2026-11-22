# Antigravity parity with Claude: what an Antigravity thread does that a Claude thread does

Studied on November 21, 2026, on `feat/antigravity-provider` at `95b07a0da` (#2765), for Zach's ask: "make sure I can do all the things I do with Claude." Claude is the yardstick because it has been worked on the most. Each row was worked out from the code and the docs, not from memory, by two source readings (threads and turns; tools, Watcher and hosts), and checked where it mattered. Every Works row that could run headless was then run on Google's own `agy` 1.5.13 on the Windows laptop, signed in with Zach's Google account in Sotto's own folder (`tests/integration/antigravityLive.test.ts` and `tests/integration/antigravityParityLive.test.ts`, both gated by `SOTTO_ANTIGRAVITY_LIVE`). After #2765 merged, `antigravityParityLive.test.ts` ran once more on `main` at `dbc98b231`: Sotto's tools, an image in, model and effort for the next prompt, stop, the slash command list and Allow edits all passed, and the question card failed as row 8 records, so the test fails on that row until slice 4 settles it. Since slice 4 (November 21, 2026, on `agy` 1.5.14), every check passes.

The older matrix for the other providers is `docs/research/2026-10-19-provider-parity.md`; this one is Antigravity's alone.

## How a cell is valued

- **Works**: Sotto does it for that provider, and a test, a code path or the live run shows it.
- **Partial**: the feature is there with less in it than Claude's.
- **Missing**: Sotto does not do it, and `agy`'s ACP appears to offer what it would need.
- **Can't**: `agy`'s ACP offers no such ability (its `initialize` answer, read live, is in "What `agy` offers" below).
- **Neither**: Claude does not have it in Sotto either, so it is not a gap between the two.
- **Live**: what the run on real `agy` showed. "Not run" means the row was checked in code and against the fake `agy` only.

## What `agy` offers

Read live from `agy acp` 1.5.13's `initialize`: `loadSession`; `promptCapabilities` images and embedded context, no audio; session `resume`, `close`, `load`, `list` and `additionalDirectories`; `auth.logout`; `_meta.antigravity.systemPrompt.append`. No `mcpCapabilities` is advertised, yet `agy` takes HTTP MCP servers in `session/new` and calls them (live, see row 24). No fork, rewind, compaction or speed method is advertised. Its session options are `model`, `thought_level` and `mode` (`default`, `accept-edits`, `auto`, `plan`). Its own commands, listed live: `/goal`, `/compact`, `/schedule`, `/browser`, `/plan`, `/grill-me`, `/teamwork`, `/learn`, `/boost`, `/agy-customizations`, `/antigravity-guide`, `/run-workflow`, `/swarm`.

## Fixed while checking

The live run found that **an Antigravity thread got none of Sotto's tools on real `agy`**: the adapter handed HTTP tool servers only to a client advertising `mcpCapabilities.http`, which `agy` does not. So the browser, delegation, the Council, media, plugins and the merge train's tools never reached it, and Watcher on Antigravity would have refused to start. Handed a server anyway, as T3 Code hands it over, `agy` listed the tool and called it. Fixed in #2765 (870126944), so rows 15, 20 and 23–27 read as they do below.

## Threads and turns

| # | Feature | Claude | Antigravity | Live on `agy` | Evidence |
|---|---|---|---|---|---|
| 1 | Start a thread, in a shared checkout or a new worktree | Works | Works | Passed | Both through `workspace.ts:2577,5704`; `antigravity.ts:939-961` passes the folder to `session/new` |
| 2 | Models and reasoning effort | Works | Partial since November 21: Gemini models only, under Google's terms (ADR-0212's amendment); Claude and GPT through Antigravity are not offered | Passed before the change: the account's 11 models, 8 of them Gemini, each with its thinking levels | `antigravityModels.ts:101-109`; combined picker test in `combinedModelEffortPicker.test.tsx` |
| 2b | Speed (Fast) | Works on eligible models (`subscriptionClaude.ts:174-179`) | Can't | `agy` offers no speed option | Session options are `model`, `thought_level`, `mode` only |
| 3 | Change model or effort for the next prompt | Works | Works, between Gemini models | Passed: Gemini 3.8 Flash to Claude Opus 5.5 at high before the change; the live check now switches between Gemini models | `antigravity.ts:988-1025`, `session/set_config_option` |
| 4 | Steer, queue and stop | Works | Works | Passed: steer; stop in 1.0 s | `antigravity.ts:1100-1148`; Sotto's queue `control.ts:4093-4108` |
| 5 | Resume after a Sotto restart | Works | Works | Passed: remembered the first reply after restart | `session/resume`, `antigravity.ts:685-712` |
| 6 | Fork a thread | Works, native fork in place (`claude.ts:1067-1085`) | Partial: Fork from here starts a fresh session with a handover | Not run | No ACP fork; `workspace.ts:694-708` |
| 6b | New thread from a branch; from a sub-agent | Works | Partial: from a branch works; from a sub-agent hands over its tool row only | Not run | `threadWorktrees.ts:837-855`; `antigravityActivity.ts:51-72` |
| 7 | Permission cards and the four modes | Works | Works | Passed: a card answered Allow once; Allow edits wrote a file with no card | `antigravityRequests.ts:89-112` |
| 8 | Question cards | Works (`AskUserQuestion`) | Works since slice 4: `agy`'s `ask_question` comes as an `elicitation/create` form once Sotto offers forms, and is one question card, several choices and the user's own words included | Passed on 1.5.14: a card, answered Tea, replied Tea | `antigravityRequests.ts` `antigravityForm` |
| 9 | Plan mode with approval before work | Neither: Sotto has no plan-approval flow for Claude; its todo list draws as a Plan row | Plan updates draw a Plan row; `agy` offers a `plan` mode and `/plan` | `/plan` listed | `claudeActivity.ts:197`; `antigravityActivity.ts:37-39` |
| 10 | Images in | Works | Works | Passed: named a red square "red" | `antigravity.ts:833-857` |
| 10b | PDFs and other files in | Works: PDFs sent as documents; other files staged in the folder | Partial: files are staged in the folder; a PDF is not sent as a document | Not run | `claude.ts:2417-2427`; ACP's embedded context could carry it |
| 10c | Pictures and media out, inline | Works | Works for tool pictures and Sotto's media tiles; non-text reply chunks are dropped | Not run | `antigravityActivity.ts:72`, `mediaTools.ts:23` |
| 11 | Slash commands and skills | Works | Works | Passed: 13 of `agy`'s commands listed | `antigravity.ts:822-825,1072-1076` |
| 12 | Compaction and its status | Works (`/compact`, status, boundaries) | Works since slice 2: `agy`'s own `/compact` as a quiet turn, its status, a boundary with the sizes before and after; held in memory | Probed on Gemini 3.8 Flash: no reply, the next turn's context smaller (14,623 to 9,816) | `antigravity.ts` `compact` |
| 13 | Tool, command and file-edit rows | Works | Partial: tool and command rows work; an edit shows its before and after snippet without line numbers | Passed: command and file-change rows | `antigravityActivity.ts:39-72`; T3 places snippets against the file |
| 14 | Rewind the conversation | Works (`claude.ts:971-1007`) | Can't | No ACP rewind | Fork from here is the way back |

## Tools, Watcher and hosts

| # | Feature | Claude | Antigravity | Live on `agy` | Evidence |
|---|---|---|---|---|---|
| 15 | Delegation from the thread; the Agents pane | Works | Partial: delegation works; `agy`'s own child agents show as a row without their work | Tool calls pass (row 24) | `antigravityActivity.ts:51,71`; T3 reads child work from `agy`'s `brain` folder |
| 16 | Background work and work-settled | Works (`claudeMonitoring.ts:75`) | Can't: ACP has no background-work lifecycle; rows close at turn end | Not run | `antigravity.ts:876` |
| 17 | Live token count on the thread | Works (`thread.usage`, `claude.ts:2061,2088`) | Works since slice 1: context from `usage_update`, the turn's tokens from each prompt's `usage`; held in memory, so a restart shows it again from the next turn | Passed: 9,515 of 1,048,576, with input and output | `antigravityThreadUsage.ts` |
| 17b | Usage page counts and account limits | Works | Partial since November 21: counts from `agy`'s conversation files; no account limits, which only `agy`'s own sign-in can read (ADR-0212's amendment) | Counts not run live | `antigravityHistory.ts:326`, `antigravityUsage.ts` |
| 18 | Titles, branch names, commit and pull request drafts | Works | Works | Passed: a title | `antigravity.ts:1218,1249` |
| 19 | Checkpoints and undo | Works: files restored with the conversation rewind | Partial: snapshots and turn diffs work; undo needs a rewind `agy` cannot do | Not run | `checkpoints.ts:332,476` |
| 20 | Watcher on Antigravity; Antigravity threads under Watcher | Works | Works since the tools fix | Not run on real `agy` | `watcherOnAntigravity.test.ts` (fake now advertises what real `agy` does) |
| 21 | The iPhone and Android | Works | Works | Not run on a device | `provider-antigravity`; both clients' `NewThreadsTests` |
| 22 | Paired hosts | Works | Partial: a host runs its own installed `agy` with the Google sign-in; Sotto's download and Gemini Enterprise are not offered there | Not run | ADR-0212, Consequences |
| 23 | Sotto's browser | Works | Works since the tools fix | Tool calls pass (row 24) | `antigravity.ts:430-433` |
| 23b | Computer use (desktop control) | Neither: wired to Codex only | Neither | — | `codex.ts:360-378` |
| 24 | Sotto's own MCP tools | Works | Works since the tools fix | Passed: listed `mcp_sotto_probe_ping` and called it | `antigravity.ts:546` |
| 24b | The user's own MCP servers | Works: Claude Code reads the user's own setup | Works since slice 3: the servers in the user's own `~/.gemini/config/mcp_config.json`, handed to each provider session beside Sotto's; not to Watcher | Passed on 1.5.14: a local server from the user's file listed and called | `antigravityUserServers.ts` |
| 24c | Plugins (`sotto_plugins`) | Works | Works since the tools fix | Tool calls pass | Same servers as row 24 |
| 25 | The Council | Works | Works since the tools fix | Tool calls pass | `createDesktopEngine.ts:856-882` |
| 26 | The merge train: `ready_to_merge`, `tell_watcher` | Works | Works since the tools fix | Tool calls pass | `tellWatcherTools.ts:66` |
| 27 | Media and visuals tools | Works | Works since the tools fix | Tool calls pass | `workspace.ts:1714-1717` |
| 28 | Idle stop, resume and client update | Works | Works since slice 8: after an update the account's models are read again from the new client, Gemini only; a failed read keeps the list from before | Not run on a real update | `antigravity.ts` `clientUpdated` |

## Google's terms (November 21, 2026)

Google's Antigravity terms let it suspend an account used through third-party software, and allow Claude and other non-Gemini models only in Google's own app, CLI and supported IDEs. Driving `agy acp` itself is the gray area T3 Code is in, and the risk Zach accepts. So Sotto now offers Gemini models only (rows 2 and 3), reads no account limits (row 17b), and warns on the Antigravity row that the user's own Google account carries the risk (ADR-0212's amendment). Claude parity therefore means doing on Gemini what a Claude thread does, not running Claude through Antigravity. Each slice below is checked against these terms before it is built; slice 3 most of all.

## The gaps, as slices

Missing and Partial rows only, grouped so each slice is one pull request. Can't and Neither rows are not slices.

1. **Token count on the thread** (row 17). Fill the thread's token count from each prompt's `usage`, as Claude's is. No new UI. Done.
2. **Compaction** (row 12). Turn Sotto's compaction on for Antigravity by sending `agy`'s own `/compact`, with its status. No new UI. Done.
3. **The user's own MCP servers** (row 24b). Hand `agy` the MCP servers the user set up for it in `~/.gemini`, beside Sotto's. No new UI; reads one more file of the user's, which the ADR says. Look at it afresh against Google's Antigravity terms before it is built (ADR-0212's amendment): it hands `agy` more of the user's own setup from another app. Done: the terms name no MCP servers, and this reads no sign-in and calls no Google server (ADR-0212's amendment).
4. **Question cards** (row 8). Find how `agy` raises its question tool over ACP, and make it a card; if `agy` only asks in text, say so here and close it as Can't. Done: `agy` 1.5.14 asks with `elicitation/create` to a client that offers `elicitation.form`, and in text only to one that does not.
5. **Edits on their lines** (row 13). Place each edit's snippet against the file, as T3 does, so diffs show line numbers.
6. **PDFs in** (row 10b). Send a PDF as embedded context.
7. **Sub-agents' work** (rows 15 and 6b). Read `agy`'s child agents from its `brain` folder into the Agents pane, as T3 does, so a sub-agent's row has its work and a thread can start from it.
8. **The model list after an update** (row 28). Read the account's models again when `agy` updates. Done.
9. **Paired hosts** (row 22). Sotto's own `agy` download on a host and Gemini Enterprise there. This one has UI on a host's tile.

Suggested order: 1, 2, 3, 4, then 8, 5, 6, 7, 9. The first four are what Zach does most with Claude; 8 is small; 5 to 7 fill in detail; 9 is the only one with new UI.

## Left for Zach's hands

- Open an Antigravity thread on the iPhone, send, and answer a card (row 21).
- In the installed build, pick an Antigravity model for Watcher and let it run one watched thread to a merge (row 20).

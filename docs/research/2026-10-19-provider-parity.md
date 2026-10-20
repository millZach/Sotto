# Provider parity: what a Claude thread can do that the others cannot

Studied on 2026-10-19 in worktree `254c7524-7949-4b64-9c64-be96423931fc`, on branch `sotto/claude-thread-parity-gap-research` at `origin/main` `339378ce2`. This is a source reading of Sotto, the provider docs it cites, the provider clients on this machine where installed, and read-only GitHub queries. Nothing was built, run or committed. This note replaces an earlier version written against an older commit.

## Scope and basis

- **Basis is `origin/main` `339378ce2`.** Every citation is a line read on that commit. Line numbers in older notes do not apply.
- **Six providers.** `providerIdSchema` is `src/shared/providerIds.ts:9`: `codex`, `claude`, `grok`, `devin`, `muse`, `opencode`. OpenCode is an Owl feature (`src/shared/owlFeatures.ts:23`) and a full thread provider per `docs/adr/0087-opencode-is-a-thread-provider.md:5`. Its adapter speaks OpenCode 2's HTTP server, one `opencode serve` per thread (ADR-0087 lines 5 and 9). Its Owl gate: `docs/adr/0087-opencode-is-a-thread-provider.md:13`.
- **Installed clients (`--version` and `--help`, read-only).** Claude Code `2.1.303`. Codex CLI `0.163.0`, plus its app-server JSON Schema generated to a temp folder outside the repo. Grok Build `1.0.62`. Devin `3000.10.31`, which is below main's floor of `3000.11.92` (`src/main/agents/devinRpc.ts:15`), so Devin's tool and version cells were not checked on the installed client. OpenCode `2.0.32`, one patch above the `2.0.31` ADR-0087 verified. No `muse` binary on PATH, so Muse cells rest on Sotto code and the fake-MSP contract.
- **How a cell is valued.** `supported` means Sotto does it and a test, code path or ADR shows it. `partial` means the feature exists with a narrower set. `missing` means Sotto does not do it. `impossible` is not used in this version. `unverified` means a provider fact or a Sotto line could not be confirmed on main, and the cell says why.
- **Provider docs.** `docs.x.ai/docs/grok-build` returned 404. `dev.meta.ai/docs/muse-code` confirms `muse serve`, `muse schema`, and a "versioned session protocol", not the methods Sotto calls. The Codex app-server docs at `learn.chatgpt.com/docs/app-server` list methods the installed 0.163.0 schema does not contain (noted in the gaps).
- **Codex model names.** The brief's GPT-6 / GPT-5.6 Sol, Astra, Terra and Luna names are not hard-coded on main. The only names in source are examples: `gpt-6.1-sol` (`src/shared/modelCatalog.ts:81`), "GPT-6 Astra" (`src/shared/reasoningEfforts.ts:26`), and `GPT-5.4` as an e2e fixture (`src/shared/e2e.ts:173`). Codex's model list comes from the provider at runtime. "GPT-5.6", "Terra" and "Luna" do not appear.
- **Open PRs (read-only gh, October 19, 2026).** Six are open. #1182 `perf/git-launch-off-main` and #1181 `perf/update-path-copies` are not provider-specific. #1180 `perf/remote-thread-open-bytes` is not provider-specific. #1179 `fix/queue-after-compaction` (origin head `0dd8cb78c`), "Keep a compacting Claude thread busy until Claude Code answers the compaction", is the Claude compaction fix. #1175 `fix/watcher-room-setup-is-the-users` and #1174 `fix/muse-model-confirmation` are the Watcher and Muse items. Merged: #1177 `fix/opencode-any-install`. Open issues: 139, including #1108 "OpenCode is a thread provider".
- **Docs read.** `CONTEXT.md` (terms checked by search; "Model source" at line 91 and "Provider session" at line 103 already exist), `docs/agent-control.md` (line numbers below are main's), `README.md:95-102` (privacy and Usage). ADRs read in full or in part: 0017 (Devin amendment, line 78), 0079 (amendments, lines 37, 47, 65, 69), 0080 (opening), 0087 (in full), 0016 and 0038 (openings), 0029 and 0068 (openings). Not read beyond titles: 0002, 0004, 0014, 0026, 0037, 0045, 0047, 0072, 0081, 0089, 0090, 0091.

## Contract baseline

`tests/integration/adapterContract.ts` runs one suite against each adapter's fixture (`tests/integration/adapterContract.test.ts:27-38`, `claudeAdapter.test.ts:4`, `devinAdapter.test.ts:13`, `grokAdapter.test.ts:7`, `museAdapter.test.ts:9`, `opencodeAdapter.test.ts:16`). A feature the contract requires counts as supported for every provider that does not skip it.

**Required of every adapter (no real adapter skips these):**

- Create a project and a thread, stream a reply, and go from running to idle (`adapterContract.ts:89`).
- Observe a takeover typed in the provider and reject a reply built on stale input (`:70`).
- Send a prompt once, on the send stopwatch (`:80`), with one `message-added` (`:103`).
- Hand a refresh back without messages to a caller that keeps history from events (`:132`).
- Write short text on the side, or write nothing and say so (`:145`, ADR-0026).
- Cancel a running turn (`:193`).
- Route a question and deliver its answer (`:215`).
- Never approve a skipped permission when interrupted and disconnected (`:233`).
- Reconcile an uncertain prompt acknowledgement without resending (`:240`).
- Resume the same thread and messages after a restart during a run (`:247`).
- Start a session lazily, stop idle sessions, and never stop a running or watched one (`:304-414`).

**Conditional:** staged images, refused before any byte is read when the model does not support them (`:170-192`); ordinary permission routing, only with a Watcher profile (`:57`).

**Skips per provider** (`tests/fixtures/*Fixture.ts`):

| Provider | Skips declared |
| --- | --- |
| claude | none (`tests/fixtures/claudeFixture.ts:9`) |
| codex | `backgroundWork`, `liveSettings` (`codexFixture.ts:11-14`) |
| grok | `backgroundWork`, `liveSettings`, `settingsConfirmation` (`fakeGrokThreadFixture.ts:9-13`) |
| devin | `backgroundWork`, `liveSettings`, `settingsConfirmation`, `clientUpdate` (`devinFixture.ts:9-14`) |
| muse | `backgroundWork`, `liveSettings`, `settingsConfirmation` (`museFixture.ts:9-13`) |
| opencode | `backgroundWork`, `liveSettings`, `sendAnswerRunning` (`fakeOpenCodeFixture.ts:10-15`) |

`sendAnswerRunning` changes only the wait after a send: OpenCode echoes the prompt before it answers, so "running" follows in the next publish (`tests/integration/hostServiceContract.ts:28-30`). Claude is the only provider that runs the background-work contract (`:198`) and the live-settings contract (`:454-502`). Live settings for OpenCode are tested in `opencodeAdapter.test.ts`, which the skip note names.

**Left to each adapter:** steering, queueing (a Sotto queue, `src/main/agents/control.ts:2634`), compaction, model and effort choice, permission-mode set, skills, slash commands, monitors and subagent rows, delegation, babysitting, worktree creation, usage, history import, activity content. The contract runs against fakes of each provider's protocol. A fake proves Sotto's side. The live suites are gated by `SOTTO_*_LIVE` and never run in CI (AGENTS.md).

## Matrix

Every feature cell starts with its status word, then the citation in backticks. `—` appears only in bug rows, for a provider the row is not about. The 25 feature rows of the brief are kept. None is meaningless on main.

### Turns

| Row | claude | codex | grok | devin | muse | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Starting a thread | supported `src/main/agents/claude.ts:892` | supported `src/main/agents/codex.ts:1539` | supported `src/main/agents/grok.ts:1066` | supported `src/main/agents/devin.ts:876`; saved after first prompt `docs/agent-control.md:30` | supported `src/main/agents/muse.ts:1313`; Owl `src/main/agents/museGate.ts:8` | supported `src/main/agents/opencode.ts:1366`; Owl `src/shared/owlFeatures.ts:23` |
| Sending | supported `src/main/agents/claude.ts:944` | supported `src/main/agents/codex.ts:1770` (`turn/start`) | supported `src/main/agents/grok.ts:1203`; `session/prompt` at `grok.ts:1253` | supported `src/main/agents/devin.ts:999`; text only `src/main/agents/devin.ts:490` | supported `src/main/agents/muse.ts:1436` | supported `src/main/agents/opencode.ts:1449`; one execution can carry several prompts `docs/adr/0087-opencode-is-a-thread-provider.md:51` |
| Queueing a message while a turn runs | supported `src/main/agents/control.ts:2634` (Sotto's follow-up queue) | supported `src/main/agents/control.ts:2634` | supported `src/main/agents/control.ts:2634` | supported `src/main/agents/control.ts:2634`; text only `src/main/agents/devin.ts:948` | supported `src/main/agents/control.ts:2634` | supported `src/main/agents/control.ts:2634` |
| Steering mid-turn | supported `src/main/agents/claude.ts:1010`; `steerTurn` ADR-0075 | supported `src/main/agents/codex.ts:1660`; `turn/steer` at `codex.ts:1694` | missing `src/main/agents/grok.ts:1054` refuses; no steer method found in Grok docs, which are unreachable | missing `src/main/agents/devin.ts:948` refuses; `devin.ts:261` steer false | supported `src/main/agents/muse.ts:1436`; `turn/steer` at `muse.ts:1504` | supported `src/main/agents/opencode.ts:1489` (steer delivery); `docs/adr/0087-opencode-is-a-thread-provider.md:51` |
| Stop and interrupt | supported `src/main/agents/claude.ts:1066` | supported `src/main/agents/codex.ts:1714` (`turn/interrupt` at `codex.ts:1718`) | supported `src/main/agents/grok.ts:1285` | supported `src/main/agents/devin.ts:979` | supported `src/main/agents/muse.ts:1590` | supported `src/main/agents/opencode.ts:1536` |
| Compaction | supported `src/main/agents/claude.ts:922` (`/compact` at `claude.ts:935`; gated on init `compact` at `claude.ts:1416`) | supported `src/main/agents/codex.ts:1589` (`thread/compact/start` at `codex.ts:1599`) | unverified `src/main/agents/grok.ts:1053` refuses; Grok docs unreachable | missing `src/main/agents/devin.ts:948` refuses; `devin --help` (3000.10.31) lists no compact | supported `src/main/agents/muse.ts:1599` (`session/compact` at `muse.ts:1604`) | missing `src/main/agents/opencode.ts:323` (`compact: false`); no compaction route read on 2.0.31 |

### Requests and choices

| Row | claude | codex | grok | devin | muse | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Question cards | supported `src/main/agents/claude.ts:144` (AskUserQuestion instruction) | supported `src/main/agents/codex.ts:87` (`request_user_input`); server request `item/tool/requestUserInput` in the 0.163.0 schema | supported `src/main/agents/grok.ts:61` (`ask_user_question`) | partial no question instruction, `docs/agent-control.md:64` | partial no question instruction, `docs/agent-control.md:64` | supported `src/main/agents/opencodeRequests.ts:37` (forms drawn as question cards); undrawable forms cancelled at `opencodeRequests.ts:43` |
| Permission cards | supported `src/main/agents/claudeRequests.ts:38` (Allow once, Deny) | supported `src/main/agents/codexRequests.ts:70` (Allow, Deny; Allow once at `:97`) | supported `src/main/agents/grokRequests.ts:46` (choices from ACP kinds) | partial `src/main/agents/devinRequests.ts:101` (Allow once, Deny only) | supported `src/main/agents/muse.ts:395` (`approval/decide`) | supported `src/main/agents/opencodeRequests.ts:62` (Allow once, Reject, with the files and diff) |
| Permission modes (and the new-thread default) | supported four modes `src/main/agents/claude.ts:76`; live change `claude.ts:136-140`; full access at launch only `claude.ts:150-153`; default `src/shared/newThreadDefaults.ts:43` | supported all four `src/main/agents/codex.ts:541`; change `codex.ts:1609` | partial three modes, no auto-accept-edits `src/main/agents/grok.ts:52` | partial Devin's own modes plus Ask first `src/main/agents/devin.ts:104`; a change stops the session `docs/agent-control.md:28` | partial approval-required until the connect probe passes `src/main/agents/muse.ts:440`, `:549` | partial three modes, no Automatic `src/main/agents/opencode.ts:72`, `:77` |
| Model picker | supported `src/main/agents/claude.ts:539` (CLI account models); live change `claude.ts:136` | supported `src/main/agents/codex.ts:541`; `model/list` in the 0.163.0 schema | partial no model change after creation `src/main/agents/grok.ts:360` | partial chosen at creation `src/main/agents/devin.ts:261` (`configureThreadModel` false) | supported `src/main/agents/muse.ts:452` (`configureThreadModel` true) | supported `src/main/agents/opencode.ts:782` (models under sources); `src/renderer/src/agents/ModelPicker.tsx:59` |
| Effort picker | supported levels from the CLI `src/main/agents/subscriptionClaude.ts:174`; live `claude.ts:138` | supported `src/main/agents/codex.ts:539` | partial levels `src/main/agents/grok.ts:530`; locked after the first message, #228 | unverified `src/main/agents/devin.ts:490` (no levels; 3000.10.31 help had no effort option; 3000.11.92 not checked) | supported `src/main/agents/muse.ts:540` | supported `src/main/agents/opencode.ts:783` (model variants as efforts) |

### Work

| Row | claude | codex | grok | devin | muse | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Background work and monitors | supported monitors `src/main/agents/claudeMonitoring.ts:6`; background work `src/main/agents/claude.ts:501` | partial subagent items `src/main/agents/codexActivity.ts:187`; no background-work path | partial subagent rows `src/main/agents/grokActivity.ts:58`; no monitor | missing no background driver `tests/fixtures/devinFixture.ts:10`; no subagent rows | partial subagent and workflow rows `src/main/agents/museActivity.ts:114`, `:120` | missing `tests/fixtures/fakeOpenCodeFixture.ts:11` (reports no work a turn leaves running) |
| Delegation (starting or asking another thread) | supported `src/main/agents/delegation.ts:506`; Owl `src/shared/owlFeatures.ts:19` | supported `src/main/agents/delegation.ts:506`; `src/main/agents/codex.ts:80` | supported `src/main/agents/grok.ts:267` | supported `src/main/agents/devin.ts:350`; attaches on CLI 3000.11.92, `docs/adr/0017-devin-native-provider-data-policies.md:78`; no live turn run | supported `src/main/agents/muse.ts:345`; `docs/adr/0079-muse-is-a-thread-provider.md:49` | supported `src/main/agents/opencodeTools.ts:38`; `src/main/agents/delegation.ts:506` |
| PR babysitting | supported `docs/agent-control.md:183`; `src/main/agents/claude.ts:1337` | supported `docs/agent-control.md:183`; `src/main/agents/codex.ts:80` | supported `docs/agent-control.md:183`; `src/main/agents/grok.ts:267` | supported `docs/agent-control.md:183`; owned profiles allow `mcp__sotto_pull_requests__*`, `docs/adr/0017-devin-native-provider-data-policies.md:78` | supported `docs/agent-control.md:183`; `src/main/agents/muse.ts:345` | supported `docs/agent-control.md:183`; `src/main/agents/opencodeTools.ts:38` |
| Resume after restart | supported `tests/integration/adapterContract.ts:247`; Owl `src/shared/owlFeatures.ts:16` | supported `tests/integration/adapterContract.ts:247`; Owl `owlFeatures.ts:16` | supported `tests/integration/adapterContract.ts:247`; Owl `owlFeatures.ts:16` | supported `tests/integration/adapterContract.ts:247`; resumes on open `docs/agent-control.md:30` | supported `tests/integration/adapterContract.ts:247`; dormant rule `docs/agent-control.md:80` | supported `tests/integration/adapterContract.ts:247`; `docs/adr/0087-opencode-is-a-thread-provider.md:51` |
| History import | missing `docs/agent-control.md:42`; open #669 names Claude Code | missing `docs/agent-control.md:42` | missing `docs/agent-control.md:42`; open #669 names Grok Build | missing `docs/agent-control.md:42` | missing `docs/agent-control.md:42` | missing `docs/adr/0087-opencode-is-a-thread-provider.md:23`; the user's own OpenCode never sees Sotto's sessions |
| Activity rows (tools, diffs, thinking) | supported `src/main/agents/claudeActivity.ts:144` (command and file-change kinds) | supported `src/main/agents/codexActivity.ts:189-191` (command, file-change, reasoning) | supported `src/main/agents/grokActivity.ts:96` (diffs); thinking `grokActivity.ts:10` | supported thinking `src/main/agents/devinActivity.ts:10`; edits and diffs `devinActivity.ts:41` | supported `src/main/agents/museActivity.ts:82` (tool); reasoning `museActivity.ts:92` | supported `src/main/agents/opencodeActivity.ts:47` (tools), `:56` (commands), `:61` (file changes), `:85` (reasoning) |
| Usage and cost | supported account limits `src/main/agents/claude.ts:444`; Owl `src/shared/owlFeatures.ts:15` | supported account limits `src/main/agents/codex.ts:379`; Owl | partial limits `src/main/agents/grok.ts:368`; no token counts on the computer, `README.md:102` | missing `README.md:102` (Devin's limits remain unavailable) | partial token counts `src/main/agents/muse.ts:116`; outside this dashboard, `README.md:102` | partial per-turn tokens `src/main/agents/opencode.ts:1287`; outside numeric history, `docs/adr/0087-opencode-is-a-thread-provider.md:57` |

### Inputs and tools

| Row | claude | codex | grok | devin | muse | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Attachments and images | supported `src/main/agents/claude.ts:539` (`supportsImages: true`) | supported `src/main/agents/codex.ts:541` (input modalities) | unverified `src/main/agents/grok.ts:535` (false); CLI 1.0.5 reported no image input, `docs/agent-control.md:70`; 1.0.62 not retested | unverified `src/main/agents/devin.ts:490` (false); no provider source read | supported `src/main/agents/muse.ts:539` | supported `src/main/agents/opencode.ts:782` (per model input) |
| Slash commands and skills | supported `src/main/agents/claude.ts:435` (skills true); `$` and `/` at `src/renderer/src/agents/composerSkills.ts:24` | partial `src/main/agents/codex.ts:368` (skills true); `$` only at `composerSkills.ts:24` | supported `src/main/agents/grok.ts:360` (skills true); `$` and `/` at `composerSkills.ts:24` | missing `src/main/agents/devin.ts:261` (skills false); native slash commands unavailable `docs/agent-control.md:28` | missing `src/main/agents/muse.ts:452` (skills false); `src/renderer/src/agents/ProvidersSettings.tsx:230` | missing `src/main/agents/opencode.ts:323` (skills false) |
| Worktrees | partial a spare runs in the thread's folder and is adopted on the first send `src/main/agents/claude.ts:188`; `docs/agent-control.md:48` | supported Codex starts its own, `docs/agent-control.md:48` | supported Grok starts its own, `docs/agent-control.md:48` | missing starts nothing for a new thread, `docs/agent-control.md:48` | unverified `src/main/agents/muse.ts:32` imports the helper; no doc | unverified `src/main/agents/opencode.ts:34` imports the helper; no doc |
| Remote hosts on forge | supported `docs/verification/2026-09-28-agent-host-setup.md:10` (a Claude thread on forge) | unverified no forge note names a Codex thread running on forge | unverified no forge note names a Grok thread running on forge; floor only, `docs/verification/2026-09-28-host-provider-agent.md:34` | partial install and tile checked on forge, `docs/verification/2026-09-28-host-provider-agent.md:7`; Apple silicon pending `docs/agent-control.md:22` | unverified two forge notes mention Muse; none checked | partial a forge check over a fixture server, `docs/verification/2026-10-17-opencode-hosts-and-phones.md:25` |

### Watcher and Owl

| Row | claude | codex | grok | devin | muse | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Watcher as orchestrator | supported Owl `src/main/agents/claude.ts:1337`; UserPromptSubmit hook `docs/agent-control.md:189` | supported Owl `src/main/agents/codex.ts:80`; `turn/start` additionalContext `docs/agent-control.md:189` | partial Owl `src/main/agents/grok.ts:263`; the note is one prompt line, no channel `docs/agent-control.md:189` | missing refused `src/main/agents/devin.ts:214` ("Devin cannot host Watcher") | supported Owl `src/main/agents/muse.ts:192`; Watcher on Muse needs the `sessionMcp` grant and Muse 1.4.7 or newer, `docs/adr/0079-muse-is-a-thread-provider.md:69` | missing refused before any process starts `src/main/agents/opencode.ts:411` |
| Watcher sending to that provider (send to an existing thread; start path not read) | supported Owl `src/main/agents/watcherRoomInput.ts:11` | supported Owl `src/main/agents/watcherRoomInput.ts:11` | supported Owl `src/main/agents/watcher.ts:1014` (grok prompt display) and `watcherRoomInput.ts:11` | supported Owl `src/main/agents/watcherRoomInput.ts:11`; Devin cannot host Watcher | supported Owl `src/main/agents/watcherRoomInput.ts:11` | supported Owl `src/main/agents/watcherRoomInput.ts:11`; start path not read |
| Owl feature gates | supported `src/shared/owlFeatures.ts:13` (Watcher, usage, resume are Owl; the provider is stable) | supported `src/shared/owlFeatures.ts:13` | supported `src/shared/owlFeatures.ts:13` | supported `src/shared/owlFeatures.ts:19` (delegation is Owl; Devin is stable) | supported `src/main/agents/museGate.ts:8`; `src/shared/owlFeatures.ts:14` | supported `src/shared/owlFeatures.ts:23`; `docs/adr/0087-opencode-is-a-thread-provider.md:13` |

### Known bugs

Bug rows name the provider in the label. The named provider's cell is `partial` (or `unverified` where no line was located). `—` means the row is not about that provider.

| Row | claude | codex | grok | devin | muse | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Claude: a thread can run in a permission mode other than the one shown (#657) | partial `src/main/agents/claude.ts:136-140` | — | — | — | — | — |
| Claude: prompts typed into the CLI are not shown in the thread (#396) | partial `tests/integration/adapterContract.ts:70` | — | — | — | — | — |
| Claude: compaction left a thread not busy until Claude Code answers (open PR #1179) | partial `src/main/agents/claude.ts:921-922` | — | — | — | — | — |
| Claude and Codex: read-before-send leftovers (#807) | unverified no Claude line located | partial `src/main/agents/codex.ts:311` | — | — | — | — |
| Grok: effort chip locked after the first message (#228) | — | — | partial `src/main/agents/grok.ts:360` | — | — | — |
| Grok: idle session outlasts the contract's stop wait (#853) | — | — | partial `tests/integration/adapterContract.ts:193` | — | — | — |
| Grok: thinking rows around disconnects and long threads (#810) | — | — | partial `src/main/agents/grokActivity.ts:10` | — | — | — |
| Devin: follow-up after an uncertain prompt answers early (#1130) | — | — | — | partial `src/main/agents/devin.ts:999` | — | — |
| Devin and Muse: no reconnect after signing in on a host (#1092) | — | — | — | unverified no line located | unverified `src/renderer/src/agents/ProvidersSettings.tsx:154` (a Muse reconnect exists; not checked against #1092) | — |
| OpenCode: host contract reads idle right after a send on Linux CI (#1165) | — | — | — | — | — | partial `tests/fixtures/fakeOpenCodeFixture.ts:14` |

## Gaps, ranked by daily use

Ranked by what Zach would notice in a normal day. Each gap says whose limit it is: the provider's, Sotto's, or unknown until a probe. Section "Gaps main has closed" below lists what the earlier note had and main no longer has.

**G1. A native session started outside Sotto cannot be seen or attached.** All six providers have no import path (`docs/agent-control.md:42`). Open #669 names Claude Code and Grok Build.
- What the user sees: a conversation run in the Claude Code terminal never appears on the Threads page, and there is no way to attach to it.
- Work: a provider-neutral list-and-attach pair on the host interface, filled in per adapter. Claude: `src/main/agents/claudeHistory.ts` reads a transcript by session ID, and `--resume` finds a session by ID in any project on the machine (`code.claude.com/docs/en/headless`). Codex: `thread/list` is in the 0.163.0 schema. Devin: `devin --resume [SESSION_ID]` is in `devin --help`, and the Devin CLI research note cites `devin list --format json` for discovery (`docs/research/2026-09-19-devin-cli-integration.md:18`, not re-run). OpenCode: its own sessions are kept apart on purpose (`docs/adr/0087-opencode-is-a-thread-provider.md:23`), so an OpenCode attach would need that decision reversed first.
- Risk: `README.md:102` says Usage reads other apps' session files and keeps only counts, with no prompt, reply, title or path. Attaching a session would read its text, so the README promise changes with it. One provider process per thread (ADR-0038) means an attached session must not run in a second process at once.
- Limit: Sotto work. Claude and Codex expose what is needed. Grok: unverified.

**G2. Steering is missing for Grok and Devin.** Providers: Grok, Devin.
- What the user sees: no "Steer now". A queued message waits until the turn ends. Claude, Codex, Muse and OpenCode steer.
- Work: `src/main/agents/grok.ts:1054` and `src/main/agents/devin.ts:948` refuse steer. A live probe comes first, to see whether Grok's ACP and Devin's ACP accept input during a running prompt. Then a contract case "steers a running turn when declared" for all six. Fixtures: `tests/fixtures/fakeGrokThreadFixture.ts`, `tests/fixtures/devinFixture.ts`.
- Risk: a steer the provider holds without reading (ADR-0065). Unconfirmed delivery needs the same reconciliation.
- Limit: unknown. Grok docs are unreachable. Devin's ACP docs found cover Devin Desktop, not the CLI.

**G3. The compaction banner is Claude only.** Codex and Muse have manual compaction; Grok, Devin and OpenCode have none.
- What the user sees: on a long Codex or Muse thread, the banner never suggests compacting. The manual "Compact context" item exists (`src/renderer/src/agents/ThreadPane.tsx:230`).
- Work: `src/renderer/src/agents/ThreadCompaction.tsx:50` checks `thread.providerId === 'claude'`. Replace it with the `compact` capability and the thread's reported context. Codex reports context through its ledger (`src/main/agents/codex.ts:1211`).
- Risk: the 100,000-token threshold and the age rule were tuned for Claude. Low otherwise.
- Limit: Sotto work. An affordance on an existing surface needs no mock-up (AGENTS.md). Whether it is a fix or a feature is Zach's call.

**G4. Background work and monitors exist only for Claude.** Providers: Codex, Grok, Devin, Muse, OpenCode.
- What the user sees: Claude threads show the monitoring and background-work creature (`docs/agent-control.md:36-40`). A long background command in another provider looks idle.
- Work: the Codex app-server docs list `thread/backgroundTerminals/list`, `clean` and `terminate`. The installed 0.163.0 schema does not contain them, so either the docs are ahead of this install or newer than the target. Confirm on a newer client before building. Grok, Devin, Muse and OpenCode need provider evidence first.
- Risk: the rule is never restored from transcripts or cached threads (`docs/agent-control.md:40`). Keep it that way.
- Limit: Codex: Sotto work if the method exists in a newer client. Others: unverified.

**G5. Permission choices are narrower on Devin, Muse, Grok and OpenCode.** Devin offers its own modes plus Ask first, and a change stops the session (`docs/agent-control.md:28`). Devin's permission cards offer only Allow once and Deny (`src/main/agents/devinRequests.ts:101`). Muse offers only `approval-required` until the connect probe passes (`src/main/agents/muse.ts:440`). Grok has no auto-accept-edits (`src/main/agents/grok.ts:52`). OpenCode has no Automatic (`src/main/agents/opencode.ts:72`), because none of OpenCode's own modes matches it.
- What the user sees: a shorter mode menu. On Devin, changing mode restarts the session.
- Work: Devin's CLI lists `auto`, `accept-edits`, `smart` and `dangerous` (`devin --help`, 3000.10.31). Sotto's profile decides which it offers (ADR-0022). Muse's probe depends on the MSP host. Grok: unverified. OpenCode: a mapping for Automatic would need a new rule set, checked against Zen's refusals (`docs/adr/0087-opencode-is-a-thread-provider.md:37`).
- Limit: mixed. The modes are the provider's; which ones Sotto allows is Sotto's profile.

**G6. Models and efforts are locked after creation on Grok and Devin.** The model chip and effort chip cannot change on a running thread.
- What the user sees: Grok's effort chip is locked after the first message (#228). Devin's model chip is locked.
- Work: Devin's CLI says `--model` "switches the resumed conversation to this model" (`devin --help`, with `-c` or `-r`). A model switch could ride the existing restart path. `src/main/agents/devin.ts:261` declares `configureThreadModel: false`, and `docs/agent-control.md:30` describes what a Devin restart may do. Grok: `src/main/agents/grok.ts:360` declares the same; no provider source read.
- Risk: Devin can reload under a different model if killed before a clean shutdown (`docs/agent-control.md:30`). The switch must go through the same refusal.
- Limit: Devin: Sotto work. Grok: unverified.

**G7. Devin's Sotto tools are attached in code but no live turn has run them.** Devin gets Sotto's tools from CLI 3000.11.92 (`docs/adr/0017-devin-native-provider-data-policies.md:78`), and a Devin thread says whether its tools were given (`src/main/agents/devin.ts:298`, `:347`).
- What the user sees: on an older Devin, or a host that does not say it gives tools, a Devin thread has no browser, visual, babysitting or delegation tools, and says so.
- Risk: the amendment's check ran against the 3000.11.92 zip unpacked on Windows, and "No `session/prompt` was sent, and no Devin turn ran" (ADR-0017, same section). A thread that calls one of Sotto's tools is not yet shown.
- Work: a live turn with a Sotto tool on the pinned 3000.11.92 client, under `SOTTO_DEVIN_LIVE` (name to be confirmed in `tests/integration`), and a unit case for the no-tools path.
- Limit: unverified until that turn runs.

**G8. Questions are not requested of Devin or Muse.** Neither gets a question-tool instruction (`docs/agent-control.md:64`, ADR-0080). A question written into a reply is folded and shows only as a lifted question.
- What the user sees: a question for Devin or Muse may never reach a card.
- Work: ADR-0080 lifts questions out of folded replies, and `docs/agent-control.md:64` says those are for reading, not requests. Turning them into cards would reverse that part of it. The other route is a native question channel; neither provider's read surface was checked for one.
- Limit: unverified for both.

**G9. Images: Grok takes none; Devin unverified.** `src/main/agents/grok.ts:535` sets `supportsImages: false`. `docs/agent-control.md:70` says the ACP reported no image input at CLI 1.0.5. The installed CLI is 1.0.62, not retested.
- Work: a probe on 1.0.62. If the ACP takes image content, flip the flag. The contract's image case is already conditional (`tests/integration/adapterContract.ts:170-192`).
- Limit: provider, possibly fixed in a newer client. Devin: unverified.

**G10. Skills and slash commands: Devin, Muse and OpenCode have none; Codex offers `$` only.** `src/main/agents/devin.ts:261`, `src/main/agents/muse.ts:452`, `src/main/agents/opencode.ts:323` (skills false). `src/renderer/src/agents/composerSkills.ts:24` gives Claude and Grok `/` and Codex `$` only.
- Work: Codex's `/` forms are not in app-server, which was not confirmed. Devin, Muse and OpenCode: none found.
- Limit: unverified for Devin, Muse and OpenCode.

**G11. Usage limits.** Devin: Sotto cannot read its limits and Devin keeps none on the computer (`README.md:102`). Muse: token counts only, outside the dashboard (`README.md:102`). OpenCode: a per-turn readout (`src/main/agents/opencode.ts:1287`), outside numeric history (`docs/adr/0087-opencode-is-a-thread-provider.md:57`). Grok: limits read, but its token counts are not kept (`README.md:102`).
- Limit: Devin's limits are Devin's to expose. Muse and OpenCode: a Sotto choice made in Owl, reversible by Usage's own work (ADR-0078).

**G12. Watcher hosting.** Devin refuses to host Watcher (`src/main/agents/devin.ts:214`). OpenCode refuses before any process starts (`src/main/agents/opencode.ts:411`), because it cannot yet take Watcher's tools or keep approvals with the user (`src/main/agents/opencode.ts:407`; `docs/adr/0087-opencode-is-a-thread-provider.md:57`). Grok passes its note as one prompt line, with no channel (`docs/agent-control.md:189`). Owl only. Low for stable.

**G13. Claude's worktree is partial.** A spare runs in the thread's folder and is adopted on the first send (`src/main/agents/claude.ts:188-197`); `docs/agent-control.md:48` describes the same. The first send creates a new thread's worktree, and the spare does not. Code behaviour was not traced past the adoption rule.

**G14. Remote hosts on forge: Codex, Grok and Muse have no forge note showing a thread running on forge; Devin and OpenCode are partial.** Devin's install and tile were checked on forge (`docs/verification/2026-09-28-host-provider-agent.md:7`). OpenCode's forge check ran against a fixture server (`docs/verification/2026-10-17-opencode-hosts-and-phones.md:25`), not the real client.
- Work: one real thread per provider on forge, recorded in a verification note.

## Gaps main has closed

These were in the earlier HEAD note and are not gaps on main. Each cites its change.

- **Devin's Sotto tools (old G7).** Closed by the ADR-0017 amendment of October 16, 2026 (#1040). Devin's floor moved to 3000.11.92 (`src/main/agents/devinRpc.ts:15`), and its threads are given Sotto's servers (`src/main/agents/devin.ts:298`). What remains is G7 above: no live turn has run them yet.
- **Muse's Sotto tools.** Closed by the ADR-0079 amendment of October 14 (#1039). Muse gets the browser, visual, babysitting and delegation servers (`src/main/agents/muse.ts:342-345`).
- **Watcher on Muse (old G13, Muse half).** Closed by the ADR-0079 amendment of October 16: Watcher runs on Muse, when the client grants `sessionMcp` and the Muse version is 1.4.7 or newer (`docs/adr/0079-muse-is-a-thread-provider.md:69`).
- **The Muse support text is still stale.** `src/renderer/src/agents/ProvidersSettings.tsx:230` still says "Sotto's browser tools, Watcher and skills are unavailable" for Muse. The first two clauses are closed by the amendments above. The skills clause still holds (`src/main/agents/muse.ts:452`, `skills: false`). This is a text fix, not a gap.
- **Devin's effort "impossible".** The earlier note marked this impossible from the 3000.10.31 help. On main the floor is 3000.11.92, which was not checked, so the cell is now `unverified`.

## Hard limits

These are the provider's. Each names its source, or says the limit comes from Sotto's own reading.

- **Codex steering needs an active turn.** `turn/steer` takes an `expectedTurnId`, must match the running turn, and fails when none is active. Source: the installed 0.163.0 schema and the app-server docs (`learn.chatgpt.com/docs/app-server`).
- **Codex compaction is one client request.** `thread/compact/start` returns `{}` at once, and progress arrives as notifications, including a `contextCompaction` item (same docs). Sotto reads it (`src/main/agents/codex.ts:1599`).
- **Claude full access is set at launch.** Sotto's claim: changing into or out of full access restarts the session (`src/main/agents/claude.ts:150-153`). The Agent SDK says `bypassPermissions` at startup or later through `setPermissionMode()` needs `allowDangerouslySkipPermissions: true` (`code.claude.com/docs/en/agent-sdk/typescript`). The docs do not say "only at launch", so this is only partly a provider limit.
- **Claude's `-p` runs stop background work after 10 minutes of idle waiting** unless `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` says otherwise (`code.claude.com/docs/en/headless`). Sotto's stream-json session is not `-p` in this sense, so this is noted, not counted.
- **Muse waits 300 seconds for a tool call, and that cannot be changed.** Measured by Sotto against Muse 1.4.8, recorded in `docs/adr/0079-muse-is-a-thread-provider.md:61`. Muse 1.4.9's catalog is newer and was not re-measured. Browser and visual waits are cut short by it.
- **Muse's startup permission mode is sealed.** A mode above it is refused (`src/main/agents/muse.ts:545`). Sotto's probe result.
- **Muse and Devin cannot take a one-off side call that stays out of their session list.** Sotto's claim (`src/shared/agents.ts:995`, which leaves them out of the short-text set).
- **Devin keeps a session open for another client.** A session open in another native client must be released before Sotto can resume it (`docs/agent-control.md:30`). Provider behaviour, as Sotto observed it.
- **Grok did not report image input at CLI 1.0.5.** Sotto's verification (`docs/agent-control.md:70`). Not retested on 1.0.62.
- **OpenCode ignores the end of its input, so it cannot be stopped the way Muse and Grok stop when Sotto goes.** Its tools outlive it, so Sotto ends them itself (`docs/adr/0087-opencode-is-a-thread-provider.md:5`).
- **OpenCode Zen's free models refuse a session whose rules take a tool away** (`docs/adr/0087-opencode-is-a-thread-provider.md:37`), and refuse the generation route with a 503 that names the model source (`docs/adr/0087-opencode-is-a-thread-provider.md:55`). Checked against 2.0.31. Side text is not written on those models.
- **OpenCode's processes are not locked to one process, so Sotto drives a provider session only from its own thread's server** (`docs/adr/0087-opencode-is-a-thread-provider.md:23`). Provider behaviour.
- **Unknown, not counted as hard.** Grok's compaction, steering and ACP cancel; Muse's protocol method names; the Codex background-terminal methods. Open probes, not limits.

## Staged plan

Nothing here is built. Each stage is a proposal for Zach to accept or cut. Seam vocabulary follows the codebase-design skill: a deep module hides a policy behind a small interface; a seam is where behaviour is swapped; leverage is what one interface buys; locality is what stays in one place.

**Stage 0. Make the text true.** Fix `src/renderer/src/agents/ProvidersSettings.tsx:230` (Muse's browser tools and Watcher are available now, ADR-0079 amendments). Seam: none. Tests: the doc and string tests that read those lines. ADR: none. Stable.

**Stage 1. One provider profile, read everywhere.** Per-provider rules are now spread across `src/shared/agents.ts` (`SHORT_TEXT_PROVIDERS` at `:995`, `SOTTO_TOOLS_PROVIDERS` at `:1011`), `src/renderer/src/agents/composerSkills.ts:24`, `ThreadCompaction.tsx:50`, `ModelPicker.tsx:59`, and the held-provider list in `src/shared/workerRoles.ts:120`. Gather them into one profile record per provider, read by main and the renderer. Seam: a `ProviderProfile` deep module in `src/shared/`, with capabilities, question instruction, skill sigils, short-text policy, tool transport, image flag, and Owl gate. Leverage: adding a provider is one record. Closes G3 for Codex, and for Muse once Muse reports context (the banner). It only moves the skill sigils into the profile; G10 stays open until Devin, Muse and OpenCode have skills (Stage 7). Tests: a unit test for the profile; a contract case that each adapter's declared capabilities equal its profile, in `tests/integration/adapterContract.ts`. Verification: unit; `compact-pane-and-request-layout.spec.ts` for the banner. ADR: a short ADR for the profile seam. Stable.

**Stage 2. Steering for Grok and Devin, if a probe allows it.** Live probe first; then wire the provider's input-during-turn call, or record that it has none. Seam: the existing `steer` capability and `steerTurn`. Contract case "steers a running turn when declared; otherwise refuses with the queue hint" for all six. Closes G2. Tests: fixture steer support in `fakeGrokThreadFixture.ts` and `devinFixture.ts`; `grokAdapter.test.ts` and `devinAdapter.test.ts`. Verification: live probe under the `SOTTO_*_LIVE` gate; Playwright `queued-steering.spec.ts` and `claude-steer.spec.ts`. ADR: only if the call is new. Fix or feature: Zach decides (open question 2).

**Stage 3. Devin tools, proved live.** Run one turn with a Sotto tool on the pinned 3000.11.92 client, and a no-tools case for an older client or a host that does not say it gives tools. Seam: `sottoToolsGiven` on the thread (`src/main/agents/devin.ts:298`). Closes G7. Tests: the live turn under `SOTTO_DEVIN_LIVE` (name to be confirmed); a unit case for the no-tools path. Verification: integration with `tests/fixtures/devinFixture.ts`. ADR: none new; the ADR-0017 amendment already covers the policy.

**Stage 4. Codex background terminals, if a newer client has them.** Confirm `thread/backgroundTerminals/list` on a newer Codex. If present, read it and publish as background work with no transcript restore. Seam: `src/shared/agentMonitoring.ts`, already provider-neutral; remove the codex `backgroundWork` skip once the driver exists in `codexFixture.ts`. Closes G4 for Codex. Tests: contract case at `adapterContract.ts:198`; `codexActivity` unit tests. Verification: unit and integration; check `tests/e2e` for an existing monitoring spec before adding one. Owl or stable: Zach decides.

**Stage 5. Native session list and attach.** A provider-neutral pair on the host interface: list native sessions for a project, attach one as a Sotto thread. Claude and Codex first; Devin and Grok after probes; OpenCode only if Zach reverses ADR-0087's separate-folder rule. Seam: a new host operation, filled per adapter. `claudeHistory.ts` and `claudeOriginJournal.ts` are the Claude starting points. Closes G1. Tests: contract cases; origin-journal unit tests; a fixture with a session the fake did not start. Verification: unit, integration, a new Playwright spec, and a live check on Claude. ADR and README: both required first, since `README.md:102` promises counts only. Owl or stable: Zach decides.

**Stage 6. Devin model change by resume.** A model change on a Devin thread restarts the session with `--model` and keeps the Sotto identity. Seam: `configureThreadModel` in the profile (Stage 1); the restart path already exists (`docs/agent-control.md:30`). Closes G6 for Devin; Grok stays open until a probe. Tests: a restart case in `devinFixture`; a refusal case for a session killed before shutdown. Verification: integration; `devin-provider.spec.ts`. ADR: amend the Devin restart rule. Fix or feature: Zach.

**Stage 7. Images, skills and OpenCode's gaps, after probes.** Re-test Grok 1.0.62 images (G9); Devin images; Codex `/` forms (G10); skills for Devin, Muse and OpenCode only if their protocols offer them. Seam: the profile's image flag and sigils. Tests: the conditional image case (`adapterContract.ts:170-192`) and skill unit tests. Verification: `provider-native-skills.spec.ts`. ADR: none unless a new surface appears.

**Stage 8. OpenCode: compaction, Watcher and usage, probed.** Read OpenCode 2's routes for compaction and for Watcher's approvals; decide whether OpenCode's per-turn readout joins Usage's numeric history (ADR-0078). Seam: the profile (Stage 1) and the OpenCode adapter's route table. Closes OpenCode's G3 and G12 entries if the routes exist. Tests: contract cases for the new route; `opencodeAdapter.test.ts`. Verification: live check under the `SOTTO_OPENCODE_LIVE` gate (name to be confirmed). ADR: Watcher on OpenCode needs an ADR, as Watcher on Muse did. Owl: Zach decides.

Not staged: Devin and Muse question instruction (G8) waits on Zach (open question 6). Muse and OpenCode forge checks (G14) need a real thread on forge, which is a verification task, not a build stage.

## Open questions

1. Basis: is `origin/main` `339378ce2` the basis for decisions, and the earlier HEAD note retired?
2. Steering for Grok and Devin (G2): a fix to stable, or a new feature to Owl? The answer depends on a live probe.
3. Devin tools (G7): is a live Devin turn with a Sotto tool enough before the Owl gate lifts, or does Zach want it on a second machine too?
4. History import (G1): list and attach only, or also copy the native conversation into Sotto's record? This needs an ADR and a README change either way.
5. Is the attach and background-work family (#669, Stages 4 and 5) Owl or stable?
6. Devin and Muse questions (G8): instruct them to use a question tool, detect questions in replies (reversing ADR-0080), or leave them as they are?
7. Compaction banner for Codex and Muse (G3): extend the Claude banner, or use another affordance?
8. Watcher on OpenCode (G12): build it (an ADR, as Muse needed), or keep OpenCode refused for now?
9. OpenCode's own sessions (G1): keep them apart as ADR-0087 does, or allow an attach?
10. Grok images (G9): re-test on 1.0.62 before changing anything?
11. PR #1179: merge decision for the Claude compaction fix. Lead's call.
12. Muse reconnect (#1092): does the Muse reconnect control close the issue for Muse, and is Devin still missing one?
13. Muse: who runs a live check on a machine with the `muse` client installed, so Muse's cells can leave `unverified`?
14. Glossary candidates, not added to `CONTEXT.md`. "Provider session" (`CONTEXT.md:103`) and "Model source" (`CONTEXT.md:91`) already exist. Candidates: "provider profile" (the per-provider record of capabilities and rules, Stage 1); "Sotto tool server" (the loopback MCP server offered to a thread, distinct from a provider's own MCP config); "adopted provider session" (a provider session Sotto did not start and now records, G1).

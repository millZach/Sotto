# Statecharts for Sotto: what the skill is and what it would take

Researched November 5, 2026, at Zach's request. Zach asked whether Sotto should use the statechart skill from poteto (Lauren Tan), and what it would take either to use the skill for Sotto's own development, or to ship something like it as a product feature.

Method: read-only. The skill's files in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart), read at `main`. Sotto's code at `origin/main` 20a80a069. The issues, pull requests and ADRs named below, read through `gh`. The npm registry for XState and Pele. One HEAD request each to the TLC jar and to `pele.run`. Nothing was built, installed or run. A read-only survey of Sotto's stateful flows ran at commit 9bb05ed3f, 1,611 commits older than `origin/main`. Its counts are marked as such, and the line numbers below were pinned again at `origin/main`.

## Short answer

- **The skill is a model checker's front end, not a statechart library.** Someone writes a TLA+ model of a flow by hand. TLC, the TLA+ model checker, explores every reachable state. The skill draws the graph as a Mermaid state diagram, marks each state that breaks a rule, and gives the shortest path to each. It is a design and bug-finding tool for one person at a desk. It does not run in an app.
- **For Sotto's own development:** one hand-made pilot on delegation outcomes, with swarm members. Those flows have open race bugs, and their outcome is already a pure function a model can be checked against. Keep any state table as typed code in TypeScript, not as a library. Part 1 has the flows, the work and the estimates.
- **As a product feature:** no. The skill's runtime, its Java download and its Pele renderer all reach hosts that Sotto's privacy rules do not name. A user-visible state diagram already works through Sotto's visual tool, with no new host.

## The skill

- **Source and author.** The skill is `pstack/skills/statechart` in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart). Every commit to it is by GitHub login `poteto`, who is Lauren Tan. The first is [`eb4db2b55`](https://github.com/cursor/plugins/commit/eb4db2b55), "add the statechart skill to draw TLA+ models as charts", October 22, 2026, #741. The latest is [`519d36aa9`](https://github.com/cursor/plugins/commit/519d36aa9), October 27, 2026, #981. The pstack [LICENSE](https://github.com/cursor/plugins/blob/main/pstack/LICENSE) is MIT, copyright Lauren Tan. The pstack README lists `/statechart` at `pstack/README.md:157`.
- **Forks.** Public forks and mirrors of pstack copy the skill, among them `michael-denyer/pstack-claude`, `chhoumann/t3-pstack` and `ScriptedAlchemy/pstack-codex`. They can drift from the source, so pin to a commit if you use one.
- **Invocation.** `SKILL.md` sets `disable-model-invocation: true`. An agent does not run it on its own. The user types `/statechart`.
- **What it does.** The author writes a TLA+ spec, a TLC config and a view module that gives each state the reader's words. Then `scripts/statechart SPEC.tla --config --view --out` checks the rules. Each rule is an `INVARIANT`. Each break is the shortest path TLC finds to a state that breaks it. Output is `chart.mmd`, `report.md`, `tlc.out` and one `tlc-RULE.out` per broken rule (`SKILL.md`, "Run" and "Read the report").
- **Size limit.** Above 500 states, the chart draws only the paths to the broken rules. The skill advises small constants or a `CONSTRAINT` (`SKILL.md`, "Read the report").
- **Hand-off rule.** Each bug path is replayed against the real code, one step per action, as a test or a live repro. The skill says to treat the model as wrong until a bug is shown not to occur (`SKILL.md`, "Hand off"). It does not generate code from the model.
- **Runtime.** `scripts/statechart` runs under Node 22.18 to 22.x, Node 23.6 or later, Bun 1.1.5 or later, or Deno 2.0 or later, and exits 127 otherwise. Node 24.22.1 is installed here, so the runtime floor is met. The package's only dev dependency is `fast-check` (`scripts/package.json`). Its test suite includes about 33 example models in `scripts/test/corpus`.
- **What it downloads.** `scripts/run.ts:68-69` pins `tla2tools.jar` v1.7.4 by SHA-256, from `github.com/tlaplus/tlaplus/releases`, and asks `mise` for `java@temurin-25`. The first run needs the network. The jar URL answers with HTTP 200 and is 2,274,532 bytes. `mise` is installed at `/usr/bin/mise`. Java is not installed here, and I did not install it, so I have not run TLC.
- **Platform.** The wrapper is a `/bin/sh` script. The runner kills a child's process group with `/bin/sh -c 'kill -s KILL -- "-$1"'` (`scripts/run.ts:97`). I found no Windows branch. Sotto's first platform is Windows, so the skill would need a Windows check before anyone relied on it there. That is an inference from the code, not a tested result.
- **Rendering.** `references/render.md` says to draw charts with the npm package [`pele@1.9.0`](https://www.npmjs.com/package/pele) through the API at `https://pele.run/api`. The package is MIT, from `obsidianmd/pele`, described as "a fast, lightweight Mermaid renderer that outputs themeable SVG". The API answers a HEAD request with HTTP 200. Rendering sends the chart text to that host.
- **No model calls.** In its TypeScript sources the skill makes no network call except the TLC download and `mise`, and the Pele step in its reference. It calls no AI provider.

## What already exists in Sotto

I searched Sotto's open and merged issues and pull requests, its ADRs, `CONTEXT.md`, `docs/`, `src/`, `tests/` and `package-lock.json`, on `origin/main` on November 5, 2026.

- **No prior work on statecharts or state machines as a way to build.** `gh issue` and `gh pr` searches for "statechart", "xstate" and "state machine" return no issue or pull request that proposes or rejects building with one. No ADR does either. `xstate` is not in `package-lock.json`. The only "state machine" in the docs is an example of a visual an agent can draw (`docs/guide.md:268`, `docs/plans/2026-10-06-visualize-tool.md:10`).
- **Sotto already writes its states down, in prose and tables.** ADR-0066 has a table of six terminal-agent states (Starting, Working, Idle, Needs you, Just finished, Exited), with the evidence for each and what moves between them (`docs/adr/0066-a-terminal-agent-reports-state-through-run-scoped-hooks.md:21`). The glossary defines the flow states: **Standing watch** (`CONTEXT.md:25`), **Waiting on the user** (`:91`), **Watcher news** (`:93`), **Delegation** (`:103`) and **Outcome** (`:107`).
- **Sotto already draws state diagrams.** A thread's visual can be a Mermaid diagram, and the visual schema names state diagrams among the kinds it takes (`src/shared/visuals.ts:62`). The diagram kinds include `state` (`src/shared/diagramSource.ts:4`, pattern at `:35`). The renderer runs Mermaid with `securityLevel: 'strict'` (`src/renderer/src/agents/diagrams/diagramRenderer.ts:60`), and the safety code has a `stateDiagram` case (`src/renderer/src/agents/diagrams/diagramSafety.ts:137`). Agents draw one when asked (`docs/guide.md:268`).
- **Bugs in the same flows.** These come from issue and pull request titles, which is all this note claims about them.
  - *Settle and delegation.* Merged: #2098 (reconcile blocking descendants before Watcher settles a thread), #2096 (recover restarted delegations from their exact answering turns), #1749 (stop watching a settled thread), #2036 (a settle goes through once GitHub says the pull request merged). Open: #1093, #1094 and #1211 (delegation edge cases), #1717 (Stop does not reach a delegated thread's children), #1726 (Settle and Restore do not reach delegated threads on other machines), #1891 (a test reads Watcher's news before the settle is saved), #1430 (a late settle is refused).
  - *Reconnect.* Merged: #1000 (keep reconnecting a dropped tailnet host). Open: #696 (close dead phone connections sooner), #1092 (tiles have no way to reconnect after sign-in), #1557 and #1700 (flaky reconnect tests).
  - *Swarms.* Merged: #1814 (one lead and a queued start for every angle), #2093 (swarm failures and angle receipts), #2181 (Dynamic thread workers held to the limits in Settings).
  - *Failures and turns.* Open: #2186 (a denied Claude Code or Cursor edit still reads Failed in the turn's steps), #1764 (a failed compaction keeps showing background work).

  These show the flows are hard to get right. They do not show a model would have caught any of them.
- **Adjacent open work.** #1023, "Make Sotto the engine under Watcher: delegation, outcomes, handover and machines", is open and covers the delegation flow.

## Part 1: the skill as a development tool for Sotto

### Corrections to the flow survey

The survey ran at 9bb05ed3f, so the points below were checked again at `origin/main`.

- **Turn states are not one enum.** Thread `status` is `idle | running | error` (`src/shared/agents.ts:693`). `lastTurn.status` adds `completed | interrupted | failed` (`src/shared/agents.ts:785`). Follow-up `status` is `queued | dispatching | uncertain | failed | paused` (`src/shared/agents.ts:1063`). Watcher outcomes are `working | background | answered | failed | stopped | paused | unknown` (`src/shared/watcher.ts:73`). "Settled" is a lifecycle field, not a turn state. So the words in the brief come from four enums and a lifecycle field.
- **Watcher is already on stable.** `sentToStable: true` (`src/shared/owlFeatures.ts:13`).
- **Swarms and Dynamic threads are on `main`.** The survey's commit predates them, and it reported no swarm or dynamic-thread code. Both are covered below.
- **Counts are stale.** The survey's counts of copy sites, adapter writes and test cases were taken at 9bb05ed3f. The copy-site list on `origin/main` has 39 files and 167 entries (`tests/fixtures/copySites.json`), not the 240 the survey quoted. Other counts below are marked as survey counts.

### The flows

**A. Thread turn.** States: the thread `status` and `lastTurn` above, plus the follow-up queue. Moves: adapters write thread status (about 88 assignments at 9bb05ed3f across nine adapter files). The queue is `FollowupStore` in `src/main/agents/followups.ts`, with `claim`, `settle`, `pause`, `resume` and `dropFailedResume`. `get()` copies the whole queue on each call (`followups.ts:156`), and `peek()` reads it without a copy (`:162`). Thread status is in memory, and the queue is saved to `followups.json`. Survey tests: about 42 name-matched files. *Model value:* medium. The writers are spread over nine adapters, so a model would mostly cover the queue.

**B. Watcher news and settle.** States: six UI groups (`src/shared/watcherOverview.ts:5`); request `active | stopped | closed`; participant `participating | taken-over | relinquished`; operation `queued | dispatching | accepted | failed | uncertain`; the seven outcomes above; twelve news kinds. `WatcherWakeUp` is a class at `src/main/agents/watcherWakeUp.ts:324`, and `WAKE_UP_TRIES = 3` at `:35`. Outcome derivation is pure (`src/main/agents/watcherOutcomes.ts:56`). Moves: `updateWatcher` writes, about 32 call sites at 9bb05ed3f. *Model value:* high for settle ordering, which the merged and open bugs above point at. Two writers meet here, the news queue and the settle.

**C. Delegations, swarm members and Dynamic threads.** Delegation delivery is `queued | dispatching | accepted | uncertain | failed` (`src/main/agents/delegation.ts:293`). The outcome is `DELEGATION_OUTCOMES`, Watcher's seven plus `refused` (`src/shared/delegation.ts:104`). `unknownBecause` is `restarted | unconfirmed | gone` (`src/main/agents/delegation.ts:313`). `outcomeOf` is pure (`src/main/agents/delegation.ts:1982`). Swarm members are `planned | queued | working | background | answered | failed | stopped | paused | unknown | refused` (`src/shared/workerSwarms.ts:8`), and synthesis is `failed | stopped` (`:24`). `WorkerAdmission` gives each piece `working` or `queued` against a per-machine ceiling (`src/main/agents/workerAdmission.ts:36`, `:43`). Dynamic threads (ADR-0191) are an overseer thread that plans, briefs workers as delegated threads and answers the user (`docs/adr/0191-a-dynamic-threads-model-oversees-and-chooses-a-model-for-each-piece.md`). Their shapes are in `src/shared/dynamicThreads.ts` (184 lines) and `src/main/agents/dynamicRecord.ts` (156 lines). The survey found about 20 test files that mention swarms and 21 that mention Dynamic threads. *Model value:* highest in the set. Outcome is already a pure function, so a model can be checked against the code, and the open bugs are races and edge cases of exactly the kind TLC explores.

**D. Permission and question cards.** Request kinds are question and permission. The renderer's `waitingFor` is `approval | question | null`, and a permission outranks a question (`src/renderer/src/agents/threadFacts.ts:195-200`). Draft status is `accepted | unconfirmed | draft | missing` (`src/shared/requestDrafts.ts`, survey). Authority lives in policy records (`src/main/memory/policies.ts`, ADR-0004). *Model value:* high, for one invariant: no answer is sent without a user action. A model can check every path that sends an answer. I did not search for open bugs in these cards.

**E. Remote host connect and reconnect.** The desktop's `HostStatus.phase` is `disconnected | connecting | connected | error` (`src/shared/hosts.ts:58`), with a `reconnecting` flag and a setup step. Backoff is `RECONNECT_DELAYS_MS = [3s, 4s, 8s, 16s]`, then every 16 seconds until the user stops it (`src/main/hosts/desktopHosts.ts:155`). The SSH launcher is `connecting | starting | forwarding | ready | disconnected` (`src/main/hosts/sshLauncher.ts:26`). Links are `tailnet | ssh` (`src/shared/hostConnection.ts:6`). The phones have no state machine for reconnect. The iPhone's reconnect is a timeout of 5 seconds (`apps/ios/Sotto/HostConnection.swift:14`) and a function, not a table. *Model value:* medium. The desktop phase is already a closed set with one main writer file, so a typed table covers it.

### One finding that a shared state table would catch

The same thread row has three state sets, and they disagree on a seen failure.

- The desktop row state is `needs | working | done` (`src/renderer/src/agents/threadFacts.ts:20`). A failed thread a client has shown is not "unseen" under `failureUnseen`, so it falls through to Done (`threadFacts.ts:195`). ADR-0092 says the row reads Done once a client shows the failure (`docs/adr/0092-a-failed-turn-is-attention-until-a-client-shows-it.md:7`).
- The iPhone `ThreadState` has seven cases (`apps/ios/Sources/SottoCore/Threads.swift:5`). It maps any thread with `status == "error"` to `failed` (`Threads.swift:9`) and does not read `failureSeen`. The wire carries `failureSeen` (`apps/ios/Sources/SottoCore/Wire.swift:251`). The iPhone's thread rows use `ThreadState` (`apps/ios/Sotto/Views.swift:868`).
- The Android `ThreadState` has seven cases (`apps/android/app/src/main/kotlin/com/millzach/sotto/core/Threads.kt:8`). It also maps `status == "error"` to `Failed` (`Threads.kt:25`), and no Android source reads `failureSeen`. Its thread rows use it (`apps/android/.../ui/ThreadsScreen.kt:279`).

So a failed thread that a client has shown probably still reads "Turn failed" on both phones, where ADR-0092 says Done. The iPhone's roster (`AgentsRoster`) does handle `failureSeen`, and its test covers unseen failures (`apps/ios/Tests/SottoCoreTests/AgentsRosterTests.swift:139-150`). I found no test of `ThreadState` on a seen failure, and no open issue for it. This comes from reading the code. I did not run it on a device.

### Which flows, and the work

Estimates are mine, not measured. Java and TLC have not been installed here, so their setup time is unknown.

| Order | Flow | Why this order | Estimate |
| --- | --- | --- | --- |
| 1 | C. Delegations, swarm members | Open race bugs; pure outcome to check against | Pilot about 1 agent-day, 1–2 PRs |
| 2 | B. Watcher settle | Most merged fixes sit on settle ordering; two writers | 1–2 agent-days, 2 PRs |
| 3 | D. Permission cards | One strong invariant (ADR-0004) | 1–2 agent-days, 2 PRs, slow to review |
| 4 | F. Host reconnect | Small closed set, one writer file | About 1 agent-day, 1 PR |
| 5 | A. Thread turn | Nine writers; do after C and B | 3 or more agent-days, several PRs |

The whole list is about 4–6 agent-days and 6–10 PRs, plus whatever fixes the models find. The fixes will cost more than the models.

**The pilot, step by step.** It stays out of the repo until a model proves useful.
1. On forge, outside the repo, install TLC and Java through the skill's runner. The Java download size is not measured.
2. Write a TLA+ model of one delegation's life: delivery states and outcome, with `unknownBecause`. Candidate invariants to test against the code, not claims about it: an `accepted` delivery never goes back to `queued`; `unknown` appears only with a reason; a `refused` outcome never has a delegated thread.
3. Run the skill with small constants. Read the report.
4. Replay each bug path as a Vitest test in `tests/unit/main/delegation*.test.ts`, one step per action, as the skill's hand-off asks.
5. Decide where a model lives. The repo has no home for TLA+ files. A `docs/models/` folder would be a new convention, which is Zach's call.

## Part 2: as a product feature

**1. Ship the skill to users, or install it into providers.** *Verdict: not now.* No code in `src/main` or `src/shared` reads or installs a `SKILL.md`, so Sotto has no install path to reuse. The runtime needs Node 22.18 or later, or Node 23.6 or later, or Bun or Deno. The first run downloads TLC from GitHub and Java through `mise` (`scripts/run.ts:68-69`, `:194-211`). None of those hosts is in the README's "Privacy and cost" section. AGENTS.md says a feature that adds a host is an ADR and a README change before it is a patch. The skill has no Windows path (`scripts/run.ts:97`). Pursued, this is an ADR, an install route for each provider, a consent step for the Java download, and a Windows port: 4–6 PRs and an ADR before any of them.

**2. Show users a state chart.** *Verdict: already possible, with no new host.* Sotto's visuals draw Mermaid state diagrams in threads. The skill's chart is a `stateDiagram-v2` with `classDef` lines for the broken-rule marks (`scripts/backends/mermaid.ts:186-196` in cursor/plugins). Whether Sotto's strict renderer shows those marks is untested. Checking it is one test and one PR. Do not use the skill's Pele step. `references/render.md` sends the chart text to `pele.run`, and that is a host Sotto's privacy rules do not name. A feature of this kind is an Owl or stable question first, as CLAUDE.md asks.

**3. Recommend the skill to agents or to Watcher.** *Verdict: low value.* It would be a line in a prompt pointing at a dev tool that needs Java. Not recommended.

## Library or typed table

**XState.** [Version 5.33.3](https://www.npmjs.com/package/xstate) is MIT, was last modified November 2, 2026, is 2.3 MB unpacked, and lists no dependencies on npm. It fits Sotto's TypeScript code on the desktop and in the host. Four things count against it.
- **Bundling.** The host build bundles every package except `zod` and `node-pty` (`scripts/build-host.mjs:57`). So XState as a devDependency would ship in the host. AGENTS.md allows devDependencies and says a new runtime dependency is an ADR. Whether bundled code counts as runtime is Zach's call.
- **Copy budget.** Main's update path must not copy state (AGENTS.md; `tests/perf/streamingCopyBudget.perf.test.ts`; `tests/unit/main/copySites.test.ts`). A snapshot-based library creates new objects on each transition. Whether that breaks the budget is untested here.
- **Other platforms.** The iPhone client is Swift and the Android client is Kotlin. XState runs in neither, so each would need its own port.
- **Fit with existing code.** Sotto already derives states in pure functions: `outcomeOf` (`src/main/agents/delegation.ts:1982`), `watcherTurnOutcome` (`src/main/agents/watcherOutcomes.ts:56`), `isThreadTurnRunning` (`src/shared/threadActivity.ts:49`). A library would be a second way to do the same thing.

**A plain typed table is the better fit.** Each flow gets one `const` table in TypeScript, one pure `next(state, event)` function, and a Vitest test that runs every state and event pair against the invariants. The TLA+ model stays offline for design. ADR-0066 already shows the team writing states as tables, so the convention exists. For cross-platform drift, a later step could share one JSON table of state, event and next state, with conformance tests on the phones. That is not needed for the pilot.

## Risks

- **Model drift.** The model describes code that changed in 1,611 commits between the survey's commit and `origin/main`. A model written today needs a refresh at each change to its flow. The skill says so itself.
- **The model proves the model, not the code.** The skill says to treat a clean model as no evidence until the code is replayed against it.
- **State explosion.** The skill's chart budget is 500 states. Delegation trees and swarms may exceed small constants, so the pilot must keep the number of delegations to two or three.
- **Copy budget.** A table or a library on main's update path must read state without copying it.
- **Windows.** The skill is POSIX-shaped (`/bin/sh`, process groups). A Windows check comes before anyone depends on it there.
- **Java and TLC on a shared box.** Run one job at a time on forge.
- **Forks.** Public forks drift from `cursor/plugins`. Pin a commit.

## Noticed, not traced

- **The phone rows.** The finding above is from reading the code and was not run on a device.
- **Main opens the memory store whatever the memory setting says.** The setting `memoryEnabled` defaults to off (`src/shared/settings.ts:749`), and the renderer reads it to hide memory (`src/renderer/src/App.tsx:179`). Main opens `memory.sqlite`, builds `PolicyStore` and registers the memory IPC at `src/main/index.ts:774-777` without reading the setting. ADR-0013 says the first beta ships without memory, and AGENTS.md says main reads the gate once at start. Whether opening the store is a memory read, or only the authority store that ADR-0004 describes (`docs/adr/0004-authority-in-policy-records.md`), is a question for Zach. I did not trace further.

## Recommendation

Run one hand-made pilot of the skill on delegation outcomes, with swarm members. Turn its bug paths into Vitest tests, and keep any state table as typed code, not XState and not in the app.

Decisions for Zach, none of which block this note:
1. Whether to run the pilot, and when.
2. Where TLA+ models should live, if anywhere in the repo.
3. Whether to file an issue for the seen-failure rows on the phones.
4. If Zach wants the state diagram as a product feature, whether it is Owl or stable.

## Sources

- The skill: [cursor/plugins, pstack/skills/statechart](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart), commits [`eb4db2b55`](https://github.com/cursor/plugins/commit/eb4db2b55) and [`519d36aa9`](https://github.com/cursor/plugins/commit/519d36aa9). The pstack [README](https://github.com/cursor/plugins/blob/main/pstack/README.md) and [LICENSE](https://github.com/cursor/plugins/blob/main/pstack/LICENSE).
- [XState on npm](https://www.npmjs.com/package/xstate), version 5.33.3.
- [Pele on npm](https://www.npmjs.com/package/pele), version 1.9.0.
- TLC: [tla2tools.jar v1.7.4](https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar), as pinned in the skill's runner.
- Sotto issues and pull requests: `millZach/Sotto` #696, #1000, #1023, #1092, #1093, #1094, #1211, #1430, #1557, #1700, #1717, #1726, #1749, #1764, #1814, #1859, #1891, #2036, #2093, #2096, #2098, #2181, #2186, read through `gh`.
- Sotto ADRs: `docs/adr/0013`, `0066`, `0092`, `0191`, read on `origin/main`.

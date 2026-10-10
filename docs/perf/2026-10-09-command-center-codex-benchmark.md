# Codex command-center tools benchmark — October 9, 2026

The comparison is incomplete. Twenty scheduled attempts produced twelve completed turns: ten in A and two in B. Only **Brief** has two completed turns in each arm. B's completed briefs took a median **34.73 seconds**, against **47.89 seconds** in A (27.5% less time). Both arms passed every brief key. This is useful evidence for the worker-brief path, but it does not settle ticket 3 across the five tasks.

Six B attempts stopped before a prompt because the initial harness checked a process-level MCP catalog without configuring its supplied endpoint at that level. Two more B attempts stopped after model output because the native-tool detector treated a non-Sotto MCP-shaped native item as unexpected. These are harness failures, not evidence that Codex answered incorrectly. They remain in the results. No additional model run replaced them or a wrong answer: **zero extra runs**.

## Machine and source

- October 9, 2026, approximately 20:02–20:16 PDT; protocol-only key verification followed. UTC timestamps are October 10.
- LAPTOP-RUSSH2J5: Windows 11 (10.0.26200), Intel(R) Core(TM) Ultra 9 275HX, 24 logical CPUs, 31.43 GiB RAM.
- Node v24.14.1; signed-in Codex **0.162.0** through Sotto's real `CodexAppServerHost`.
- Default ready model **gpt-6.1-sol**, default effort **low**. The harness asks native `model/list` for `isDefault` and `defaultReasoningEffort`; it does not select the first supported effort.
- Source: `739792b59363504d343b6607f1e330ed6dec7f39` on `command-center`. Both Sotto copies came from `git archive HEAD`, without installed dependencies. The measured source excludes these uncommitted harness changes.
- The archive plus synthetic Relay contained 5,010 files and 343.50 MiB. Relay has 39 files: package/README/configuration and 36 reminder modules.
- Another agent was running gates in a separate worktree. This was a shared development laptop, not an isolated machine. Every attempt checked free physical memory and waited below 3 GiB. Recorded checks ranged from 6.35 to 8.13 GiB.

## Arms and fixture

**A — Sotto tools only.** The production command-center launch profile, with its real startup validation and test-only admission injection. Native tools, inherited MCP servers, executable customization and network tools are off. One supplied `sotto_threads` endpoint offers the same three thread tools as B plus the three bounded project-file tools.

**B — Codex's own tools.** An ordinary native thread, working in the archived Sotto copy, with native local tools enabled, sandbox `read-only` and approval `never`. Inherited servers, apps, plugins, skills, hooks, web search and notifications are disabled for isolation. Its supplied endpoint offers only the three thread tools. Because public ordinary-thread modes do not express this policy pair, the test overrides the host's private policy method. The real adapter still sends and validates the policy through the native protocol. No product code changed.

Both arms register Sotto and Relay as projects, receive identical project identities/roots and task instructions, and use one fresh native thread per attempt. Both get `list_threads`, `read_thread` and `start_thread`, validated against [ticket 1's schemas](../../src/shared/commandCenter.ts). The fixed roster has eight threads across two projects, providers/statuses, all five requested groups, one pending question, one linked non-draft PR with passing-check evidence, and two messages per thread. `start_thread` records arguments in memory and returns a fixed target; no worker starts.

A's file tools return at most 100 immediate entries per page, 100 literal search matches with an optional subdirectory, and 200 lines / 64 KiB per read from files no larger than 1 MiB. They reject absolute paths, traversal, alternate streams, links, obvious secret names and the excluded dependency/output/provider-cache directories. Search also bounds entries, depth, text bytes and elapsed time and reports partial coverage. These are measurement stand-ins, **not ticket 3's file broker**: immutable disposable copies avoid the broker's real concurrency and replacement races.

Windows read-only file attributes and byte hashes protect/check both copies. The native sandbox supplies B's write restriction. Each attempt checks that the complete file set and every hash remain unchanged. The harness stops its direct Codex session-file watcher before creating threads; authentication, model metadata, native answers and configuration are accessed only through the client's protocol. The real repository and worktrees are never model working folders.

The initial batch was interrupted after attempt 12 to repair B's startup check. Attempts 13–20 resumed from retained numeric evidence using another archive of the same source. Completed attempts and their answers were preserved. Only this harness's processes were stopped; temporary project/data folders were removed after use.

## Tasks and grading

The common preamble supplies the two project identities and copy roots, a request UUID, worker model/effort, the shared-copy choice, and instructions to read only those copies, avoid requests, and start nothing except the recording stand-in. It contains no answer-key facts.

| Task | One user prompt | Key |
| --- | --- | --- |
| Roster | What needs me right now, and what's ready for review? | Identify Choose Android storage / android-storage (pending question) and Theme contrast review / theme-review (ready PR). |
| Locate | Where does Sotto decide which providers may run the command center, and what's admitted today? Include the exact file path, platform and client version. | src/main/agents/commandCenterAdmission.ts; Codex, Windows, 0.162.0. |
| Trace | If a Codex thread's app-server stops in the middle of a reply, what does the user see? Include the exact user-facing sentence and its source file. | src/main/agents/codex.ts and the exact SESSION_ENDED sentence. |
| Brief | Start a thread in Sotto to add a new setting called demoFlag. Find what a new setting must touch first and brief the worker properly. Use the shared working copy. | Exactly one start_thread; Sotto target; demoFlag; src/shared/settings.ts; src/main/ipc/registerIpc.ts and its patch allow-list; tests/integration/ipc.test.ts or its settings split. |
| Across projects | Compare Sotto and Relay: which declares zod as a runtime dependency, and where does each keep its settings or configuration types and defaults? Give exact paths for both projects. | Sotto declares zod in package.json, settings in src/shared/settings.ts; Relay has no zod/runtime dependencies, configuration in src/config.ts. |

Grading uses final-answer identities/paths/facts, except Brief, whose recorded `start_thread` arguments are checked in memory. No replies, histories or worker arguments are written to this note or the raw evidence.

A protocol-only read of the original native answers corrected overly narrow scorers: runs 17 and 20 stated the valid “no zod” fact without the original scorer's phrase, and run 4 identified the ready PR by its unique number rather than the exact thread title. Original grades are retained in raw evidence. The corrected scorer also rejects a negated Sotto/zod claim and unrelated Relay negations. No new model turn was sent. All completed turns passed their task facts after rechecking. These keys do not score writing quality or every additional claim.

## Measures

Time starts immediately before `send` and ends at the first published idle/completed turn. Creation, archive/hash checks and memory waits are outside that interval. Native `item/started` / `item/completed` IDs are deduplicated for commands, explicit reads and other tools; stand-in calls are counted at dispatch. A shell pipeline is one native command item, not one call per file it reads. Thread-tool and file-tool arguments are never serialized.

Input/output/cached counts come from `thread/tokenUsage/updated` through the adapter's `NativeUsage` aggregate (`thread.usage.total`). Cached input is included in input, not added to it. All twelve completed turns reported all three counters. Their `usage.partial` flags are true; this flag also covers unavailable model pricing, and this source has no price for `gpt-6.1-sol`. The note makes no cost estimate.

A send has a five-minute deadline; startup/operation/cleanup waits have 30-second limits. Any native request is counted by kind, then stops the client **before** the adapter can answer it. There were **no requests and no timeouts**. The failure latch keeps the original cause through disconnect notifications.

Medians below include **completed turns only**, with min–max in parentheses. Keys passed uses the two scheduled attempts per cell; unstarted/stopped attempts are not accuracy observations. T/F/N means stand-in thread tools / stand-in file tools / native tools. There is no completed B comparison for Roster, Locate, Trace or Across projects.

| Task | Arm | Completed | Seconds | Calls T / F / N | Tokens in | Out | Cached | Keys passed |
| --- | --- | ---: | --- | --- | --- | --- | --- | ---: |
| roster | A | 2/2 | 19.99 (19.13–20.86) | 4.0 (4.0–4.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 87,021 (87,019–87,023) | 419 (414–424) | 70,656 (70,656–70,656) | 2/2 |
| roster | B | 0/2 | — | — / — / — | — | — | — | 0/2 |
| locate | A | 2/2 | 19.33 (17.09–21.58) | 0.0 (0.0–0.0) / 2.5 (2.0–3.0) / 0.0 (0.0–0.0) | 75,237 (54,142–96,331) | 411 (321–501) | 59,584 (45,312–73,856) | 2/2 |
| locate | B | 0/2 | — | — / — / — | — | — | — | 0/2 |
| trace | A | 2/2 | 21.33 (17.92–24.75) | 0.0 (0.0–0.0) / 3.0 (3.0–3.0) / 0.0 (0.0–0.0) | 77,476 (77,156–77,796) | 410 (353–467) | 57,088 (54,400–59,776) | 2/2 |
| trace | B | 0/2 | — | — / — / — | — | — | — | 0/2 |
| brief | A | 2/2 | 47.89 (43.08–52.71) | 1.0 (1.0–1.0) / 4.5 (4.0–5.0) / 0.0 (0.0–0.0) | 126,356 (120,306–132,406) | 1,107 (1,055–1,159) | 104,832 (99,200–110,464) | 2/2 |
| brief | B | 2/2 | 34.73 (32.71–36.74) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 2.0 (2.0–2.0) | 94,744 (94,568–94,919) | 875 (853–896) | 73,088 (72,960–73,216) | 2/2 |
| across | A | 2/2 | 42.97 (35.98–49.97) | 0.0 (0.0–0.0) / 8.0 (8.0–8.0) / 0.0 (0.0–0.0) | 166,174 (159,152–173,195) | 849 (843–854) | 144,960 (139,008–150,912) | 2/2 |
| across | B | 0/2 | — | — / — / — | — | — | — | 0/2 |

### Arm totals

B's completed sample contains only Brief, so the arm-wide medians do not compare the same task mix. Among completed answers, A passed 10/10 and B passed 2/2.

| Arm | Completed | Seconds | Calls T / F / N | Tokens in | Out | Cached | Keys passed |
| --- | ---: | --- | --- | --- | --- | --- | ---: |
| A | 10/10 | 23.16 (17.09–52.71) | 0.0 (0.0–4.0) / 3.0 (0.0–8.0) / 0.0 (0.0–0.0) | 91,677 (54,142–173,195) | 484 (321–1,159) | 72,256 (45,312–150,912) | 10/10 |
| B | 2/10 | 34.73 (32.71–36.74) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 2.0 (2.0–2.0) | 94,744 (94,568–94,919) | 875 (853–896) | 73,088 (72,960–73,216) | 2/10 |

### Calls by kind

Completed turns, median (min–max). Thread order: `list_threads / read_thread / start_thread`. File order: `list_project_files / search_project_files / read_project_file`. Native order: commands / explicit reads / other. File reads executed inside a shell or native JavaScript are counted under their native tool item.

| Task | Arm | Thread: list / read / start | Files: list / search / read | Native: commands / reads / other |
| --- | --- | --- | --- | --- |
| roster | A | 1.0 (1.0–1.0) / 3.0 (3.0–3.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| roster | B | — / — / — | — / — / — | — / — / — |
| locate | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 1.0 (1.0–1.0) / 1.5 (1.0–2.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| locate | B | — / — / — | — / — / — | — / — / — |
| trace | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 1.0 (1.0–1.0) / 2.0 (2.0–2.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| trace | B | — / — / — | — / — / — | — / — / — |
| brief | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 0.0 (0.0–0.0) / 1.5 (1.0–2.0) / 3.0 (3.0–3.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| brief | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 2.0 (2.0–2.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| across | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 2.0 (2.0–2.0) / 2.0 (2.0–2.0) / 4.0 (4.0–4.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| across | B | — / — / — | — / — / — | — / — / — |

### Each key item

Unstarted/stopped attempts have no passing items; they did not produce a graded final answer. Brief's six items inspect the actual recorded call, not the final reply's claim that it started a worker.

| Task | Key item | A | B |
| --- | --- | ---: | ---: |
| roster | pendingQuestion | 2/2 | 0/2 |
| roster | readyPullRequest | 2/2 | 0/2 |
| locate | admissionFile | 2/2 | 0/2 |
| locate | codexWindowsVersion | 2/2 | 0/2 |
| trace | sourceFile | 2/2 | 0/2 |
| trace | exactNotice | 2/2 | 0/2 |
| brief | startedOnce | 2/2 | 2/2 |
| brief | correctProject | 2/2 | 2/2 |
| brief | demoFlag | 2/2 | 2/2 |
| brief | settingsFile | 2/2 | 2/2 |
| brief | patchAllowList | 2/2 | 2/2 |
| brief | ipcTest | 2/2 | 2/2 |
| across | sottoZod | 2/2 | 0/2 |
| across | sottoSettings | 2/2 | 0/2 |
| across | relayNoZod | 2/2 | 0/2 |
| across | relayConfig | 2/2 | 0/2 |

### Every scheduled attempt

Stopped durations are time to abort, not send-to-idle timings. Their tool counts are partial. Startup failures sent no prompt and have no time/usage. The initial detector failure path discarded partial usage before disconnect; runs 18/19 therefore have unknown token counts despite 3/2 usage notifications. The final harness preserves available usage on failure.

| Run | Task | Arm | Seconds | Calls T/F/N | Tokens in/out/cached | Keys | Outcome |
| ---: | --- | --- | ---: | --- | --- | ---: | --- |
| 1 | roster | A | 19.13 | 4/0/0 | 87,023/414/70,656 | 2/2 | passed |
| 2 | roster | B | — | 0/0/0 | unknown/unknown/unknown | 0/2 | setup-refused |
| 3 | roster | B | — | 0/0/0 | unknown/unknown/unknown | 0/2 | setup-refused |
| 4 | roster | A | 20.86 | 4/0/0 | 87,019/424/70,656 | 2/2 | passed |
| 5 | locate | B | — | 0/0/0 | unknown/unknown/unknown | 0/2 | setup-refused |
| 6 | locate | A | 17.09 | 0/2/0 | 54,142/321/45,312 | 2/2 | passed |
| 7 | locate | A | 21.57 | 0/3/0 | 96,331/501/73,856 | 2/2 | passed |
| 8 | locate | B | — | 0/0/0 | unknown/unknown/unknown | 0/2 | setup-refused |
| 9 | trace | A | 24.75 | 0/3/0 | 77,796/467/59,776 | 2/2 | passed |
| 10 | trace | B | — | 0/0/0 | unknown/unknown/unknown | 0/2 | setup-refused |
| 11 | trace | B | — | 0/0/0 | unknown/unknown/unknown | 0/2 | setup-refused |
| 12 | trace | A | 17.92 | 0/3/0 | 77,156/353/54,400 | 2/2 | passed |
| 13 | brief | B | 32.71 | 1/0/2 | 94,568/853/72,960 | 6/6 | passed |
| 14 | brief | A | 52.71 | 1/5/0 | 132,406/1,159/110,464 | 6/6 | passed |
| 15 | brief | A | 43.08 | 1/4/0 | 120,306/1,055/99,200 | 6/6 | passed |
| 16 | brief | B | 36.74 | 1/0/2 | 94,919/896/73,216 | 6/6 | passed |
| 17 | across | A | 49.97 | 0/8/0 | 159,152/843/139,008 | 4/4 | passed |
| 18 | across | B | 16.16 | 0/0/3 | unknown/unknown/unknown | 0/4 | unexpected-native-tool |
| 19 | across | B | 18.10 | 0/0/2 | unknown/unknown/unknown | 0/4 | unexpected-native-tool |
| 20 | across | A | 35.98 | 0/8/0 | 173,195/854/150,912 | 4/4 | passed |

## Failures and corrections

- **2, 3, 5, 8, 10, 11 (B):** startup-catalog assertion, before any prompt or model reply. B initially attached tools only in `thread/start` configuration; `mcpServerStatus/list` queried the process. The final harness also installs the supplied endpoint at process launch, with the same direct exposure and exact approval/tool names as A. A setup-only verification passed after that change.
- **4 (A Roster):** passed after accepting the unique PR number as the ready-thread identity. Raw evidence retains the original scorer failure; the answer was not replaced.
- **18, 19 (B Across):** the guard stopped a non-Sotto MCP-shaped item after native commands/model output. A protocol read identifies run 19's server as Codex's own `node_repl`; run 18's interrupted item was not present in the readable native history, so its server kind remains unknown. The final harness counts B's known native `node_repl` items rather than treating them as inherited servers. Neither stopped run was retried.
- **20 (A Across):** passed after accepting its equivalent “no zod” fact wording. The original scorer failure is retained; the answer was not replaced.
- **17 (A Across):** passed after correcting the scorer's false negative, using the same original reply. Raw evidence preserves the initial failing item and outcome.
- The final audit also extended obvious private-key filename refusals and preserved usage on failures. These affect stand-ins/observation only.

The initial archive preparation also found GNU tar interpreting a Windows drive colon as a remote archive. Relative archive/extraction arguments fixed it before any provider attempt. Setup-only checks and protocol-only answer reads send no model prompts. **Extra model runs: 0.** The requested retry rule permits client-start failures or timeouts before model output, not these harness assertion/detector failures. No failed or incorrect answer was replaced.

## What differed, and what the numbers cannot tell

For Brief, A used a median 4.5 bounded file calls plus one thread call; B used two native command items plus one thread call. B's median input was 94,744 against A's 126,356 (25.0% lower); median output was 875 against 1,107. Uncached input was almost the same: A 21,524 and B 21,656; the input reduction was mostly cached context. The observed mechanism is fewer file-tool round trips and less repeated context. It is an inference from call counts and reported tokens, not a decomposition of provider latency.

This compares the complete launch profiles, including their tool descriptions and native project-instruction behavior. It does not isolate filesystem speed. Native tools can combine searches and file windows in one item; bounded stand-in reads split them. Native JavaScript and shell item shapes also make call counts a coarser unit than file operations.

Two turns per measured cell is a small sample; caching, provider load and the neighboring gate job can move both time and tokens. A stand-in file tool is not ticket 3's broker. The fixed roster and recording worker tool say nothing about a real worker's creation, permission/delivery policy, reconciliation or concurrency. Codex on this Windows client/model is the only provider tested. A native read-only sandbox is not a project-read capability boundary, and byte integrity does not prove a complete audit of every native read.

Most importantly, four B task cells lack completed measurements. This run supports “native tools helped these two briefs,” **not** “native tools are generally faster” or a decision to widen ADR-0066. Ticket 3's admission and project-read design still need a complete comparative run.

## Repeat and verification

The harness is [commandCenterCodexBenchmark.live.test.ts](../../tests/perf/commandCenterCodexBenchmark.live.test.ts), with [stand-ins](../../tests/fixtures/commandCenterBenchmark.ts). It reuses the live suite's real adapter, admission injection, thread server, bounded waits and failure latch. Numeric raw evidence lives locally in the gitignored `artifacts/command-center-benchmark/results.json`; auxiliary metadata contains thread identities only. Neither endpoint bearer tokens nor protocol bodies are retained.

```powershell
$env:SOTTO_COMMAND_CENTER_BENCHMARK='1'
npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts --maxWorkers=1
Remove-Item Env:SOTTO_COMMAND_CENTER_BENCHMARK
```

It refuses CI and skips unless explicitly enabled. `SOTTO_COMMAND_CENTER_BENCHMARK_SETUP_ONLY=1` validates B startup without a prompt; `SOTTO_COMMAND_CENTER_BENCHMARK_RESUME=1` preserves completed attempts after an interrupted process. Recovery/recheck options were used only for this interrupted experiment and send no replacement answers.

Validation: `npm run typecheck` and `npm run lint` passed. `npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts` skipped both opt-in tests. The final setup-only run passed the fixture safety/key preflight and B's real client startup without a model prompt. Protocol-only key verification passed. No full suite or product/UI change was part of this benchmark.

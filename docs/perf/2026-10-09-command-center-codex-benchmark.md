# Codex command-center tools benchmark — October 9, 2026

The eight requested B reruns are complete: **all eight raised a command-approval request and stopped without a graded answer**. No request was answered. A's ten completed runs and B's two completed Brief runs stand unchanged. The retained sample is therefore A **10/10 completed and passed**, B **2/10 completed and passed**; B's asking-mode replacements completed **0/8**. This is a measured permission-mode outcome, not a claim that eight answers were wrong.

The only valid speed comparison remains **Brief under B's earlier read-only/never profile**: B was **13.17 seconds faster**, a median **34.73 seconds** versus A's **47.90 seconds**, or **27.5% less time**. There is **no measured overall speed winner** for the chosen asking/inherited profile, and no completed B comparison for Roster, Locate, Trace or Across. A finished all those tasks; B reached a request in about 4–6 seconds. Time to a request does not establish faster completion.

## Machine, source and schedule

- October 9, 2026: first pass approximately 20:02–20:16 PDT; the eight replacements ran **20:51:27–20:53:27 PDT**. Raw UTC timestamps are October 10.
- LAPTOP-RUSSH2J5: Windows 11 (10.0.26200), Intel(R) Core(TM) Ultra 9 275HX, 24 logical CPUs, 31.43 GiB RAM. Node v24.14.1.
- Signed-in Codex **0.162.0**, through Sotto's real `CodexAppServerHost`; default ready model **gpt-6.1-sol**, default effort **low**. Native `model/list` supplies `isDefault` and `defaultReasoningEffort`.
- Measured source remains **739792b59363504d343b6607f1e330ed6dec7f39**, the original HEAD. Replacements explicitly archive that revision, so harness commits do not change the measured projects. No installed dependencies are copied.
- Sotto plus synthetic Relay: 5,010 files, 343.50 MiB. Relay has 39 files, including its configuration and 36 reminder modules.
- Another agent was running gates in another worktree. This shared laptop was not isolated. Every attempt checked free memory and waited below 3 GiB; checks over both passes ranged from 6.35 to 8.13 GiB.

The first pass scheduled task blocks ABBA, BAAB, ABBA, BAAB, ABBA. The completion pass preserved the relative B task/repetition order: Roster 1/2, Locate 1/2, Trace 1/2, Across 1/2 (runs 21–28 replacing 2, 3, 5, 8, 10, 11, 18, 19). **No A run or Brief was rerun**. There can be no new A/B time interleaving under that constraint; the A observations remain from the earlier window. The replacement budget was eight attempts plus at most two retries only for a client that did not start. **Eight attempts, zero retries used.** A setup-only check sent no prompt and consumed no model run.

## Arms and fixture

**A — Sotto tools only.** The production command-center launch profile, with real startup validation and test-only admission injection. Native tools, inherited MCP servers, executable customization and network tools are off. One supplied `sotto_threads` endpoint offers three thread tools plus three bounded project-file tools. Its ten original runs stand unchanged.

**B — provider tools in asking mode, inherited settings.** The eight replacements use an ordinary Codex thread in Sotto's public `approval-required` mode: native `untrusted` approval policy, `user` reviewer and `read-only` sandbox. There is no private policy override. Ordinary provider settings, skills, customization and user MCP servers are inherited. The only additional launch configuration supplies the stand-in `sotto_threads` endpoint; a dotted server override preserves the user's other servers. Its three tools are preallowed in the same way Sotto supplies scoped tools to ordinary threads. The process-level startup check verifies those tools while allowing inherited servers. All non-Sotto MCP tool items, including `node_repl`, count as native calls; they do not fail a run. The thread's working folder is the Sotto copy.

**Retained B Brief differs.** Runs 13 and 16 used the first-pass isolated profile: native local tools on, read-only sandbox, approval `never`, inherited servers/skills/apps/plugins/hooks/network disabled, with a test-only private policy override. They were retained as instructed. This makes the combined B column a mixture of profiles; its completed Brief times must not be attributed to the new asking/inherited profile. A fresh full invocation of the updated harness uses asking/inherited B for all tasks.

Both arms register Sotto and Relay roots and use a fresh thread per attempt. The same `list_threads`, `read_thread` and `start_thread` stand-ins follow [ticket 1's contract](../../src/shared/commandCenter.ts). Eight fixed threads span two projects, providers/statuses and Needs you, Ready for review, Working, Quiet and Idle. One has a pending question; another has a non-draft linked PR with passing checks; each has two messages. `start_thread` records arguments only in memory and returns a fixed ID. It starts no worker.

A's file tools list 100 entries per page, search literal text with at most 100 matches and an optional subdirectory, and read at most 200 lines / 64 KiB from files up to 1 MiB. They reject absolute paths, `..`, alternate streams, links and obvious secrets, including `.env*` and private keys. They skip `.git`, `node_modules`, `out`, `release`, `artifacts` and provider cache folders. Search also bounds entries, depth, bytes and elapsed time and reports partial coverage. This simple stand-in is not ticket 3's broker.

Copies have read-only attributes and baseline hashes. Every run verifies the complete file set and all bytes. **No project copy changed.** Only disposable archive copies are model working folders. The host's direct native-session watcher is stopped before any thread exists; the harness never reads provider home or credential contents. Authentication and provider metadata are accessed through the client. Temporary clients/endpoints/folders were closed and removed.

## Tasks and grading

The common preamble supplies project identities and copy roots, a request UUID, model/effort and shared-copy choice. It instructs the model to read those roots, avoid requests and start nothing except the recording stand-in. It supplies no key facts. Task prompts were unchanged from the first pass.

| Task | One user prompt | Key |
| --- | --- | --- |
| Roster | What needs me right now, and what's ready for review? | Identify Choose Android storage / android-storage (pending question) and Theme contrast review / theme-review (ready PR). |
| Locate | Where does Sotto decide which providers may run the command center, and what's admitted today? Include the exact file path, platform and client version. | src/main/agents/commandCenterAdmission.ts; Codex, Windows, 0.162.0. |
| Trace | If a Codex thread's app-server stops in the middle of a reply, what does the user see? Include the exact user-facing sentence and its source file. | src/main/agents/codex.ts and the exact SESSION_ENDED sentence. |
| Brief | Start a thread in Sotto to add a new setting called demoFlag. Find what a new setting must touch first and brief the worker properly. Use the shared working copy. | Exactly one start_thread; Sotto target; demoFlag; src/shared/settings.ts; src/main/ipc/registerIpc.ts and its patch allow-list; tests/integration/ipc.test.ts or its settings split. |
| Across projects | Compare Sotto and Relay: which declares zod as a runtime dependency, and where does each keep its settings or configuration types and defaults? Give exact paths for both projects. | Sotto declares zod in package.json, settings in src/shared/settings.ts; Relay has no zod/runtime dependencies, configuration in src/config.ts. |

Final-answer identities, paths and facts are graded in memory; Brief grades recorded `start_thread` arguments. Replies, transcripts and tool arguments are never saved. The original protocol-only recheck corrected scorer false negatives in A runs 4, 17 and 20 without sending new turns: the unique ready PR number and equivalent no-zod wording are accepted, while negated/unrelated claims are rejected. Original grades remain in raw history. All completed original turns passed after rechecking. These keys do not score every extra claim or writing quality.

## Measures and completed attempt table

Time starts at `send`; completed time ends at the first published idle/completed turn. Setup, memory waits and hash checks are outside that interval. Five minutes bounds a turn; startup/operations/cleanup have 30-second bounds. First failure is latched through disconnect.

Native items are deduplicated by ID; commands, explicit reads and other tools are separate kinds. User MCP calls belong to native other. Stand-in calls are counted at dispatch. Shell pipelines or JavaScript reads can combine many file operations in one native item. A requested command item is counted even when its approval is unanswered and execution never proceeds.

Input/output/cached counters come only from `thread/tokenUsage/updated`, through `NativeUsage` (`thread.usage.total`). Cached input is part of input. Available usage is captured on notifications and before disconnect so failures cannot discard it. **None of the eight replacements sent any usage notification before the approval**, so all three counters are **unknown, not zero**. This differs from first-pass 18/19, whose available partial counters were lost by the old harness. The twelve retained completed turns have all counters; their `usage.partial` flags also cover missing model pricing. No cost is estimated.

Medians with min–max follow. **† marks time to stop on a request, not time to idle.** Its tool counts are partial attempted items. T/F/N means stand-in thread / stand-in file / native calls. Zero passing B keys in stopped cells means no graded answer, not wrong-answer accuracy.

| Task | Arm | Completed | Seconds | Calls T / F / N | Tokens in | Out | Cached | All keys passed |
| --- | --- | ---: | --- | --- | --- | --- | --- | ---: |
| roster | A | 2/2 | 19.99 (19.13–20.86) | 4.0 (4.0–4.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 87,021 (87,019–87,023) | 419 (414–424) | 70,656 (70,656–70,656) | 2/2 |
| roster | B | 0/2 | 4.75 (4.57–4.93) † | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | unknown | unknown | unknown | 0/2 |
| locate | A | 2/2 | 19.33 (17.09–21.57) | 0.0 (0.0–0.0) / 2.5 (2.0–3.0) / 0.0 (0.0–0.0) | 75,236.5 (54,142–96,331) | 411 (321–501) | 59,584 (45,312–73,856) | 2/2 |
| locate | B | 0/2 | 4.38 (4.34–4.43) † | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | unknown | unknown | unknown | 0/2 |
| trace | A | 2/2 | 21.33 (17.92–24.75) | 0.0 (0.0–0.0) / 3.0 (3.0–3.0) / 0.0 (0.0–0.0) | 77,476 (77,156–77,796) | 410 (353–467) | 57,088 (54,400–59,776) | 2/2 |
| trace | B | 0/2 | 4.99 (4.46–5.52) † | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | unknown | unknown | unknown | 0/2 |
| brief | A | 2/2 | 47.90 (43.08–52.71) | 1.0 (1.0–1.0) / 4.5 (4.0–5.0) / 0.0 (0.0–0.0) | 126,356 (120,306–132,406) | 1,107 (1,055–1,159) | 104,832 (99,200–110,464) | 2/2 |
| brief | B | 2/2 | 34.73 (32.71–36.74) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 2.0 (2.0–2.0) | 94,743.5 (94,568–94,919) | 874.5 (853–896) | 73,088 (72,960–73,216) | 2/2 |
| across | A | 2/2 | 42.97 (35.98–49.97) | 0.0 (0.0–0.0) / 8.0 (8.0–8.0) / 0.0 (0.0–0.0) | 166,173.5 (159,152–173,195) | 848.5 (843–854) | 144,960 (139,008–150,912) | 2/2 |
| across | B | 0/2 | 5.62 (5.34–5.89) † | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | unknown | unknown | unknown | 0/2 |


### Calls by kind

Medians (min–max), over the two retained attempts per cell. Read activity inside a native shell/JavaScript item stays in that item's native category. The eight requesting replacements each attempted one command and no supplied or inherited MCP call before stopping.

| Task | Arm | Thread: list / read / start | Files: list / search / read | Native: commands / reads / other |
| --- | --- | --- | --- | --- |
| roster | A | 1.0 (1.0–1.0) / 3.0 (3.0–3.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| roster | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| locate | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 1.0 (1.0–1.0) / 1.5 (1.0–2.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| locate | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| trace | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 1.0 (1.0–1.0) / 2.0 (2.0–2.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| trace | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| brief | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 0.0 (0.0–0.0) / 1.5 (1.0–2.0) / 3.0 (3.0–3.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| brief | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 2.0 (2.0–2.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| across | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 2.0 (2.0–2.0) / 2.0 (2.0–2.0) / 4.0 (4.0–4.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| across | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |

| overall | A | 0.0 (0.0–1.0) / 0.0 (0.0–3.0) / 0.0 (0.0–1.0) | 0.0 (0.0–2.0) / 1.0 (0.0–2.0) / 2.0 (0.0–4.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| overall | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–1.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–2.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |

### Each key item

| Task | Key item | A | B |
| --- | --- | ---: | ---: |
| roster | pendingQuestion | 2/2 | 0/2 (ungraded) |
| roster | readyPullRequest | 2/2 | 0/2 (ungraded) |
| locate | admissionFile | 2/2 | 0/2 (ungraded) |
| locate | codexWindowsVersion | 2/2 | 0/2 (ungraded) |
| trace | sourceFile | 2/2 | 0/2 (ungraded) |
| trace | exactNotice | 2/2 | 0/2 (ungraded) |
| brief | startedOnce | 2/2 | 2/2 |
| brief | correctProject | 2/2 | 2/2 |
| brief | demoFlag | 2/2 | 2/2 |
| brief | settingsFile | 2/2 | 2/2 |
| brief | patchAllowList | 2/2 | 2/2 |
| brief | ipcTest | 2/2 | 2/2 |
| across | sottoZod | 2/2 | 0/2 (ungraded) |
| across | sottoSettings | 2/2 | 0/2 (ungraded) |
| across | relayNoZod | 2/2 | 0/2 (ungraded) |
| across | relayConfig | 2/2 | 0/2 (ungraded) |


### Overall arm difference

A completed and passed **10/10**, with no requests. Combined B completed and passed **2/10**, with **eight command-approval requests**: an 80 percentage-point completion difference, under a no-answer benchmark. B's actual asking/inherited subsample completed **0/8**. No client-start failures, timeouts or changed copies occurred in the completion pass.

| Arm | Completed | Idle seconds, completed only | Calls T / F / N, all attempts | Tokens in, known only | Out | Cached | All keys passed |
| --- | ---: | --- | --- | --- | --- | --- | ---: |
| A | 10/10 | 23.16 (17.09–52.71) | 0.0 (0.0–4.0) / 3.0 (0.0–8.0) / 0.0 (0.0–0.0) | 91,677 (54,142–173,195) | 484 (321–1,159) | 72,256 (45,312–150,912) | 10/10 |
| B | 2/10 | 34.73 (32.71–36.74) | 0.0 (0.0–1.0) / 0.0 (0.0–0.0) / 1.0 (1.0–2.0) | 94,743.5 (94,568–94,919) | 874.5 (853–896) | 73,088 (72,960–73,216) | 2/10 |


The arm-wide completed-time medians are A **23.16 seconds** and B **34.73 seconds**, but B's two observations are exclusively Brief under its old profile; this is not a balanced overall speed comparison. B's eight stops had median **4.75 seconds** (4.34–5.89). Overall B token medians cover only two of ten attempts, whereas A covers ten of ten; overall token savings cannot be inferred.

Per task, only Brief supports a time/token difference. B saved **13.17 seconds (27.5%)**, used **2 native command items** versus A's **4.5 file calls**, and had **25.0% lower median input** (94,743.5 versus 126,356), with output 874.5 versus 1,107. Median uncached input was almost unchanged: B 21,655.5 versus A 21,524. The reduced repeated cached context and fewer file-tool round trips are plausible contributors, not a decomposition of provider latency. For Roster, Locate, Trace and Across, A completed in medians 19.99, 19.33, 21.33 and 42.97 seconds; B stopped at a request and has no completion/token difference to measure.

### Retained per-run evidence

| Run | Task | Arm | Seconds | Calls T/F/N | Tokens in/out/cached | Key items passed | Outcome |
| ---: | --- | --- | ---: | --- | --- | ---: | --- |
| 1 | roster | A | 19.13 | 4/0/0 | 87023/414/70656 | 2/2 | passed |
| 4 | roster | A | 20.86 | 4/0/0 | 87019/424/70656 | 2/2 | passed |
| 6 | locate | A | 17.09 | 0/2/0 | 54142/321/45312 | 2/2 | passed |
| 7 | locate | A | 21.57 | 0/3/0 | 96331/501/73856 | 2/2 | passed |
| 9 | trace | A | 24.75 | 0/3/0 | 77796/467/59776 | 2/2 | passed |
| 12 | trace | A | 17.92 | 0/3/0 | 77156/353/54400 | 2/2 | passed |
| 13 | brief | B | 32.71 | 1/0/2 | 94568/853/72960 | 6/6 | passed |
| 14 | brief | A | 52.71 | 1/5/0 | 132406/1159/110464 | 6/6 | passed |
| 15 | brief | A | 43.08 | 1/4/0 | 120306/1055/99200 | 6/6 | passed |
| 16 | brief | B | 36.74 | 1/0/2 | 94919/896/73216 | 6/6 | passed |
| 17 | across | A | 49.97 | 0/8/0 | 159152/843/139008 | 4/4 | passed |
| 20 | across | A | 35.98 | 0/8/0 | 173195/854/150912 | 4/4 | passed |
| 21 | roster | B | 4.57 † | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 22 | roster | B | 4.93 † | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 23 | locate | B | 4.43 † | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 24 | locate | B | 4.34 † | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 25 | trace | B | 5.52 † | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 26 | trace | B | 4.46 † | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 27 | across | B | 5.34 † | 0/0/1 | unknown/unknown/unknown | 0/4 | request-raised |
| 28 | across | B | 5.89 † | 0/0/1 | unknown/unknown/unknown | 0/4 | request-raised |


## First-pass harness failures, retained as history

The first pass had twenty scheduled attempts, fourteen prompted, twelve completed, zero requests, zero timeouts and zero extra runs. Six B startup assertions failed before a prompt; two B native-call detector failures stopped after model output. These were harness failures, not graded incorrect answers. They are superseded in the active cells by the eight requesting replacements, and all original numeric rows remain in `firstPassRuns` in ignored raw evidence.

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

- **2, 3, 5, 8, 10, 11:** the initial harness queried the process-level MCP catalog while supplying its endpoint only at `thread/start`. The corrected launch supplies that endpoint at process level too. The new check verifies the supplied names and allows inherited servers. A setup-only check passed before the replacements.
- **18, 19:** an overstrict guard rejected a non-Sotto MCP-shaped native item. Protocol reading identified run 19's server as `node_repl`; run 18's interrupted item was absent from readable native history, so its kind remains unknown. The updated detector counts every B user/provider MCP call as native and imposes no server-name failure.
- **4, 17, 20:** the original scorer false negatives were corrected using the same answers. No A answer or attempt was replaced.
- GNU tar initially treated a Windows drive colon as a remote archive; relative archive arguments fixed preparation before paid attempts. The first batch was interrupted after attempt 12 for the startup repair and resumed without replacing completed observations.
- Original 18/19 had 3/2 usage notifications, but their old failure path lost partial token counters. Those historical values stay unknown. The new pre-disconnect capture cannot create a counter that the client has not emitted.

The replacement pass failed **21–28**, each solely for `item/commandExecution/requestApproval`; it never answered a request or retried one. Startup/tool validation passed for all eight. There were no replacement harness failures. **Eight replacement attempts and zero of the two allowed client-start retries used.** Across both passes: 28 scheduled attempts, 22 prompts, twelve completed turns. Setup-only and protocol-only reads send no model turn.

## What the numbers cannot tell

Two runs per cell is a small sample. Provider load, prompt caching, the adjacent gate job and later rerun window can move time and tokens. Only **Codex on Windows, 0.162.0, gpt-6.1-sol at low effort** was measured. Higher effort or another provider may choose different tools. A stand-in file tool is not ticket 3's production broker; a fixed roster and recording worker say nothing about worker launch, permissions, reconciliation, delivery or concurrency.

This compares launch profiles and their instructions, tool descriptions, inherited settings and permissions, not filesystem speed alone. The changed B asking policy is a material difference from A and from retained B Brief. The requests show that this selected ordinary-thread policy needed user participation on these attempts. The no-answer rule measures that interruption, not how fast the command center would finish after Zach answered. No evidence here supports a general native-tools speed claim for the chosen asking/inherited design.

Hashes prove copy integrity, not a full audit of native reads. The native read-only sandbox is not a project-read capability boundary; user MCP servers are their own tool surface. All threads received copy-only instructions, but this benchmark does not validate a production broker's security boundary or inherited-server behavior.

## Repeat and verification

Harness: [commandCenterCodexBenchmark.live.test.ts](../../tests/perf/commandCenterCodexBenchmark.live.test.ts); [stand-ins](../../tests/fixtures/commandCenterBenchmark.ts). It reuses the real adapter, test admission injection, `ThreadToolServer`, bounded waits and live suite failure latch. Raw numeric/enum evidence is gitignored under `artifacts/command-center-benchmark/`; no bearer tokens, protocol bodies, arguments or replies are retained.

```powershell
$env:SOTTO_COMMAND_CENTER_BENCHMARK='1'
$env:SOTTO_COMMAND_CENTER_BENCHMARK_COMPLETE='1'
npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts --maxWorkers=1
Remove-Item Env:SOTTO_COMMAND_CENTER_BENCHMARK
Remove-Item Env:SOTTO_COMMAND_CENTER_BENCHMARK_COMPLETE
```

Completion mode requires the saved original numeric evidence, archives its original source revision, preserves A and both Brief observations, records replacement history and consumes at most eight replacements plus two client-start retries. Saved attempts consume the budget after interruption; wrong answers, requests, timeouts and harness failures are not retried. Repeating after this completion sends no new prompts. Without completion mode a fresh opt-in invocation schedules twenty new A/B observations with asking/inherited B. The suite refuses CI and skips without the opt-in. Setup-only validates startup without a prompt; protocol-only recheck reads original answers through the client without a model turn.

Validation: live B setup-only check passed; all eight replacements were recorded under the budget. `npm run typecheck` and `npm run lint` passed. `npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts --maxWorkers=1` without the opt-in skipped all three tests. Numeric evidence checks confirmed the ten A runs and both B briefs were unchanged. No product code, UI, full-suite or CI change belongs to this measurement.

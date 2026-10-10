# Codex command-center tools benchmark — October 9, 2026

October 9, 2026: Zach replaced the isolated profile with provider-native tools and pinned asking permissions ([ADR-0070](../adr/0070-command-center-is-a-read-only-thread.md)). The benchmark harness and fixtures depended on the removed profile/file tools and have been removed. This note and its evidence remain the historical record.

With **read-only sandbox and on-request approvals**, all ten B turns completed and **no run raised a request**. Reads and searches proceeded without user approval, including native commands and the inherited `node_repl` surface. A's ten original turns stand unchanged. A passed all keys in **10/10** runs; B passed **9/10** after checking the original answers. The one B Locate miss was not retried.

**B was faster overall by the median: B 21.66 versus A 23.16 seconds, 1.50 seconds or 6.5% less time.** B was faster on Roster, Trace, Brief and Across, and slower on Locate. Its median input was **100.1% higher**, so faster completion did not mean fewer tokens. This final B column uses one configuration throughout, including two new Brief trials; the earlier isolated briefs are history.

## Machine, source and schedule

- October 9, 2026, LAPTOP-RUSSH2J5: Windows 11 (10.0.26200), Intel(R) Core(TM) Ultra 9 275HX, 24 logical CPUs, 31.43 GiB RAM. Node v24.14.1.
- Codex **0.162.0**, through Sotto's real `CodexAppServerHost`, using the signed-in client. Default ready model **gpt-6.1-sol**, default effort **low**. Native `model/list` supplies `isDefault` and `defaultReasoningEffort`; these remained fixed.
- Original source **739792b59363504d343b6607f1e330ed6dec7f39**. Every measured copy is a `git archive` of that original HEAD, with no installed dependencies. Later harness commits do not change the measured source.
- Sotto plus synthetic Relay: 5,010 files, 343.50 MiB. Relay has 39 files, including its configuration and 36 reminder modules.
- First pass approximately 20:02–20:16 PDT; untrusted pass 20:51:27–20:53:27; final on-request pass **21:07:25–21:13:01 PDT**. Raw UTC timestamps are October 10.
- A neighboring agent ran gates in a different worktree. This was a shared laptop, not an isolated machine. Each attempt checked free memory and waited below 3 GiB; recorded checks across passes ranged from 5.88 to 8.13 GiB.

The first pass used five task blocks ABBA, BAAB, ABBA, BAAB, ABBA. The final pass retained the relative B order: Roster 1/2, Locate 1/2, Trace 1/2, Brief 1/2, Across 1/2 (runs 29–38). **No A turn was rerun.** Thus A and final B have the same task mix, but the later B trials cannot be newly interleaved in time with retained A trials. This is a timing limitation.

Final budget: ten B attempts plus at most two retries, only for a client that did not start. **Ten runs and zero retries used.** Requests, wrong answers, timeouts and harness failures were not eligible for retries. Setup-only checks and protocol-only answer reads sent no model turn. Attempts are reserved in numeric evidence before launch, so interruption does not reset the budget.

## Configuration of each arm and pass

| Arm/pass | Sandbox | Approval policy | Native/inherited tool surface | Trials and outcome |
| --- | --- | --- | --- | --- |
| A, original and retained | read-only | never | Native tools and inherited servers/customization off; supplied thread and file tools only | 10/10 completed, 10/10 passed, no requests |
| B, first pass | read-only | never | Native local tools on; inherited servers/apps/skills/hooks/network disabled | 2/10 completed, both Brief; six startup and two detector harness failures |
| B, second pass | read-only | untrusted | Ordinary inherited settings and servers; public approval-required mode | Eight reruns, all stopped on first-command approvals, none graded |
| B, final pass | read-only | on-request, user reviewer | Ordinary inherited settings and servers; supplied thread tools, no supplied file tools | 10/10 completed, 9/10 passed, no requests |

A uses the production command-center launch profile, real startup validation and test-only admitted-list injection. B is an ordinary Codex thread working in the Sotto copy. The requested read-only/on-request pair has no public Sotto runtime mode, so the harness sets a **test-only private policy hook** and matching CLI policy/sandbox. The real adapter validates the returned thread-creation settings and sends on-request approval policy for turns; their sandbox remains the one confirmed on creation. No product code changed.

B retains the user's own provider settings, skills/customization and tool servers. A dotted launch override adds only `mcp_servers.sotto_threads`, preserving other servers; its three recording tools are preallowed like Sotto's ordinary scoped tools. Startup verifies those supplied names while allowing inherited servers. Every non-Sotto MCP call, including `node_repl`, is a native call and never a failure merely for its server name. The process-level check is fixed; the endpoint is supplied both there and through the ordinary thread tools.

Both arms register disposable Sotto and Relay roots and use one fresh native thread per attempt. The same `list_threads`, `read_thread` and `start_thread` stand-ins follow [ticket 1's contract](../../src/shared/commandCenter.ts): eight fixed threads across two projects/providers/statuses, all requested groups, a pending question, a non-draft PR with passing checks and two messages each. `start_thread` stores its arguments only in memory, returns a fixed ID and starts nothing.

A's stand-in file tools list at most 100 entries per page; search literal text with at most 100 results and an optional subdirectory; read at most 200 lines / 64 KiB from files up to 1 MiB. They reject absolute paths, `..`, alternate streams, links and obvious secrets (`.env*`, private keys), and skip `.git`, `node_modules`, `out`, `release`, `artifacts` and provider-cache folders. Search bounds entries/depth/bytes/time and reports partial coverage. These simple tools are measurement stand-ins, not ticket 3's broker.

All model working folders are archive copies. Read-only attributes and baseline hashes check the complete file set and every byte after each run. **No copy changed.** The direct Codex session-file watcher is stopped before threads exist; the harness never reads provider-home or credential contents. Authentication and metadata use the client's protocol. Owned clients/endpoints and temporary folders were closed and removed.

## Tasks and keys

The unchanged common preamble supplies project identities/copy roots, a request UUID, model/effort and shared-copy choice. It instructs the model to read those copies, avoid requests, and start nothing except the recording stand-in. It supplies no key facts.

| Task | One user prompt | Key |
| --- | --- | --- |
| Roster | What needs me right now, and what's ready for review? | Identify Choose Android storage / android-storage (pending question) and Theme contrast review / theme-review (ready PR). |
| Locate | Where does Sotto decide which providers may run the command center, and what's admitted today? Include the exact file path, platform and client version. | src/main/agents/commandCenterAdmission.ts; Codex, Windows, 0.162.0. |
| Trace | If a Codex thread's app-server stops in the middle of a reply, what does the user see? Include the exact user-facing sentence and its source file. | src/main/agents/codex.ts and the exact SESSION_ENDED sentence. |
| Brief | Start a thread in Sotto to add a new setting called demoFlag. Find what a new setting must touch first and brief the worker properly. Use the shared working copy. | Exactly one start_thread; Sotto target; demoFlag; src/shared/settings.ts; src/main/ipc/registerIpc.ts and its patch allow-list; tests/integration/ipc.test.ts or its settings split. |
| Across projects | Compare Sotto and Relay: which declares zod as a runtime dependency, and where does each keep its settings or configuration types and defaults? Give exact paths for both projects. | Sotto declares zod in package.json, settings in src/shared/settings.ts; Relay has no zod/runtime dependencies, configuration in src/config.ts. |

Final answers are graded in memory; Brief grades its recorded `start_thread` arguments. No replies, transcripts or tool arguments are saved. The final Across scorer initially rejected both B replies' equivalent empty-dependency fact. A protocol-only read of the same original replies confirmed that wording; the matcher now accepts an empty runtime dependency set and rejects an empty dev dependency set as evidence. Runs 37/38 became passes, with their original keys/outcomes retained. No answer was replaced and no new model turn was sent. The Locate miss remained after protocol-only verification. Earlier A scorer corrections are retained below.

## Final on-request results

Medians with min–max. Time starts at `send` and ends at the first published idle/completed turn. Creation, memory waits, archive/hash work and cleanup are outside that interval. Completed wrong answers remain in the time/token sample; filtering them out would select on quality. T/F/N means stand-in thread / stand-in file / native calls.

| Task | Arm | Completed | Seconds | Calls T / F / N | Tokens in | Out | Cached | Runs passing all keys |
| --- | --- | ---: | --- | --- | --- | --- | --- | ---: |
| roster | A | 2/2 | 19.99 (19.13–20.86) | 4.0 (4.0–4.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 87,021 (87,019–87,023) | 419 (414–424) | 70,656 (70,656–70,656) | 2/2 |
| roster | B | 2/2 | 16.77 (13.89–19.64) | 4.0 (3.0–5.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 163,011.5 (142,692–183,331) | 430 (386–474) | 122,752 (102,912–142,592) | 2/2 |
| locate | A | 2/2 | 19.33 (17.09–21.57) | 0.0 (0.0–0.0) / 2.5 (2.0–3.0) / 0.0 (0.0–0.0) | 75,236.5 (54,142–96,331) | 411 (321–501) | 59,584 (45,312–73,856) | 2/2 |
| locate | B | 2/2 | 26.38 (20.59–32.17) | 0.5 (0.0–1.0) / 0.0 (0.0–0.0) / 2.5 (2.0–3.0) | 212,979 (195,761–230,197) | 592.5 (496–689) | 166,592 (146,048–187,136) | 1/2 |
| trace | A | 2/2 | 21.33 (17.92–24.75) | 0.0 (0.0–0.0) / 3.0 (3.0–3.0) / 0.0 (0.0–0.0) | 77,476 (77,156–77,796) | 410 (353–467) | 57,088 (54,400–59,776) | 2/2 |
| trace | B | 2/2 | 19.20 (18.23–20.16) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 3.0 (3.0–3.0) | 173,828 (171,925–175,731) | 448.5 (435–462) | 132,288 (131,456–133,120) | 2/2 |
| brief | A | 2/2 | 47.90 (43.08–52.71) | 1.0 (1.0–1.0) / 4.5 (4.0–5.0) / 0.0 (0.0–0.0) | 126,356 (120,306–132,406) | 1,107 (1,055–1,159) | 104,832 (99,200–110,464) | 2/2 |
| brief | B | 2/2 | 33.14 (31.36–34.92) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 2.0 (2.0–2.0) | 197,285.5 (183,637–210,934) | 936.5 (911–962) | 153,920 (137,600–170,240) | 2/2 |
| across | A | 2/2 | 42.97 (35.98–49.97) | 0.0 (0.0–0.0) / 8.0 (8.0–8.0) / 0.0 (0.0–0.0) | 166,173.5 (159,152–173,195) | 848.5 (843–854) | 144,960 (139,008–150,912) | 2/2 |
| across | B | 2/2 | 23.26 (22.73–23.79) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 3.0 (3.0–3.0) | 195,610.5 (175,639–215,582) | 607.5 (579–636) | 151,872 (132,864–170,880) | 2/2 |
| overall | A | 10/10 | 23.16 (17.09–52.71) | 0.0 (0.0–4.0) / 3.0 (0.0–8.0) / 0.0 (0.0–0.0) | 91,677 (54,142–173,195) | 484 (321–1,159) | 72,256 (45,312–150,912) | 10/10 |
| overall | B | 10/10 | 21.66 (13.89–34.92) | 0.5 (0.0–5.0) / 0.0 (0.0–0.0) / 2.5 (1.0–3.0) | 183,484 (142,692–230,197) | 537.5 (386–962) | 140,096 (102,912–187,136) | 9/10 |


### Calls by kind

Native `item/started` / `item/completed` IDs are deduplicated. Commands, explicit reads and other native tools are separate; user MCP calls are native other. Stand-in calls are counted at dispatch. A shell pipeline or JavaScript read can read many files in one item. The code-reading B trials used native commands and, in several cases, `node_repl`; their file operations therefore appear as native command/other items, not explicit native-read items.

| Task | Arm | Thread: list / read / start | Files: list / search / read | Native: commands / reads / other |
| --- | --- | --- | --- | --- |
| roster | A | 1.0 (1.0–1.0) / 3.0 (3.0–3.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| roster | B | 1.0 (1.0–1.0) / 3.0 (2.0–4.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| locate | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 1.0 (1.0–1.0) / 1.5 (1.0–2.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| locate | B | 0.5 (0.0–1.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.5 (1.0–2.0) / 0.0 (0.0–0.0) / 1.0 (0.0–2.0) |
| trace | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 1.0 (1.0–1.0) / 2.0 (2.0–2.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| trace | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 2.0 (2.0–2.0) |
| brief | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 0.0 (0.0–0.0) / 1.5 (1.0–2.0) / 3.0 (3.0–3.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| brief | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 1.0 (1.0–1.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.5 (1.0–2.0) / 0.0 (0.0–0.0) / 0.5 (0.0–1.0) |
| across | A | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 2.0 (2.0–2.0) / 2.0 (2.0–2.0) / 4.0 (4.0–4.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| across | B | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–1.0) / 0.0 (0.0–0.0) / 2.0 (2.0–2.0) |
| overall | A | 0.0 (0.0–1.0) / 0.0 (0.0–3.0) / 0.0 (0.0–1.0) | 0.0 (0.0–2.0) / 1.0 (0.0–2.0) / 2.0 (0.0–4.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) |
| overall | B | 0.0 (0.0–1.0) / 0.0 (0.0–4.0) / 0.0 (0.0–1.0) | 0.0 (0.0–0.0) / 0.0 (0.0–0.0) / 0.0 (0.0–0.0) | 1.0 (1.0–2.0) / 0.0 (0.0–0.0) / 1.5 (0.0–2.0) |


### Each key item

| Task | Key item | A | B on-request |
| --- | --- | ---: | ---: |
| roster | pendingQuestion | 2/2 | 2/2 |
| roster | readyPullRequest | 2/2 | 2/2 |
| locate | admissionFile | 2/2 | 1/2 |
| locate | codexWindowsVersion | 2/2 | 1/2 |
| trace | sourceFile | 2/2 | 2/2 |
| trace | exactNotice | 2/2 | 2/2 |
| brief | startedOnce | 2/2 | 2/2 |
| brief | correctProject | 2/2 | 2/2 |
| brief | demoFlag | 2/2 | 2/2 |
| brief | settingsFile | 2/2 | 2/2 |
| brief | patchAllowList | 2/2 | 2/2 |
| brief | ipcTest | 2/2 | 2/2 |
| across | sottoZod | 2/2 | 2/2 |
| across | sottoSettings | 2/2 | 2/2 |
| across | relayNoZod | 2/2 | 2/2 |
| across | relayConfig | 2/2 | 2/2 |


### Difference per task and overall

Negative percentage means B took less time. The overall row compares the balanced ten-turn samples.

| Task | A seconds | B seconds | B time relative to A | Difference | A/B runs passing all keys |
| --- | ---: | ---: | ---: | --- | ---: |
| roster | 19.99 | 16.77 | -16.1% | B faster by 3.23 s | 2/2 of 2 |
| locate | 19.33 | 26.38 | +36.4% | A faster by 7.05 s | 2/1 of 2 |
| trace | 21.33 | 19.20 | -10.0% | B faster by 2.14 s | 2/2 of 2 |
| brief | 47.90 | 33.14 | -30.8% | B faster by 14.76 s | 2/2 of 2 |
| across | 42.97 | 23.26 | -45.9% | B faster by 19.72 s | 2/2 of 2 |
| overall | 23.16 | 21.66 | -6.5% | B faster by 1.50 s | 10/9 of 10 |


The sum of the ten send-to-idle durations was **A 303.06 seconds, B 237.48 seconds**, 21.6% less for B. The corresponding means were **A 30.31, B 23.75 seconds**. These include the one B Locate answer that did not pass. B's largest median savings were Across (19.72 seconds, 45.9%) and Brief (14.76 seconds, 30.8%); Locate took 7.05 seconds longer (36.4%). Overall all-key accuracy was A 10/10 versus B 9/10, a ten percentage-point difference in this small sample.

B's median input was **183,484 versus A 91,677**, 100.1% higher. Median cached input was B 140,096 versus A 72,256. Median per-run uncached input was **B 42,693, A 20,625**. Native inheritance brings a larger instruction/tool context, while native tools can batch reads and searches that A divides into bounded calls. Those are plausible contributors to the token/time difference, not a measured decomposition of provider latency. Unlike the first isolated Brief sample, this final inherited pass does not show token savings.

### Requests and failures

**Zero of ten on-request runs raised a request.** Reads/searches ran without asking. No request was answered, no run timed out, no client failed to start, and no copy changed. For a future request, the harness records its kind and elapsed milliseconds from send, latches the result, and sends native `turn/interrupt` before cleanup. It intercepts the incoming request before the adapter can hold/answer it; direct interruption avoids the ordinary interrupt command's decline of held requests. The current pass did not exercise that interrupt-on-request branch.

| Request kind | Runs raising a request | Requests | Arrival time from send |
| --- | ---: | ---: | --- |
| command | 0/10 | 0 | none |
| file-change | 0/10 | 0 | none |
| network | 0/10 | 0 | none |
| mcp-tool | 0/10 | 0 | none |
| question | 0/10 | 0 | none |
| other | 0/10 | 0 | none |


**Run 31 (B Locate)** completed but failed `admissionFile` and `codexWindowsVersion`. It was retained without retry. Runs 37/38's initial Relay key failures were scorer false negatives corrected on the original answers. The final pass had no infrastructure failure.

Tokens come from `thread/tokenUsage/updated` as `NativeUsage` reads its aggregate (`thread.usage.total`). Cached input is included in input. Available counters are captured on notifications and before disconnect. All twenty retained A/final-B turns reported input, output and cached counts. Their `usage.partial` flags also cover unavailable model pricing; no cost estimate is made. Turns are bounded at five minutes; setup/operations/cleanup at 30 seconds. The failure latch preserves the first cause through disconnect.

### Final per-run evidence

| Run | Task | Arm | Seconds | Calls T/F/N | Tokens in/out/cached | Key items passed | Outcome |
| ---: | --- | --- | ---: | --- | --- | ---: | --- |
| 1 | roster | A | 19.13 | 4/0/0 | 87,023/414/70,656 | 2/2 | passed |
| 4 | roster | A | 20.86 | 4/0/0 | 87,019/424/70,656 | 2/2 | passed |
| 6 | locate | A | 17.09 | 0/2/0 | 54,142/321/45,312 | 2/2 | passed |
| 7 | locate | A | 21.57 | 0/3/0 | 96,331/501/73,856 | 2/2 | passed |
| 9 | trace | A | 24.75 | 0/3/0 | 77,796/467/59,776 | 2/2 | passed |
| 12 | trace | A | 17.92 | 0/3/0 | 77,156/353/54,400 | 2/2 | passed |
| 14 | brief | A | 52.71 | 1/5/0 | 132,406/1,159/110,464 | 6/6 | passed |
| 15 | brief | A | 43.08 | 1/4/0 | 120,306/1,055/99,200 | 6/6 | passed |
| 17 | across | A | 49.97 | 0/8/0 | 159,152/843/139,008 | 4/4 | passed |
| 20 | across | A | 35.98 | 0/8/0 | 173,195/854/150,912 | 4/4 | passed |
| 29 | roster | B | 13.89 | 3/0/1 | 142,692/386/102,912 | 2/2 | passed |
| 30 | roster | B | 19.64 | 5/0/1 | 183,331/474/142,592 | 2/2 | passed |
| 31 | locate | B | 20.59 | 1/0/2 | 230,197/496/187,136 | 0/2 | wrong-answer |
| 32 | locate | B | 32.17 | 0/0/3 | 195,761/689/146,048 | 2/2 | passed |
| 33 | trace | B | 20.16 | 0/0/3 | 171,925/435/131,456 | 2/2 | passed |
| 34 | trace | B | 18.23 | 0/0/3 | 175,731/462/133,120 | 2/2 | passed |
| 35 | brief | B | 31.36 | 1/0/2 | 183,637/911/137,600 | 6/6 | passed |
| 36 | brief | B | 34.92 | 1/0/2 | 210,934/962/170,240 | 6/6 | passed |
| 37 | across | B | 23.79 | 0/0/3 | 215,582/579/170,880 | 4/4 | passed |
| 38 | across | B | 22.73 | 0/0/3 | 175,639/636/132,864 | 4/4 | passed |


## Earlier passes, retained as history

### First pass: read-only/never, isolated native B

Twenty scheduled attempts, fourteen prompts, twelve completed turns, zero requests, zero timeouts and zero extra runs. A's ten turns passed after scorer verification; B's two completed Brief turns passed. B Brief median was 34.73 seconds versus A 47.90 (27.5% less), but this isolated profile is no longer the final B comparison.

| Run | Task | Arm | Seconds | Calls T/F/N | Tokens in/out/cached | Key items passed | Outcome |
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
| 18 | across | B | 16.16 (stop) | 0/0/3 | unknown/unknown/unknown | 0/4 | unexpected-native-tool |
| 19 | across | B | 18.10 (stop) | 0/0/2 | unknown/unknown/unknown | 0/4 | unexpected-native-tool |
| 20 | across | A | 35.98 | 0/8/0 | 173,195/854/150,912 | 4/4 | passed |


- **2, 3, 5, 8, 10, 11:** startup assertion before any prompt. The old harness supplied the endpoint only at `thread/start` while checking a process-level MCP catalog. The fixed launch supplies it at that level and the check allows inherited servers.
- **18, 19:** an overstrict native-call guard stopped non-Sotto MCP-shaped items after model output. Protocol reading identified 19's server as `node_repl`; 18's interrupted item was absent from readable native history, so its kind remains unknown. All B user/provider MCP calls now count as native.
- **4, 17, 20:** original A scorer false negatives were corrected using the same replies: a unique ready PR number and equivalent no-zod wording. Original grades remain in raw history. A was never rerun.
- Initial preparation fixed GNU tar treating a drive colon as a remote archive. The batch was interrupted after 12 for the startup repair, then resumed without replacing completed observations.
- Old 18/19 had 3/2 usage notifications but lost their partial counters on the old failure path. Their historical counters remain unknown; the new pre-disconnect capture preserves counters that actually arrive.

### Second pass: read-only/untrusted, inherited B

Eight replacements, no retries, no graded answers. All eight asked for `item/commandExecution/requestApproval` on their first command, even a read. None was answered; the old harness disconnected them before holding the requests. This was Sotto's public approval-required (`untrusted`) mode, not the intended read-only/on-request configuration. The following durations are time to stop, not time to idle. No usage notification arrived before any stop, so counters are unknown, not zero.

| Run | Task | Arm | Seconds | Calls T/F/N | Tokens in/out/cached | Key items passed | Outcome |
| ---: | --- | --- | ---: | --- | --- | ---: | --- |
| 21 | roster | B | 4.57 (stop) | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 22 | roster | B | 4.93 (stop) | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 23 | locate | B | 4.43 (stop) | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 24 | locate | B | 4.34 (stop) | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 25 | trace | B | 5.52 (stop) | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 26 | trace | B | 4.46 (stop) | 0/0/1 | unknown/unknown/unknown | 0/2 | request-raised |
| 27 | across | B | 5.34 (stop) | 0/0/1 | unknown/unknown/unknown | 0/4 | request-raised |
| 28 | across | B | 5.89 (stop) | 0/0/1 | unknown/unknown/unknown | 0/4 | request-raised |


All original numeric rows, original grades and pass histories remain in ignored raw evidence (`firstPassRuns`, `completion`, `beforeOnRequestRuns`, `onRequest`). Across three passes: **38 scheduled attempts, 32 prompts, 22 completed turns**, with no infrastructure retry. The eight untrusted approvals belong to history; none occurred in the final on-request pass. Setup-only checks and protocol-only reads were not model turns. One protocol-only verification hit a transient Windows cleanup lock after saving grades; bounded filesystem cleanup retries were added, the empty owned folder was removed and verification passed again. No measurement was retried for that cleanup issue.

## What the numbers cannot tell

Two runs per cell is a small sample; Codex on this Windows client/model at **low effort** is the only combination tested. Provider load, prompt caching, the neighboring gate job and the later B window can move time and tokens. A and final B are balanced by task but not contemporaneously interleaved. One B Locate answer missed its keys; speed is not interchangeable with answer quality, and these checks do not score writing quality or every additional claim.

The comparison includes full launch profiles, instructions, tool descriptions, inherited settings and native project-instruction behavior. It does not isolate filesystem speed. A stand-in file tool is not ticket 3's production broker. A fixed roster and recording worker say nothing about real worker launch, permission/delivery policy, reconciliation or concurrency.

The untrusted pass proves that one asking policy interrupted these reads; the corrected pass shows that read-only/on-request avoided requests on these ten tasks. It does not prove that writes, network activity or every inherited MCP server will ask correctly. The current request-interruption branch was not exercised because no final-pass request occurred. Copy hashes prove integrity, not a complete audit of native reads; read-only native sandboxing and user MCP servers are not a production project-read capability boundary.

## Repeat and verification

[Harness](../../tests/perf/commandCenterCodexBenchmark.live.test.ts) and [stand-ins](../../tests/fixtures/commandCenterBenchmark.ts) reuse the real adapter, test admission injection, `ThreadToolServer`, bounded waits and live failure latch. Numeric/enum raw evidence and native thread identities stay in gitignored `artifacts/command-center-benchmark/`. No bearer tokens, arguments, protocol bodies, replies or transcripts are retained there or in logs.

```powershell
$env:SOTTO_COMMAND_CENTER_BENCHMARK='1'
$env:SOTTO_COMMAND_CENTER_BENCHMARK_ON_REQUEST='1'
npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts --maxWorkers=1
Remove-Item Env:SOTTO_COMMAND_CENTER_BENCHMARK
Remove-Item Env:SOTTO_COMMAND_CENTER_BENCHMARK_ON_REQUEST
```

This mode requires retained numeric evidence, archives its original source, preserves A and both earlier B passes, and runs at most ten B attempts plus two client-start retries. Saved reservations consume the budget; repeating the completed pass sends no new prompts. A fresh opt-in invocation without that mode schedules twenty A/B observations with the corrected B profile. CI is refused and no opt-in means every test skips. Setup-only validates startup/preflight without a prompt; recheck reads original answers through the native protocol without a model turn or direct session-file reads.

Validation: live startup and fixture safety/grading preflight passed. The ten on-request trials completed under budget; protocol-only grading verification passed. Numeric checks confirmed A was unchanged and all final B policies/tool catalogs were validated. `npm run typecheck` and `npm run lint` passed. `npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts --maxWorkers=1` without opt-in skipped all three tests. No product code, UI or full-suite change was part of this benchmark.

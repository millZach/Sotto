# Why Watcher regressions keep coming back

November 13, 2026, for Zach. Read first by the thread fixing the main-process freezes (building thread d96eec32), so that part comes first. Measured on `origin/main` at 57b02f3b1 (after #2538). PRs and issues are from `gh` (the 1,000 most recent of each, which reach back to October 10). Line numbers are `src/main/agents/watcher.ts` on that commit unless another file is named.

This is an investigation. No code changed.

## Answer in brief

- **The freeze runs through four Watcher paths added in four weeks.** Paired-host reconcile (#975, October 13), the paired-host owned-request scan (#1762, October 29), the archive's per-change check (#1768, October 29) and the settle look (#1817, October 30). Each adds work that grows with the record or the thread count, and none of them is counted by the guard built to stop this.
- **The October 20 bound (75a3f62f0) could not hold.** It measures copies, deep comparisons and key builds at the October 20 owner's size. It has no paired-host case, and a loop over the record is not a copy, so a scan never moves its numbers.
- **The archive trims to a floor that scales with threads, not with history.** The keep rules hold about two closed requests per thread ever stopped or taken over, plus in-flight work. The live record can therefore sit above 200 closed requests by design. Which rule holds the 941 is the open question, and a tally can answer it (below).
- **The class is recurring, not new.** #1759 ("lag came back after a few days of use", October 29) is still open and describes the same cause. Thirteen Watcher-source PRs in the window were aimed at record size or per-update cost.
- **Nothing I found overturns the freeze diagnosis.** It adds the scan and the archive floor, and it confirms that the reconcile path is forced on each push.

---

## For the freeze fix

### The paths on the freeze, and what they cost

| Path | Where | Work per call | Added by |
|---|---|---|---|
| Paired reconcile, scheduled on every host push | `useRemoteHosts` subscribe at `watcher.ts:998` → `scheduleRemote` (5956) → `armRemote` (about 5970) → `reconcileRemote` (5989) | `armRemote` waits at least 250 ms. A forced read skips the cached projection (`const cached = !force ? …`). | #975 (October 13), with the retry and re-arm in da9b5d1e3 (October 12) on its branch |
| Stopped-request scan for each host | `reconcileRemoteNow` (5996), `stoppedRequests` with `slice(-1_000)` | One filter over all requests, then `.some` over participants and operations for each one | 828357f79 on the same branch, #975 |
| Owned-request scan and whole-record compare | `reconcileRemoteNow`: `const owned = this.view().requests.filter(…)`, and `JSON.stringify(this.view().current) !== JSON.stringify(master)` after each await | One filter over all requests, one serialization of the record per check, and `.some` over operations inside it | add30b5bd, merged as **#1762** (October 29) |
| Archive check on every publish | `publish()` → `archiveWhenDue()` (2572). Returns early unless the record object changed. Then `closedWatcherRequests(record)` (`watcherArchive.ts:76`) walks every request. | O(requests) on each new record. Keep rules run when closed ≥ 250 (2578) and the floor allows it. | 79676e88d, merged as **#1768** (October 29) |
| Settle look on every publish | `publish()` → `lookForSettled()` (`watcher.ts:1212`). When a watched thread is settled, `record.operations.flatMap(…)`. | O(operations) per publish while a watched thread is settled | 321b3a42a, merged as **#1817** (October 30) |

Your earlier freeze fixes: **#2515** changes the archive's keep rule (narrowed to the newest closed request per stopped thread; before, every one was kept). It makes the record smaller, not larger, and it was merged on November 12, the day before the Owl build you are measuring. Whether that build includes it is for you to check. **#2518** saves main's stack from the hang watch; it is diagnostics, not on the Watcher path. **#2521** reads a moved checkout once for every thread in it (ADR-0142); it is thread git reads, not the Watcher record.

**Cadence, not measured.** Three candidates for the "every few seconds" re-match, in order of how directly they trace to the code:
1. Every host push calls `scheduleRemote(hostId, force)`, and `force` defaults to true (`watcher.ts:998`). A forced read never uses the cache.
2. `watcherChanged(hostId)` is called without the force argument at `desktopHostRouter.ts:743` and `:754`, and on the shell-signature path (about 653–660). The Watcher-only push passes `force = false`. So a shell-signature change forces a full read.
3. Retries (`retryRemote`, 6103 and 6106) back off from one second to 30 seconds, so a host that fails intermittently is re-read on that schedule.

Measure which one fires with the freeze recorder before assuming any of them.

### Why 75a3f62f0's bound did not hold

The commit is "Keep Watcher's per-update work from growing with its record and the thread count" (October 20). Its test is `tests/perf/watcherPassCost.perf.test.ts`, and its fixture is `tests/fixtures/watcherAtScale.ts`.

1. **The fixture is the owner's October 20 size, and the owner has grown past it.** `watcherPassCost` builds 160 requests, 149 operations, 5 watches and about 250 threads (its header). The ownerScale fixture says the record reached 1,255 requests and 1,126 operations by October 28. Your evidence has 941 live requests and 1,108 operations today. I did not re-measure that.
2. **It counts copies and comparisons, not work.** It spies on `watcherRecords.copy` and `mutate`, on `clonePlainData`, `isDeepStrictEqual`, `JSON.stringify` (for target keys) and `structuredClone`. A loop over `record.requests` is none of those. `watcher.ts` has **0** `bump(` calls and about **260** expressions that walk `requests`, `operations` or `watches` (a regex count, approximate). The `watcherRecordComparisons` and `watcherRecordCopies` budgets are fed by spies inside the test file (`ownerScaleWorkBudget.perf.test.ts` near line 113), not by any `src/` code path. One of them is 0 everywhere.
3. **No paired-host case.** `watcherPassCost.perf.test.ts` and `watcherAtScale.ts` contain **zero** references to remote or paired hosts. `ownerScaleWorkBudget` does add a remote host (40 threads), but it counts only the 26 kinds in its `KINDS` list, and none of them is a scan, an archive check or a settle look.
4. **The fixes after the bound were judged by copies.** #1762 is titled "Stop Watcher copying its whole record for every check it reads." It removed copies and wrote the first whole-record scan on the same path (add30b5bd). A copy-count budget reads that as a gain. (This is an inference from the title and the commit. I did not diff the removed copies.)

### Why the archive is not trimming the record

- **The trigger has a floor.** `archiveWhenDue` moves work only when closed requests reach 250 (200 kept plus a batch of 50, line 2578) and at least 50 are archivable (2581). Otherwise it sets `archiveFloor = closed + 50 − archivable` and waits for more closed requests. A record whose keep set is large can sit above 250 closed with no further attempt until the floor is passed.
- **The keep set is sized to threads.** `archivableWatcherRequests` (`src/main/agents/watcherArchive.ts:109–146`) keeps:
  - reservations and each taken-over thread's last request;
  - requests with an operation under way, fenced or reserved;
  - the newest closed request for each **taken-over** thread;
  - the newest closed request with a **stopped** participation for each stopped thread (after #2515, which narrowed it from every one);
  - the newest request per Watcher conversation for takeover lines;
  - requests with a followup that has no message ID;
  - anything `retainsOperation` (`watcher.ts:2596`) holds: a dispatch, a check, or an outcome still `working` or `background`.

  So the floor is about two requests per thread ever stopped or taken over, plus in-flight work. The owner has about 250 threads, so several hundred closed requests kept by design is possible. 941 live is consistent with that rule. The archive may be working as designed.
- **Stuck `background` outcomes pin requests.** `retainsOperation` keeps every request whose operation outcome is `background`. #1261 (October 21, a Codex delegation that stayed `background` forever) and #2476 (November 12) show that outcome can stick. A few stuck outcomes would keep their requests live indefinitely.
- **Keep local history off does not block the trim.** `append` holds a non-desktop batch in memory (`watcherArchive.ts:457`), and `holds()` counts held batches (629), so the record still releases the request. What is held is lost on restart, which is the documented intent. This is not the cause.
- **What I could not verify.** The 941 breakdown. Tally it: call `archivableWatcherRequests(record, retains)` on the owner's saved record and count the closed requests each rule keeps.
  - If most fall under "newest per thread", the live record is bounded by threads, and the fix is to make per-change work O(change), not to trim further.
  - If most fall under `retainsOperation` or the followups, stuck operations are the cause, and the fix is in the outcome path.

### Tests and guards to add with the fix

1. **Count scans, not only copies.** Wrap the record's `requests` and `operations` arrays in the test fixture with a counting Proxy, and count element visits in `publish`, `reconcileRemoteNow`, `lookForSettled` and `archiveWhenDue`. Add those kinds to `ownerScaleWorkBudget`, flat along the history line. This would have caught #1762's scan, #1768's per-change count and #1817's flatMap when each was merged.
2. **A paired-host case in `watcherPassCost`.** One remote host, record at 160 and then 941 requests (149 and then 1,108 operations), a forced read and a cached read. Assert that scans and copies per read stay flat as history grows. This is the test the freeze most needs.
3. **A cadence case.** Fake clock, one minute of host pushes, and a count of reconcile reads per host, with a budget per minute. This settles the "every few seconds" question as a regression test, whichever of the three candidates it is.
4. **An archive invariant.** After N closed requests across T threads, live closed requests stay at or below 200 plus the keep bound (about 2T plus in-flight). Also, `archiveWhenDue` runs its keep-set scan once per floor change, not on each publish.
5. **Keep timing opt-in.** The count tests already run in `npm test`, which includes `tests/perf` (vitest include `tests/**`). Stopwatch budgets stay behind `SOTTO_PERF_ASSERT=1`.

---

## Regression record

"Found by" is from the issue or PR text I read. Where I could not trace a cause, the row says so.

| # | Change | Introduced by | Found by | Lived | Why tests and CI missed it |
|---|---|---|---|---|---|
| 1 | Paired reconcile on every host push, forced | #975 (October 13) | Not found before today; cadence not measured | About 31 days | No cadence test; no remote case in `watcherPassCost` |
| 2 | Whole-record owned scan and state compare per check | #1762 (October 29) | Owl lag, #1759 report | 15 days | Copy-count budget cannot see scans |
| 3 | Archive check walks the record on each record change | #1768 (October 29), the response to #1759 | Not identified | 15 days | No `KINDS` entry for archive checks |
| 4 | Settle look flatMaps operations on each publish | #1817 (October 30) | Not identified | 14 days | No `KINDS` entry for the settle look |
| 5 | "Lag came back after a few days of use" | #1759 (open), filed October 29 | Zach, from a one-minute profile (main 22% busy; copying the record the largest cost) | Open | The same class as rows 1–4 |
| 6 | Whole shell pushed about 20 times a second while Watcher writes | #1638 (October 27, in Owl 0.1.41) | Zach, "the iOS app is lagging still" (#1696) | About 1 day; fixed by #1697 | No push-rate test |
| 7 | News says "all checks passed" before CI ran | #1721 (October 28) | Zach: seen three times, one wrong GO MERGE (#2116) | 9 days to #2263; #2432 and #2443 followed | No test of the news while CI is running |
| 8 | "Pull request merged" news repeated about ten times in 25 minutes | Merge of #1491 (October 24), news path not traced | Zach, thread 5d1f8004 (#1495) | 9 days to #2035; the restart retell (#2064) still open | Told state not kept across a restart; no test |
| 9 | Forge threads with no pull request links | #2309 (November 7) | Zach and audit thread 10fd2e22 (#2430) | Fixed in part by #2438 (November 11); #2544 open | No test with a short `PATH` |
| 10 | A card answer does not act for Watcher | #2269 (November 6) | Zach's session (#2482, P1) | 6 days; fixed by #2484; #2485 open (Bug Bot on #2484) | Not traced |
| 11 | A permission card gives Watcher no words | #2230 (November 5) | Audit thread (#2433) | 6 days; fixed by #2442 | Not traced |
| 12 | About 20 wakes for busy finishes already superseded | #2226 (November 5) | Audit thread (#2434) | 6 days; fixed by #2439 | Not traced |
| 13 | Watcher talks to a delegated thread | Not traced | Zach's rule (#1217) | 19 days; fixed by #2333 | Not traced |
| 14 | Eleven audit issues, #2226–#2236 | October 20 to November 2 changes, not traced one by one | Zach's design pass, November 5 (#2226 body) | Each closed within 0–2 days | Design judgement, not a test |
| 15 | Red main from a Watcher merge | #1163 (October 18); reported in #1169 | CI: Windows gate red on two main runs | 1 day | CI caught it; it was red on main for two runs before the fix |
| 16 | Red main from a Watcher merge | #1868 (October 30); reported in #1877 and #1878 | Journeys on main | 1 day (fixed by #1883) | Found after the merge, on main; I did not check whether the PR's own run was green |
| 17 | Red main from a stable switch | #1384 (October 23) | Local runs (#1478, #1479) | Open since October 24 | Watcher e2e specs are not in CI |
| 18 | Red main, Watcher e2e | Oct 22 to Nov 10, causes not confirmed | Local runs (#1305, #1517, #2370, #2385) | Open | Not in CI |

Also relevant: #2116 and #1495 are open-ended follow-ups (#2064 and #2063 are open), and #1152 (wake on no progress) is open. The audit thread found row 14's cluster.

---

## Patterns, with counts

1. **`watcher.ts` has grown about nine times in a month.** 800 lines on October 12, 2,286 on October 16, 3,139 on October 20, 4,898 on October 27, 6,236 on November 3, 7,002 on November 13 (first-parent main). It has 70 imports and about 340 method-like declarations (a grep count). `watcherWakeUp.ts` went from about 327 to about 1,896 lines over the same period. One file carries the publish path, the reconcile, the archive trigger, the settle look, the news and the tools.
2. **Churn is high.** 241 PR merges in the window touched Watcher source (`src/main/agents/watcher*`, `watchedPullRequests`, `shared/watcher*`, the renderer's `watcher/`, and `watcherRoomChanges`). Of those, 122 touched `watcher.ts`. Authors: 193 by Zach, 48 by drakemorey.
3. **The record-size family returns.** Thirteen window PRs were aimed at record size or per-update cost, by hand-checked title: #1071, #1159, #1160, #1181, #1243, #1342, #1348, #1473, #1762, #1782, #1929, #1935 and #1945. Add the issues #1696 and #1759 and the open perf PRs #2405 and #2448. The October 20 bound was reopened about every 1.5 working days.
4. **Tests run on small fixtures.** `watcherPassCost` uses 160 requests and 149 operations. Its fixture and `watcherAtScale.ts` have zero paired-host references. The owner-scale budget covers the remote host, but counts 26 kinds, none of them a scan, archive check or settle look.
5. **CI counts; timing does not run on Owl.** The count tests run in `npm test` on every PR. Timing budgets are opt-in (`SOTTO_PERF_ASSERT=1`). The freeze reached a daily Owl build and was noticed there by Zach, and Owl builds have no perf gate.
6. **Paired-host paths are thin in tests.** Of 165 test files named `watcher*`, 6 name a paired, host or remote path. The two perf fixtures reference none.
7. **Watcher journeys are outside CI.** There are 10 Watcher e2e specs. CI runs the e2e list and the desktop smoke test only (`ci.yml` lines 335 and 351). The full Playwright suite stays local (`docs/ci.md`, cited in #1305). Six open issues record Watcher journeys failing on main: #1305, #1478, #1479, #1517, #2370 and #2385.
8. **Owl features are in most Watcher PRs.** 123 of the 241 window PRs mention Owl in the title or body. Owl ships from main daily, and a feature stays Owl until sent to stable. Rows 16 and 17 are Owl-era breaks that CI did not catch.
9. **Fixes stacked on fixes.**
   - Checks passed: #1721 → #2116 (issue) → #2263 → #2270 (stacked on #2263) → #2437 → #2432 (issue) → #2443. Four PRs and two issues in 15 days, for one invariant.
   - Forge PR links: #2309 → #2430 (issue) → #2438 → #2544 (open). Three PRs and one issue in seven days.
   - Card answers: #2269 → #2482 (issue) → #2484 → #2485 (open). Three PRs and one issue in seven days.
   - Merge news: #1491 → #1495 (issue) → #2035 → #2064 (open).
   - Heuristic upper bound: 134 window Watcher-source PRs cite an earlier Watcher-source PR near a fix word (a loose regex, so treat it as a ceiling). The chains above are hand-checked.
10. **How bugs were found.** Of 83 bug or P-labelled Watcher issues since October 16: 38 were reported by Zach or from a thread's own transcript, 26 cite a CI run or red main, 1 cites Bug Bot, and 18 match neither (a regex on issue bodies, approximate). Bug Bot appears in 24 Watcher-source PR bodies in the window. It caught #1157's issues, which were fixed in #1163, and its #2484 finding was left open as #2485.
11. **Merges into red main.** Three episodes in which a Watcher-related merge turned main red: #1163 (reported in #1169, closed the next day), #1868 (reported in #1877 and #1878, fixed by #1883 the next day), and #1384 (left open as #1478 and #1479). Three more Watcher e2e failures on main are open, and their cause is not traced.

---

## Options for Zach

These are choices, not decisions. Each names what it would have caught from the regression record.

1. **Count scans in the owner-scale bound.** A test-only counting Proxy over the record's arrays, with scan kinds for publish, reconcile, archive and settle. Catches rows 2, 3 and 4 at review time. Cost: slower tests and some setup work.
2. **Add a paired-host case and a one-minute cadence case to `watcherPassCost`.** Catches row 1 and the scan in row 2 on the paired path. Cost: small.
3. **Decide what the live record is bounded by.** Right now the keep rules make it about two requests per thread ever stopped or taken over. If you want a fixed cap instead, that is a product change to the archive (ADR-0073), and it decides whether 941 is a bug. The tally in the freeze section answers which rule holds it. Needs your call.
4. **Index the record and split `watcher.ts`.** Keep requests by ID, operations by request and by target, and watches by target, in one module that `mutate` updates. Per-change work then becomes a lookup. Split `watcher.ts` (7,002 lines) along reconcile, archive, news and tools. This removes the class at the source (rows 2–4). It is the largest option and needs its own plan.
5. **Run the Watcher journeys in CI, or nightly.** Catches rows 16 and 17 at PR time, and the six open red-main issues sooner. Cost: CI time, or a nightly job.
6. **One invariant test per stacked family.** Checks passed on the news only when CI has finished; a short-PATH host still links PRs; a card answer starts a turn; a told merge stays told across a restart. Catches the chains in pattern 9. Cost: small per family.

## Method and limits

- PRs: the 1,000 most recent (oldest created October 10). Issues: the 1,000 most recent (oldest September 23). Both cover the window.
- Merges and files: first-parent merges on `origin/main` since October 10 (971), each with its changed file list.
- "How found" is a regex on issue bodies (run or job IDs, "Bug Bot", "Zach", "session"). It is approximate.
- Not measured: today's freeze profile, the 941 breakdown, and which of the three cadence candidates fires. I used your evidence for the first two.
- Review data was not collected. I did not check who approved each PR.
- Line numbers are on `origin/main` 57b02f3b1 and may shift after this PR.

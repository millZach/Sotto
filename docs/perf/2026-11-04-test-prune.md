# Pruning low-signal tests (November 4, 2026)

T3 Code deleted about 11,000 of its 25,928 tests in one pull request ([pingdotgg/t3code#22557](https://github.com/pingdotgg/t3code/pull/22557)) so its CI would run faster and flake less. Zach asked for the same here. This note says what T3 did, what Sotto's suite looked like, what was cut and why the cut is small.

Measured means read from a CI run or counted in the tree. Estimated means worked out from measured numbers.

## What T3 did

- A Claude Haiku 5.5 swarm read every test file against one rubric. It deleted type-redundant tests, trivial logic, basic DOM behaviour, real or fake timers, mock-call mirrors, smoke tests, duplicate table cases and wall-clock perf asserts. It kept orchestration and event sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing and deterministic race fixes.
- About half the files got two independent passes, with a third vote on disagreements. Deletions were applied with the TypeScript AST by test title. knip then found exports only the deleted tests used.
- Its review restored 22 auth boundary tests the swarm had cut as "timing". Two days later four more pull requests restored tests the cut had removed: DST scheduling (#23991), project settings permissions (#24011), clipboard secret redaction (#23980) and a render scheduler (#23977). In each case the deleted test had been the only one guarding a rule. A fifth pull request (#24058) deleted 126 more cases as the price of those restores, and its own review restored nine of them.

## Sotto before the cut (measured)

At `7b374639f` (tagged `test-prune/base-2026-11-04`) Vitest had 15,514 test calls in 1,578 files under `tests/unit`, `tests/integration` and `tests/perf`. `it.each` rows and loops make about 20,000 results on a run.

- **The pull request's critical path is the Windows test shards.** Their median is 10.9 minutes, 9.1 of them in the test step, against 7.9 for Checks and desktop (60 runs on `main`, October 25 to November 4).
- **A push to `main` that runs the iPhone jobs waits on them.** The small phone's journeys took a median 63 minutes and the large phone's 59.
- **Cheap tests cost almost nothing.** The 9,565 tests that take under 50 ms add up to 1.5 of the suite's 81.5 summed minutes on Windows. A third of each shard is imports, environments and transforms rather than tests.
- **Time and flakes sit in slow integration tests.** The 50 slowest files take 54% of the time: adapters, the host contract over a socket child, Git and worktree journeys, and Watcher. All 45 open flake issues are about tests in those areas or about iPhone journeys.

## How the cut was chosen

1. `scripts/test-prune/inventory.mjs` lists every case with its time on a passing `main` run, its CI failures, the issues and ADRs it names and its timer use.
2. The swarm read 1,341 files in 129 batches against `scripts/test-prune/rubric.md`. That is T3's rubric with Sotto's keep list on top:
   - provider adapters, the host wire, auth and permissions, privacy, persistence, and Git and worktree safety;
   - Watcher's settle and news, race fixes, and the composer's look and the Watcher scene;
   - Owl and memory gates, counting performance guards, named regressions, external formats and the agent shell.
3. The swarm ran on Claude Haiku 5.5. Files in a sensitive area (621) got two independent passes, with a third vote on disagreements. The other files got one pass. The script keeps any case that names an issue or ADR, whatever the votes.
4. The script did not judge e2e specs, perf benchmarks or the files `AGENTS.md` and `docs/ci.md` name. CI runs none of the e2e specs but the desktop journeys.
5. Cases on the keep list that a judge called duplicates got two more independent checks that tried to refute the claim. 14 survived, and Zach approved them.
6. Every proposed deletion was then read and audited by hand. That restored 55 cases, and the two-axis review on Sol put back two more (a Claude adapter's disconnected update, and the composer's trace through its quiet chip):
   - tests that only the typecheck enforces (`expectTypeOf`, `@ts-expect-error`);
   - an Owl gate and preload-boundary and privacy guards;
   - reduced motion and frame pacing;
   - Watcher scene tests;
   - values an ADR or a design pick fixes, and a file ADR-0116 relies on;
   - four "duplicates" whose covering case was also on the list. One pair would have left the composer's trace rule (ADR-0019) nearly untested.

T3's own rubric, run on the same Haiku over 20 of the same batches (1,857 cases), deleted 2.7% of them, against 0.8% on Sotto's. 16 of its 50 were perf benchmarks, which Sotto's rule keeps. Most of the difference from T3's 43% is in the tests, not the rubric. Sotto's tests are written as behaviour sentences, and the #123 audit had already trimmed them.

## What went (measured)

| | Before | After |
| --- | --- | --- |
| Vitest test calls | 15,514 | 15,193 (−321), plus 4 in the new `testPrune.test.mjs` |
| Test files | 1,578 | 1,574 (−4), plus `testPrune.test.mjs` |
| Test lines | 301,280 | 298,641 (−2,807, +166 of which 126 are `testPrune.test.mjs`) |
| Summed Windows test time | 81.5 min | 79.9 min (−92.7 s) |

77.8 s of that time is two seeds of `watcherThreadChanges`' seeded run, which now runs one seed for each window mode. The other cases took 15 s together. Spread over six shards of two workers, a run should finish about 8 s sooner (estimated). No open flake issue is settled: every flaky test is on the keep list.

By kind: 104 duplicates, 103 trivial, 56 DOM-only, 18 vacuous, 17 timer plumbing, 16 mock mirrors, 6 type-redundant and 2 flaky by design. By area: 170 in `tests/unit/renderer`, 101 in `tests/unit/main`, 37 in `tests/unit/shared` and 10 in `tests/integration`.

## The iPhone journeys

Deleting journeys saves little. Two journeys now run on the small phone only. Each one guards a bug that only a narrow screen shows (#1848, #1857), and together they took about 1.5 minutes of the large phone's job (measured). The real time was in `testThreadPageKeepsItsPlaceAndReadsMarkdown`, which took 183 to 478 s. It read its Markdown and tables with the reply keyboard still up, and on that squeezed page each accessibility reading took 5 to 31 s. It now puts the keyboard away first and checks that it went. That should save about 4 to 5 minutes of the small phone's job and 2 to 3 of the large phone's (estimated). The first macOS run will measure it.

## Applying it again

`node scripts/test-prune/apply.mjs` applies `scripts/test-prune/manifest.json` to a checkout from its root:

- It finds each case by its suites' titles, its own title and its position among cases with the same title. A file marked whole goes only when every case in it is listed, so a case added since stays.
- It removes the case, the comment lines directly above it, any suite left empty and the imports, helpers and loops nothing uses any more. A file's header comment and directives such as `// @vitest-environment node` stay. It also drops deleted files from `tests/fixtures/testDurations.json`.
- `--check` changes nothing, and exits 1 when a listed case has been renamed or removed.

Run it on a fresh `main` rather than resolving conflicts by hand. `tests/unit/scripts/testPrune.test.mjs` holds the script to that.

# Certified detail records — October 13, 2026

Step 3 of #991, behind the existing `streaming-publish-cost` Owl feature. Both prerequisite PRs
(#1003 and #1007) are merged into the measured base, `6f6795a6f`. The handoff named a
`certifiedShell.ts` helper that this base does not contain: its actual path is the coordinator's
`detailRevision` and `detailUpdate`, with certification owned by `activitySnapshots.ts`.

## What changed

A certified activity record is recursively copied and frozen by Sotto's activity owner. The
coordinator now compares the previous revision's records by identity, and computes the existing
activity signature only for records replaced since then. Signatures of owned records are cached
weakly by record identity. Mutable inputs still compute signatures afresh, including externally
frozen arrays whose nested records Sotto does not own. Messages keep their existing comparison.

The delta arithmetic accepts the coordinator's signature reader and skips matching record
identities before asking it for a signature. The default reader and stable path are unchanged.
The coordinator's private delta baseline shares certified records, while whole details and
delta payloads stay copied and writable for callers. Replacements still use the existing
signature rules, including the existing trade that same-length text replacements are not
distinguished. Reorders and removals retain the full-detail fallback. No new protocol field,
production dependency, provider send, setting or feature switch is added.

Closing a detail target or clearing its history cache releases record and signature references,
but keeps a text-free revision counter. A reopened whole detail advances from that counter so a
window or socket client holding an older cached detail accepts it. Both independent review axes
caught the initial cache cleanup resetting the revision; close/reopen and privacy cleanup have
durable regressions for this lifetime.

## Measurement

Windows development laptop, Node v24.14.1. These are synthetic generated histories, not a user
profile. No live provider is contacted and no thread words are printed. The raw logs survive
outside the worktree under `.zstack/perf-991-remaining/` (`detail-before.log`,
`detail-after-initial.log`, `detail-after.log`). Times are evidence rather than budgets.

Commands:

```powershell
$env:SOTTO_PERF_BENCH='1'
npx vitest run tests/perf/certifiedDetail.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/perf/certifiedDetailStreaming.perf.test.ts tests/perf/certifiedDetail.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

The first benchmark times revision and delta publishing, replacing one record each window.
It reports the median of 90 measured windows after 10 warm-up windows. Before was run before
the first production edit; after uses the Owl gate. The measured path includes both existing
delta applications, not just a signature helper.

| Records per viewed thread | Viewed threads | Before ms/window | After ms/window |
| --- | ---: | ---: | ---: |
| 200 | 1 / 3 / 6 | 0.473 / 0.905 / 1.040 | 0.064 / 0.188 / 0.444 |
| 1,000 | 1 / 3 / 6 | 0.805 / 2.641 / 5.122 | 0.219 / 0.698 / 1.437 |
| 2,000 | 1 / 3 / 6 | 1.756 / 5.919 / 15.609 | 0.507 / 1.711 / 3.279 |

The second benchmark runs native-shaped event and certified activity publication through the
workspace, coordinator and the window's coalesced state/detail publishers. Each viewed thread
holds 2,000 activity records and streams text plus command output over 60 windows, three rounds.
The store and workspace keep steps 1/2 enabled in both paired runs; only the coordinator detail
gate changes. This isolates step 3 from their storage improvements. It asserts the pane really
holds all 2,000 records and that all final streamed message text reaches the store.

| Viewed streaming threads | Before CPU ms/chunk | After CPU ms/chunk | Before active ms/window | After active ms/window |
| --- | ---: | ---: | ---: | ---: |
| 1 | 5.483 | 2.867 | 5.481 | 3.521 |
| 3 | 4.856 | 2.167 | 13.947 | 7.311 |
| 6 | 4.036 | 2.169 | 23.519 | 14.105 |

Per-chunk CPU stays about flat as more threads stream. Total work per window still grows with
the number of viewed histories: delta maps, order validation and both applications remain, as
do shell construction and other work outside step 3. This change does not claim to remove them.

## Correctness

`certifiedDetail.test.ts` compares exact revisions and payloads with stable through unchanged
publishes, growth, same-length replacement, reorder, trim, reset, certification transitions,
mutable nested edits and message appends. Caller edits to a whole detail or a delta cannot
change the coordinator's private certified baseline. The existing shared arithmetic and
shell/detail suites passed before the two lifetime regressions were added: 65 tests. Full gates and Electron evidence are recorded in
the accompanying verification note once completed.

#925's unchanged-thread ingestion sharing, #555's usage ledger, Claude activity ingestion,
#993's classification, changed-thread shell transport and Watcher publishing remain outside
this step.

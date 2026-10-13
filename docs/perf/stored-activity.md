# Activity records a thread nobody opens

October 10, 2026, issue #918. Every thread kept up to 2,000 activity records in memory for the whole run, whether or not anyone opened it. On the owner's machine that was 196 threads and about 108 MB of records, and #917 found it was what made each copy between the adapter and the window so expensive. The workspace read every saved thread's records at start, and the Claude adapter copied every saved Claude thread's records at connect to resume its transcript cursor, then published them back on every emit.

Now a thread's records stay in the thread store until something needs them (**stored activity**, ADR-0016's October 10 amendment). A start reads each thread's activity marker and record count, not its records. A window observing the thread reads them back, as does its provider publishing a record that is new or changed for it. After a save, a thread no window is looking at and nothing is running in lets them go again. Claude resumes its cursor on the store's word that it holds the records, and reads them the first time a transcript line or live frame changes that thread (ADR-0015's October 10 amendment).

The first start after updating still reads every record once. Before the agent roster existed, a subagent record kept its task's words in the activity table, and that read is what moves them to the roster. The store records that it has happened after the first save, and later starts read none.

## The benchmark

`node scripts/archive-startup-bench.mjs` from the repository root, as in [`2026-09-27-archive-startup.md`](2026-09-27-archive-startup.md): fresh Node processes with `--expose-gc`, synthetic archives of 1, 50 and 200 settled threads, each with 80 messages and 100 command records of about 1 KiB. Its seed now records the roster move, so it measures every start after the first. The baseline is the same benchmark on f04ca2f65, the #917 branch this builds on.

Windows 11, Node 24.14.1, the development laptop with the owner's Sotto running beside it. Three timing runs and one counting run per size; [baseline](../../artifacts/stored-activity/startup-baseline.json) and [candidate](../../artifacts/stored-activity/startup-candidate.json) samples are kept.

| Saved threads | Records read at start, before / after | Retained heap after start, before / after | Start, before / after (three runs) |
| --- | ---: | ---: | ---: |
| 1 | 100 / 0 | 0.56 / 0.33 MB | 37, 37, 42 / 28, 27, 26 ms |
| 50 | 5,000 / 0 | 8.64 / 0.66 MB | 164, 265, 251 / 70, 93, 74 ms |
| 200 | 20,000 / 0 | 32.76 / 1.37 MB | 904, 2,026, 1,272 / 263, 254, 198 ms |

The read count and the heap are the steady results: at 200 threads, 25.3 MB of record JSON is no longer parsed at start, and about 31 MB less stays in the heap. The start times moved with the load beside them and say only that the start got no slower.

## What it costs

- Opening a thread reads its records from the store once, a single indexed read of at most 2,000 rows, before the pane's first publish.
- A thread's sidebar count comes from the store's count for a stored thread. It has no running turn, since a thread with a running record is never let go.
- Turning Keep local history off drops a stored thread's records for the rest of the run, as a thread out of view has no messages after the switch.
- A thread whose live subagent records still carry their task's words stays in memory until the next start, since the store keeps only their classification.

## What is left

The Codex adapter keeps the records of every thread it has read this connection, and Grok keeps its history reads. Neither changed here; both are where memory would go next if it is still high.

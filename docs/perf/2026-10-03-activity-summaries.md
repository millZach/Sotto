# Activity summaries for a paired phone - October 3, 2026

Issue #701. A thread's detail carried every activity record whole to every socket client. On the owner's bug-audit
thread that was 842 records and 3.53 MB, 2.61 MB of it command output. The iPhone's activity list reads only each
record's `id`, `sequence`, `kind`, `status`, `title`, `command`, `exitCode`, `durationMs` and `startedAt`, and each
change's `path` and `kind` (`Activity` in `apps/ios/Sources/SottoCore/Wire.swift`, and the same type inside
`ThreadDetailDelta`). Nothing else in the app or SottoCore reads an activity field. So every observe, every whole
detail and every delta for a working thread sent the phone megabytes it decoded and dropped.

## The change

The listener offers a new host feature, `activity-summaries`, on the headless host and the desktop's phone listener
(ADR-0025, October 3 amendment). A client that accepts it in hello is sent each activity record as its activity
summary (`activitySummary` in `src/shared/hostProtocol.ts`): the fields above plus `turnId`, which the activity schema
requires. A summary is still a valid activity record, and a delta of summaries keeps its revisions and removals, so
the phone applies it as before. The listener makes a thread's summaries once per update and hands the same ones to
every client that accepts them. A `detail` read follows the same rule. Everyone else, the desktop's own host client
included, is sent records whole. The iPhone's hello now accepts the feature, so the saving needs a new iPhone build.

## How it was measured

`tests/perf/activitySummaries.perf.test.ts` builds a synthetic thread from a seeded generator in the owner's
proportions: 842 records, mostly commands with a few kilobytes of output each and some long logs, then reasoning,
edits with diffs, tools and subagents. It measures each frame as the listener sends it, one JSON text frame. The byte
counts are the same on every run and are asserted in the default run. The timings run only under
`SOTTO_PERF_BENCH=1`. Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1, with other agents' suites running beside it.

## Before and after

| Frame | Whole records | Activity summaries | Saving |
| --- | ---: | ---: | ---: |
| `detail` push of the 842-record thread | 3,364,677 bytes | 286,018 bytes | 91.5% |
| `detail-delta` for one streaming command (a 22 KB log grew by 800 characters) | 22,499 bytes | 523 bytes | 97.7% |

The synthetic thread carries 2,600,442 bytes of output, close to the owner's 2.61 MB. Its summaries come to 286 KB
against the 367 KB the issue estimated for the owner's thread, whose titles and commands run longer.

What making the summaries costs the host, median of 40 runs after 5 to warm up:

| Work | Time |
| --- | ---: |
| Summaries of the 842-record detail | 0.18-0.35 ms |
| Summaries of the one-record delta | 0.001 ms |
| `JSON.stringify` of the whole detail frame | 8.1-8.5 ms |
| Summaries and `JSON.stringify` of the summary frame | 1.1-1.2 ms |

Making the summaries costs less than the stringify it saves, so a phone that accepts them is cheaper for the host too.

## What was not changed

- Messages are sent whole. The phone shows them.
- The desktop's own remote-host client asks for nothing new and still gets whole records: its activity rows open to
  the output.
- A delta still carries a record whenever its signature changes, including when only its output grew. For a client
  of summaries that record is a few hundred bytes; telling which updates leave the summary unchanged would need a
  copy of what each client holds.
- `title` and `command` are sent as long as the record has them. A command that writes a file through a heredoc can
  be long; nothing in this change shortens it.

Run the benchmark on an idle machine:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/activitySummaries.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

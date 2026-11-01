# Codex's rollout reader skips what it does not read - November 1, 2026

Part of #992, the item "Reading a Codex rollout parses every line". Measured with
`tests/perf/codexRolloutRead.perf.test.ts` over real rollouts on forge, against origin/main's sources at `a028edc36` for
the before column.

```sh
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_CODEX_HOME=$HOME/.codex NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/codexRolloutRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## What it cost

Sotto reads each Codex thread's rollout in main for the turn and message identities it keeps, and for input typed into
Codex outside Sotto. It read every line: each was joined from its chunks, decoded from UTF-8, parsed and checked against
the entry schema. What it takes is a few kinds of entry: a turn's context, start and end, a user's or the agent's message
as an event, a completed user message, and the agent's message as a response item. Everything else is tool calls and
their output, reasoning, token counts, and the user's and developer's messages as response items, which carry the
instructions, attached files and pictures.

Across forge's 1,628 rollouts (7.0 GB, 219,794 lines), the lines the reader takes are 6.5% of the lines and 24 MB of the
bytes: 0.35%. Every other byte was decoded and parsed to be thrown away. That runs whenever a rollout is read: as Codex
writes a turn, on the tick that catches up a thread with no saved position, and when a thread is opened or sent to.

## The change

`mayBeRead` reads a line's first kilobyte at most and answers whether the line may hold anything the reader takes.
Codex writes every line as `{"timestamp":…,"ordinal":…,"type":…,"payload":{"type":…`, and a message's role or a
completed item's type follows among the payload's first keys. It reads that start one JSON token at a time: a string to
its closing quote, a number, a literal. It answers no only for a line that starts exactly that way, so the kinds it finds
are the line's own and not a nested object's, and words inside a value cannot fool it.

- The read loop asks it of each line's first part, read as Latin-1. A line it answers no for is skipped where it stands,
  through the same path that already skipped a line too long to read: it is never joined, decoded or parsed.
- It answers no only from what it has seen, so a line's start answers for the whole line. A start cut short by a read,
  an escaped key or value, a nested value before the key it looks for, and a key it decides by named twice (JSON.parse
  keeps the last) all end in yes. So does a line in any other shape: a change in Codex's format costs speed, never a
  message.
- Its work is bounded by that kilobyte whatever the line holds. Each token has one way to match, so nothing backtracks.

The first version looked for seven words anywhere in a line. It was slower than parsing (4.44 against 3.15 CPU ms per
MB): JSON.parse is fast over long strings, and a line without any of the words was scanned seven times end to end. The
second matched the start with regular expressions, which review found could backtrack for hundreds of milliseconds over
a crafted line of a few hundred bytes, and could throw on a sixteen-million-character value when run on a whole line.

## Before and after

Real rollouts, forge, read-only. The 55 newest rollouts under 20 MB, about 120 MB, each read from its first byte, as the
first read of a thread with no saved position does. Before and after each ran in a process of its own, alternated, three
runs each; medians. Both reported the same 49 messages and kept the same identities for every thread, word for word (one
digest over both).

| | Before | After |
| --- | ---: | ---: |
| CPU, reading 120 MB of rollouts | 367 ms | 181 ms |
| CPU per MB | 3.06 ms | 1.51 ms |
| Wall time | 259 ms | 124 ms |
| Lines parsed, of every line on forge | 100% | 6.53% |
| Bytes parsed, of every byte on forge | 100% | 0.35% |

The last two rows come from the benchmark's second test, which reads all 1,628 rollouts on forge (219,794 lines,
6,973 MB) and fails on any line the reader takes something from that the skip would pass over. It found none.

The per-MB figure covers the whole read: the file reads, the newline search, the identity tracker and the reports. What
is left is mostly the 1 MB reads themselves and the newline search over each.

## Guarded by

`tests/unit/main/codexRolloutLineSkip.test.ts`:
- the check reads every kind of line the reader takes, and every start of one, and skips the kinds it does not take;
- it parses a line in another key order, one that escapes or repeats a key it decides by, and one with a nested value
  before the key it looks for;
- it reads no more than a line's start, over a line of many negative numbers and one with a sixteen-million-character
  value;
- over a rollout with lines longer than a read, in several-byte characters, the watcher reports the same messages,
  parses only the lines it reads, joins none of a skipped line's bytes, and keeps the identities every line read in full
  gives.

`tests/perf/codexRolloutRead.perf.test.ts`, under `SOTTO_PERF_BENCH=1` with a Codex home: the timing above, failing if
the messages or identities differ, and the whole-corpus check.

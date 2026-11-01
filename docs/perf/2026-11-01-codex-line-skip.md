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

Across forge's 1,616 rollouts (6.9 GB, 217,848 lines), the lines the reader takes are 6.5% of the lines and 24 MB of the
bytes: 0.35%. Every other byte was decoded and parsed to be thrown away. That runs whenever a rollout is read: as Codex
writes a turn, on the tick that catches up a thread with no saved position, and when a thread is opened or sent to.

## The change

`mayBeRead` reads a line's first characters and answers whether it may hold anything the reader takes. Codex writes every
line as `{"timestamp":…,"ordinal":…,"type":…,"payload":{"type":…`, and a message's role or a completed item's type
follows among the payload's first keys. The check is anchored to that start, so the kinds it finds are the line's own and
not a nested object's, and it steps over a key's value whole, so words inside a value cannot fool it.

- The read loop asks it of each line's first part, up to 1 KB read as Latin-1. A line it answers no for is skipped
  where it stands, through the same path that already skipped a line too long to read: it is never joined, decoded or
  parsed.
- It answers no only from characters it has seen, so a line's start answers for the whole line, and a start cut short by
  a read ends in yes. A line that does not start the way Codex writes them today is parsed and checked as before. A
  change in Codex's format costs speed, never a message.
- Over every line of forge's 1,616 rollouts it answered yes for every line the reader acts on, and every line started the
  way it expects.

The first version looked for seven words anywhere in a line. It was slower than parsing (4.44 against 3.15 CPU ms per
MB): JSON.parse is fast over long strings, and a line without any of the words was scanned seven times end to end.

## Before and after

Real rollouts, forge, read-only. The 52 newest rollouts under 20 MB, about 120 MB, each read from its first byte, as the
first read of a thread with no saved position does. Before and after each ran in a process of its own, alternated, three
runs each; medians. Both reported the same 46 messages, word for word (one digest).

| | Before | After |
| --- | ---: | ---: |
| CPU, reading 120 MB of rollouts | 389 ms | 175 ms |
| CPU per MB | 3.25 ms | 1.46 ms |
| Wall time | 257 ms | 128 ms |
| Lines parsed, of every line on forge (counted over all 1,616 rollouts) | 100% | 6.5% |

The per-MB figure covers the whole read: the file reads, the newline search, the identity tracker and the reports. What
is left is mostly the 1 MB reads themselves and the newline search over each.

## Guarded by

`tests/unit/main/codexRolloutLineSkip.test.ts`: the check reads every kind of line the reader takes and every start of
one, skips the kinds it does not take, parses a line in another key order, and is not fooled by a key's words inside a
value. Over a rollout with lines longer than a read, in several-byte characters, the watcher reports the same messages
and parses only the lines it reads.

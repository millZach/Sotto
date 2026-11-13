# A read of a paired host's state without copying the drafts held for it - November 13, 2026

Measured with `tests/perf/remoteDraftView.perf.test.ts`: a desktop's client of a paired host holding 40 and 150 of the
user's unsent drafts there, one a thread, each a long prompt with two attachments, reading the host's state the way every
reader that only reads does (`SocketHostService.view`).

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/remoteDraftView.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## What it cost

A desktop keeps the drafts the user types in a paired host's threads until the host has them (`RetainedDraftStore`), and
lays them over the host's state on every read of it. Every Watcher pass and every router build reads that state. In the
owner's 60-second recording on Owl 0.1.43-owl.20261113.1 it was read about 500 times, and each read copied every retained
draft twice (`RetainedDraftStore.list`, a `structuredClone`): 1.6 ms a read, 0.8 s of main's minute. Watcher's observe
pass read it twice for each thread taking part on the host (`requestDone`, through `owningSnapshot` and `connected`), and
the router's `snapshot` read it before finding its kept snapshot unchanged. The November 12 recording, on the Owl before,
read it about 94 times a minute at the same cost a read; more Watcher passes and more threads taking part on the host made
the rest.

## The change

- `RetainedDraftStore.read` hands out the store's own drafts without a copy, for a reader that only reads. A draft is
  never edited in place: a save replaces it. Each one it hands out is frozen with everything in it, the feedback an
  attachment carries included, so a reader that writes into one fails rather than changes the user's unsent words.
- The socket service's `view` lays those over the host's state, and its check for a failed recovery reads them too.
  `shell`, whose caller may write into what it is given, still lays copies (`list`).

## Before and after

On the owner's laptop, Node 24.14.1, three runs each, 200 reads after 20 to warm up. Before is `cd02ed610`.

| One read of the host's state | Before | After |
| --- | ---: | ---: |
| 40 drafts held | 0.25 to 0.27 ms | 0.03 to 0.04 ms |
| 150 drafts held | 0.93 to 0.98 ms | 0.12 to 0.17 ms |
| Copies made of the drafts | 2 | 0 |

The drafts the owner's desktop held that day were in memory only, so their number is not known; a read cost 1.6 ms there.
What a read still costs with many drafts is laying each over the list of the ones before it, which grows with the square
of the drafts.

## The guard

`tests/perf/remoteDraftView.perf.test.ts`, "lays the store's own drafts over a read of the host, frozen, and copies them
only for the shell", runs in the default suite: two reads make no copy and hand out the same draft, a write into one
throws, and the shell's drafts are copies a write into does not reach.

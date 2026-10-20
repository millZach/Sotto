# Watcher's tool results, slim by default (#1191)

October 19, 2026. Everything a `sotto_threads` tool returns stays in Watcher's conversation, and every later call of Watcher's reads it again. In the October 19 session behind #1189 and #1191, one `list_threads` returned 50 to 130 thousand characters, one `list_projects` 493 thousand, and one `read_thread` with `limit: 1` about 7 thousand tokens of evidence to bring back a one-paragraph reply.

## What changed

- `list_threads` gives slim rows by default: the thread, its title, project, status, group, what it waits on, whether Watcher watches it and its standing watch, whether it is connected, and a short summary of each open pull request. `detail: "full"` gives the rows as before. `watchedOnly: true` lists only the threads Watcher watches.
- `read_thread` gives one summary per pull request in place of every evidence fact. `evidence: "full"` gives every fact.
- `list_projects` leaves out the model lists unless `includeModels: true`, and takes `projectId` and `query` (title or folder) filters.

A pull request's summary is its number, its address too in a read and in a roster row where another of the thread's pull requests has the same number, its state and checks, `approved` and `autoMerge` only when on, and `stale` only when a fact is not fresh. The tools still build their full results, as a paired host answers them. The desktop takes what Watcher asked for from them as the last step, and never sends a paired host the new keys, so a host on any version answers as before.

## Measured

`tests/unit/main/watcherSlimReads.test.ts`, run with `SOTTO_PERF_REPORT=1` to print the sizes, on synthetic results shaped like the session's: fifty threads with five open pull requests each, five GitHub facts per pull request plus the working copy; a one-message read of one of those threads; and a hundred projects on a computer offering a hundred models. Sizes are characters of JSON.

| Read | Before | After | Saved |
| --- | ---: | ---: | ---: |
| `list_threads`, 50 threads | 543,946 | 24,526 | 95% |
| `read_thread`, `limit: 1` | 9,865 | 947 | 90% |
| `list_projects`, 100 projects | 1,925,872 | 25,672 | 99% |

The synthetic roster carries more facts per row than the session's did, so its full size is larger than the 50 to 130 thousand seen there; the share saved is the point. The test holds the slim results under a tenth, a fifth and a fiftieth of the full ones.

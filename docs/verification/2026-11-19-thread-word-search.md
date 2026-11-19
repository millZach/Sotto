# Search threads reads what was said

November 19, 2026, on forge, for [ADR-0209](../adr/0209-search-threads-reads-what-was-said.md). Zach's picks from `docs/prototypes/thread-word-search-prototype.html`: variant A, the user's messages and the agents' replies, desktop and iPhone with each computer searching its own threads, stable.

## In the running app

`tests/e2e/thread-word-search.spec.ts` against the built app under `xvfb-run` at 1920x1200. The design-threads profile's **Release notes 1.4** is given 306 messages, among them a reply and an earlier message of the user's that say "zebra crossing timer"; its title, project, status and the user's last message do not.

- Typing "zebra crossing timer" in Search threads finds it. Nothing the row says holds the phrase, so before this change the search could not find it (not run on `main`; the spec's own check that *Nothing matches* is absent stands for it). The row quotes "You: Keep the zebra crossing timer paragraph short.", the phrase marked, and **1 more in this thread** for the reply.
- From the first key to the quoted row: 240, 319 and 229 ms over three runs, of which 200 ms is the wait after typing stops.
- "routing" matches **Thread routing** by its title and **Release notes 1.4** by a reply. The title match lists first and has no quote; the word match quotes "Codex: The routing table is in the release notes."
- At the 820x560 minimum, the sidebar opened over the thread holds the quoted row inside the list.

Captures, dark and light: `artifacts/thread-word-search/found-1600-*.png`, `found-1280-*.png` (the phrase found) and `found-820-*.png` (the "routing" search at the minimum).

## What a search costs

Measured with the store's own `threadWords` on copies of the real stores, never the live files.

| Store | Threads | Messages | Their words | One search |
|---|---|---|---|---|
| Laptop, `%APPDATA%\sotto\threads.sqlite` (1.6 GB) | 994 | 75,897 | 30 MiB | 55 to 116 ms |
| forge, `~/.sotto/threads.sqlite` (499 MB) | 203 | 23,583 | 8 MiB | 5 to 12 ms |
| `tests/perf/threadWords.perf.test.ts` on forge | 1,000 | 76,000 | about 30 MiB | 32 to 35 ms median |

Before the change a search read nothing from the store: it filtered the rows the window already held. The read runs on the store worker, so main's thread does not wait for it. The first form of the query grouped as it read and took 160 to 220 ms on the laptop, because SQLite walked the threads' index instead of the table. Reading the matches in one pass first and grouping them after halved it.

A trigram full-text index was measured too: 1 to 10 ms a search on the laptop's messages, but 162 MiB more in the store and 4.7 s to build. Steps, which this search leaves out, are 315,634 records there.

## Not run here

- The iPhone half compiles only on the macOS CI job. Its behaviour on a phone is Zach's hand test.
- A paired host's threads found from the desktop are covered by `tests/unit/main/desktopHostRouter.test.ts` and `tests/integration/socketThreadWords.test.ts`, not by a desktop paired with forge.

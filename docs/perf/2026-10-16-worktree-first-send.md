# A new worktree thread's first send - October 16, 2026

A thread on a new worktree makes that worktree on its first send (ADR-0014), and with Start from origin on it first
fetches the base branch from origin. Early start (ADR-0057) gives such a thread no Claude Code spare, because the
spare would run in a folder that does not exist yet, so the whole setup sat between Send and the prompt going out.
This note measures that setup stage by stage, then the two changes made to it: `git worktree add` writes the files
with a worker per core, and the first keystroke starts the base fetch, which the send uses while it runs and for two
minutes after it finished (ADR-0057, October 16 amendment).

## Setup

A Windows 11 laptop with 24 logical cores and an SSD, Git 2.53.0.windows.2, Windows Defender on. The repository is a
clone of Sotto itself (6,526 tracked files, 433 MB) whose `origin` is `github.com/millZach/Sotto`, so every fetch went
over the network to GitHub. The probe, kept outside the repository because it needs that network and remote, bundles
the real `ThreadWorktrees` and calls it as the first send does: `allocate` with Start from origin on, then `ensure`.
Each round removes its worktree and branch afterwards. Times are wall clock around each call.

## Where the time went, before

Five rounds against `main` at 078a92651, each Git call timed through the `RunGit` seam.

| Stage | Rounds |
| --- | --- |
| `allocate` | 1,445 / 1,194 / 10,880 / 2,915 / 2,319 ms |
| of which `ls-remote` | 621 / 480 / 481 / 507 / 526 ms |
| of which the base fetch | 602 / 551 / 10,195 / 2,208 / 1,563 ms |
| of which local Git reads (six calls) | about 40 ms each |
| `ensure` | 10,782 / 9,405 / 9,606 / 11,937 / 9,250 ms |
| of which `git worktree add` | 10,245 / 9,165 / 9,366 / 11,670 / 8,847 ms |
| First checkpoint, for comparison | 343-678 ms |
| Claude Code's start with no spare (`2026-10-06-early-start.md`) | about 1,180 ms |

So a first send on this repository spent 12-25 s before the prompt went out, and `git worktree add` was most of it:
Git writes a new checkout's files one at a time unless `checkout.workers` says otherwise.

## Workers for `git worktree add`

`git worktree add` alone, the four settings alternating, three rounds.

| `checkout.workers` | Rounds |
| --- | --- |
| 1 (Git's default) | 15,406 / 18,115 / 18,598 ms |
| 4 | 10,322 / 9,552 / 6,293 ms |
| 8 | 4,255 / 9,228 / 3,412 ms |
| 0, a worker per core | 4,555 / 6,259 / 5,916 ms |

A worker per core was the steadiest and scales with the machine, so Sotto passes `-c checkout.workers=0` to its own
`git worktree add`, for a new worktree and a restored one, unless the user's Git config sets `checkout.workers`
already. Git's documentation notes that a spinning disk can do better with one worker; a user on one keeps their
setting. Reading the config costs one Git call, about 40 ms. The probe that made these tables is not in the
repository, since it needs a network and a GitHub origin; it called `allocate` and `ensure` exactly as above.

## Before and after

Six rounds of each, alternating, with nothing else running. "Before" is `main`'s Git runner and no early fetch.
"After" is this branch's runner, with the early fetch typing started already finished, as it is when the user types
for longer than the fetch takes.

| | Median | Range |
| --- | ---: | ---: |
| `allocate`, before | 1,270 ms | 1,202-1,405 ms |
| `allocate`, after | 189 ms | 164-208 ms |
| `ensure`, before | 14,317 ms | 12,295-16,253 ms |
| `ensure`, after | 4,467 ms | 3,393-7,054 ms |
| **Setup in the send, before** | **15,635 ms** | **13,497-17,462 ms** |
| **Setup in the send, after** | **4,636 ms** | **3,596-7,262 ms** |
| The early fetch itself, while the user types | 1,277 ms | 1,140-1,453 ms |

The rounds, in the order they ran, as setup in the send:

| Round | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 13,844 | 15,486 | 17,462 | 15,784 | 13,497 | 16,626 |
| After | 5,422 | 4,700 | 3,596 | 7,262 | 4,372 | 4,572 |

An earlier run of the same comparison, which overlapped short test runs on the same machine, gave medians of
16,679 ms before and 7,586 ms after.

Only Windows was measured. macOS and Linux get the same flag; Git's parallel checkout is the same code there, and
Apple silicon Macs have SSDs, where Git's documentation expects it to help.

## What is left

- `git worktree add` with workers is still 3-7 s on this repository, and it is now most of what is left. Making the
  worktree while the user types would hide it too, but that would break ADR-0014's rule that no worktree and no branch
  exists before the first send, so it is a product decision, not a speed fix.
- Claude Code still starts its CLI inside such a send, about 1.2 s, because its spare needs the folder the worktree
  becomes.
- A send more than two minutes after the early fetch finished fetches again, as before: about 1.1-2.2 s here, with
  one 10.7 s outlier in the first table.
- With the Git fetch interval Off, typing fetches nothing early and the send fetches as before.

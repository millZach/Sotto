# The babysitting reader against GitHub - issue 823

October 8, 2026, Windows 11, gh 2.89.0 signed in to github.com. Issue #823 builds the host's reader behind pull request
babysitting (ADR-0061). It has no surface of its own yet, since the tool and the wake-up are #824 and the look is #825,
so this note records what the reader did against GitHub itself, with the real gh, beside the unit tests that script
gh and the clock.

## How it was run

A script outside the repository bundled `src/main/agents/babysitting.ts` with esbuild and ran it with the real command
runner wrapped to count gh processes, an in-memory store standing in for `workspace.json`, and a `deliver` that
collected the news. Two threads babysat pull requests of this repository: thread A babysat #827 (already merged) and
#828 (open, its checks finished), and thread B babysat #828 too. Two passes were run by hand, as the two-minute
timer would run them. Nothing was sent anywhere; the news stayed in the script.

## What it did

- **First pass:** two `gh api graphql`. The first was one fingerprint for both pull requests, since they are in one
  repository. The second was one checks read of #828, shared by both threads, because it was the first look.
- **#827:** the fingerprint alone said merged. Thread A was told `ended: merged`, and its babysitting ended with
  the event `babysit-ended-merged`.
- **#828:** both threads were told once that its five checks had passed (`checks-passed`, none marked required on
  this repository). The news carried no comment or review text.
- **Second pass:** one `gh api graphql`, the fingerprint alone, and no news. A quiet pull request costs only its share
  of the fingerprint. In an earlier run, made while #828's CI was still running, the second pass also read the checks,
  as decision 13 says it should while a check runs.
- **Starting:** all three starts were accepted. A start reads nothing, and the list showed #828 for both threads,
  with who started each.
- **Logs:** only `babysit-started` and `babysit-ended-merged`.

The rate-limit paths, refused checks, review comments and the endings by limit were not provoked against GitHub. The
tests in `tests/unit/main/babysitting.test.ts` and `tests/unit/main/workspaceBabysitting.test.ts` cover them over a
scripted gh.

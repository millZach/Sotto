# Hourly update checks (November 10, 2026)

The November 10 audit (`2026-11-10-performance-and-data-audit.md`, finding 10, #2399) found Sotto asking GitHub for a
new version of itself every four minutes and asking each connected client's registry every five, on every machine. The
owner chose "every hour, both checks": both run at start and then once an hour, so a new build is offered within the
hour without a press. Check now in Settings → Updates, Check for Updates… in the tray or the Sotto menu, and Check
again for a client still ask at once.

## Checks in a day

Counted on a fake clock through the services' own timers, for one day after start. The before is the same count with
the two intervals set back to four and five minutes. Before, a check that failed was simply asked again at the next
tick, so a day with no answer cost the same as a day with one.

| What | Before | After |
|---|---|---|
| Sotto's own update check, first day, everything answers | 361 (1 at start, then 360) | 25 (1 at start, then 24) |
| Sotto's own update check, first day, nothing answers | 361 | 28 (25 and 3 early retries) |
| Each connected client, a day, everything answers | 288 | 24 |
| A client whose registry never answers, a day | 288 | 27 (24 and 3 early asks) |
| The other clients on that machine, a day | 288 | 24 |
| Each connected client, a day, no registry answers | 288 | 27 |

The client day is counted after the checks on connect. The three extra are the early retries below; they are spent
once in a failure that lasts all day, not once an hour.

## Requests and bytes for Sotto's own check

What one check asks depends on the track and the platform. The pinned updater (`electron-updater` 6.8.9) was read and
then driven with a fake request executor (`tests/unit/main/owlUpdates.test.ts`, which now holds each list exactly):
stable on Windows keeps prereleases off, so it reads the release feed, asks `/releases/latest` for the newest stable tag
and then reads that release's `latest.yml`. Owl reads the feed, picks its tag from it and reads `owl.yml`, or
`owl-mac.yml` on a Mac; if that read fails for any reason it reads `latest.yml` as well, or `latest-mac.yml` on a Mac,
a third request. Stable on a Mac and every Linux
build have no in-app updater (ADR-0062, ADR-0093), so they make none. GitHub answers `/releases/latest` and each
manifest with a redirect, which the updater follows: one more round trip each, with an empty body.

Sizes are the bodies of the public files on November 10, 2026, measured the way the audit measured the feed. The feed
is not compressed, even when asked to be.

```sh
curl -sL -o /dev/null -w '%{size_download}\n' https://github.com/millZach/Sotto-releases/releases.atom          # 16352
curl -sL -H 'Accept: application/json' -o /dev/null -w '%{size_download}\n' https://github.com/millZach/Sotto-releases/releases/latest   # 453
curl -sL -o /dev/null -w '%{size_download}\n' https://github.com/millZach/Sotto-releases/releases/download/v0.1.42/latest.yml           # 342
curl -sL -o /dev/null -w '%{size_download}\n' https://github.com/millZach/Sotto-releases/releases/download/v0.1.43-owl.20261110.1/owl.yml       # 395
curl -sL -o /dev/null -w '%{size_download}\n' https://github.com/millZach/Sotto-releases/releases/download/v0.1.43-owl.20261110.1/owl-mac.yml   # 575
```

| Track | Requests a check | Bytes a check | Requests a day, before → after | Bytes a day, before → after |
|---|---|---|---|---|
| Stable, Windows | 3 (and 2 redirects) | 17,147 | 1,080 → 72 | about 6.2 MB → about 412 KB |
| Owl, Windows | 2 (and 1 redirect) | 16,747 | 720 → 48 | about 6.0 MB → about 402 KB |
| Owl, Mac | 2 (and 1 redirect) | 16,927 | 720 → 48 | about 6.1 MB → about 406 KB |
| Stable on a Mac, Linux | none | none | none | none |

A day here is the 24 checks after the one at start (360 before). The first build of this change, and the audit, gave
two requests for every check; that holds for Owl and not for stable.

## Bytes for the client checks

A client's registry answers 1.0 to 1.5 KB compressed for each package, the audit's figure.

| What | Before | After |
|---|---|---|
| Each connected client, a day | 288 to 432 KB | 24 to 36 KB |
| Five connected clients, on each machine, a day | 1.4 to 2.2 MB | 120 to 180 KB |

## What stays prompt

- **A failed check.** Before, a check that got no answer was asked again by the next one, four or five minutes later.
  Now a failed Sotto check is tried again 4, 8 and 16 minutes later, and then only at the hourly check until one
  answers. A client whose registry or feed gave no version is asked again 5, 10 and 20 minutes later, alone or with the
  other clients that went unanswered, never with the ones that answered, and then only at the hourly check. The first
  answer ends the early asks and gives the next failure all three again. The waits double as the repository's other
  retries do (`gitStatus.ts`, the product events sender). So a machine that is offline all day makes three checks more
  than a healthy one, and one registry that never answers costs its own client three asks, not every client's.
- **A host archive the releases page did not show.** Update all asks again at each change of Sotto's update phase,
  which a check makes, and that now comes once an hour. A release's host archives are uploaded just after the desktop's
  files, so a 404 right after a new version is found is ordinary. A 404 and a page that gave no answer are now both
  asked again 4, 8 and 16 minutes later on their own, for that version only, and then at the next check (ADR-0077,
  November 10 amendment).
- **A check on connect, after a client update, and when Sotto finds a new version of itself.** Unchanged. The registry's
  answer is still kept for four minutes, for the checks that come together; the hourly check and the early asks ask
  afresh.
- **After Sotto installs an update.** Sotto restarts, and its first check runs 15 seconds later, as before.

## The guards

In the default suite, so the counts cannot creep back:

```sh
PATH=$HOME/.local/share/mise/installs/node/24.22.1/bin:$PATH npx vitest run tests/unit/main/updateService.test.ts tests/unit/main/clientUpdateChecks.test.ts tests/unit/main/hostUpdate.test.ts tests/unit/main/owlUpdates.test.ts --maxWorkers=2
```

- `updateService.test.ts`, "the hourly update check": 25 checks in a day that answers and 28 in one that does not;
  retries 4, 8 and 16 minutes after a failure and none after; an answer starts them over; a press checks at once and
  does not move the hourly check.
- `clientUpdateChecks.test.ts`, "how often the registry is asked": 24 asks a day for each client when every registry
  answers; 27 for a client whose registry never answers and 24 for the others; 27 for each when none answers; the early
  asks at 5, 10 and 20 minutes ask only the unanswered client; an answer starts them over.
- `hostUpdate.test.ts`: an archive uploaded just after its 404, and a page that gave no answer, are offered four minutes
  later; an archive that stays missing is asked 3 times early and then only at the next phase change.
- `owlUpdates.test.ts`: the exact requests of a stable check (three) and of an Owl check on Windows and on a Mac (two).

Taking out the bound, the partial ask or the 404 retry turns these red.

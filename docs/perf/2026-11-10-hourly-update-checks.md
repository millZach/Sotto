# Hourly update checks (November 10, 2026)

The November 10 audit (`2026-11-10-performance-and-data-audit.md`, finding 10, #2399) found Sotto asking GitHub for a
new version of itself every four minutes and asking each connected client's registry every five, on every machine. The
owner chose "every hour, both checks": both run at start and then once an hour, so a new build is offered within the
hour without a press. Check now in Settings → Updates, Check for Updates… in the tray or the Sotto menu, and Check
again for a client still ask at once.

## Checks in a day

Counted on a fake clock through the services' own timers, for one day after start, with every request answered. The
before is the same count with the two intervals set back to four and five minutes.

| What | Before | After |
|---|---|---|
| Sotto's own update check, in the first day | 361 (1 at start, then 360) | 25 (1 at start, then 24) |
| Requests to GitHub for it, after the start | 720 | 48 |
| Client registry checks, for each connected client | 288 | 24 |

## Bytes in a day

Bytes per check are the audit's: the release feed is 16,352 bytes and not compressed, then the release's manifest is 395
bytes, 16,747 bytes a check. A client's registry answers 1.0 to 1.5 KB compressed for each package.

| What | Before | After |
|---|---|---|
| Sotto's own check, after the start | About 6.0 MB | About 402 KB |
| Each connected client | 288 to 432 KB | 24 to 36 KB |
| Five connected clients, on each machine | 1.4 to 2.2 MB | 120 to 180 KB |

## What stays prompt

- **A failed check.** Before, a check that got no answer was asked again by the next one, four or five minutes later.
  Now a failed Sotto check is tried again four minutes later, and a client check in which a registry or feed gave no
  version for some client starts a check every five minutes beside the hourly one. Both stop at the first check that
  answers. A machine that never reaches one of those hosts keeps asking at the old pace.
- **A host archive the releases page did not answer for.** Update all asks again at each change of Sotto's update phase,
  which a check makes. Now that comes once an hour, so a page that gave no answer is asked again four minutes later on
  its own (ADR-0077, November 10 amendment). A 404 waits for the next check, within the hour.
- **A check on connect, after a client update, and when Sotto finds a new version of itself.** Unchanged. The registry's
  answer is still kept for four minutes, for the checks that come together; the hourly check and its retries ask
  afresh.
- **After Sotto installs an update.** Sotto restarts, and its first check runs 15 seconds later, as before.

## The guards

In the default suite, so the counts cannot creep back:

```sh
PATH=$HOME/.local/share/mise/installs/node/24.22.1/bin:$PATH npx vitest run tests/unit/main/updateService.test.ts tests/unit/main/clientUpdateChecks.test.ts tests/unit/main/hostUpdate.test.ts --maxWorkers=2
```

- `updateService.test.ts`, "the hourly update check": 1 + 24 checks in a day; a retry every four minutes while checks
  fail, back to the hour once one answers; a press checks at once and does not move the hourly check.
- `clientUpdateChecks.test.ts`, "how often the registry is asked": 24 requests a day for each client, counted in
  five-minute steps; a retry every five minutes while the registry is down, and none once it answers.
- `hostUpdate.test.ts`: a releases page that gave no answer is asked again after four minutes, and a 404 is not.

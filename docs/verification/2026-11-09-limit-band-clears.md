# The limit band reads dated resets and clears

November 9, 2026, on forge (Linux, Omarchy), in the built app on the Owl track (ADR-0144, November 9 amendment), under `xvfb-run -s "-screen 0 1920x1200x24"`. `npx playwright test tests/e2e/restart-stopped.spec.ts` runs the real Claude adapter over the fake CLI in `tests/fixtures/`; both journeys in it passed.

## A weekly stop that names its day only in the error reply

- A prompt was sent to **Weekly essay**, and the fake CLI answered with Claude Code's error reply, marked `rate_limit`, reading "You've hit your weekly limit · resets Nov 11, 5am (America/Los_Angeles)" (the day two days out), then a failed result with no text.
- The Threads sidebar shows "Claude Code's limit resets Wednesday at 5:00 am. Sotto restarts 1 thread then." with **Don't restart them**, and the row reads "Restarts Wednesday at 5:…". Before this change the same stop named no reset.

## A stop with no reset, and Dismiss

- A prompt was sent to **Tide tables**, and the fake CLI ended it with a usage-limit result that names no time. A second band reads "Claude Code didn't say when its limit resets, so Sotto can't restart its thread on its own. Send again once it resets." with **Dismiss** last in it (`artifacts/limit-band-clears/no-reset-dismiss-dark-1280.png`, `no-reset-dismiss-light-1280.png`). Nothing in the sidebar scrolls sideways at 1600x1000, 1280x800 or 820x560, in dark or light; at 820x560 the sidebar is its rail, which carries no bands, as for a scheduled restart.
- Dismiss, focused and pressed with Enter, takes that band and the strip over the composer away; the band for **Weekly essay** stays, and focus waits in Search threads (`no-reset-dismissed-dark-1280.png`).

## Not checked here

- The band leaving when a turn of the same provider finishes, and a record from before this change leaving on its first read: `tests/unit/main/limitRestart.test.ts` covers both.
- Windows and macOS: CI's desktop journeys run this spec there.
- Zach's own laptop, where the band he saw was saved by the earlier build: see the hand test in the pull request.

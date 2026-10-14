# Certified detail publishing — October 13, 2026

**VERIFIED on the built Windows Electron app, with the real Codex adapter over the existing fake
native CLI.** This is not a claim about the installed app, a packaged release, live provider
accounts, macOS or a native phone. The shared socket/detail tests remain part of the required
suite. No renderer look changed and no design baselines were regenerated.

## Surface and journey

`npm run build` built the actual main, preload and renderer at source `0cb63ab92`. The native
journey uses a fresh owned temporary profile and a project inside it. It configures the native
fixture, opens Threads, fills the real composer and presses Enter. The actual Codex adapter,
workspace, coordinator, desktop router, bridge and renderer carry the resulting turn.

The fake native CLI sends two running command records, then streams six text and command-output
chunks. One command stays unchanged while the other grows. Both feature states verify the
startup answer, the rendered words and expanded output. A bounded text-free observation on the
existing development-only E2E snapshot channel reads the coordinator's actual private tracker:
Owl has one owned certified history and reuses unchanged record objects through the chunks;
stable has no optimized tracker. It is enabled only for the native fixture with an explicit
observation flag and adds no production accessor or channel.

The first verification draft used a mutable `E2EAgentHost`, which could not prove the identity
path. Independent spec review caught that gap before it was called verified; the native route
above replaced it.

## Results and reusable checks

```powershell
npm run build
$env:SOTTO_E2E_EVIDENCE='publish'
node tools/verify-certified-detail.mjs
npx playwright test tests/e2e/activity-persistence.spec.ts
```

- Native detail verifier: **2 passed**, 14.4 seconds, native exit code **0**. Both gates stream
  whole words/output, retain the expected tracker identity, and produce no renderer page errors.
- Existing activity persistence journey: **1 passed**, 5.7 seconds, exit code **0**. Retained
  legacy activity stays readable after migration and a full app restart.
- Focused unit/detail and the two affected integration files: **119 passed**, 37.43 seconds.
  These include certification transitions, same-length replacement, ordering, mutation ownership,
  close/reopen with a newer cached client revision, and privacy cache cleanup.
- Dark and light at 1600x1000, 1280x800 and 820x560, reduced motion on. Every size checks the final
  reply and main overflow. The saved captures were opened and inspected at wide, desktop and
  minimum sizes. The reply wraps at the minimum; long command output uses its normal internal
  scroll area, and the composer controls remain reachable.

Cited captures:

- [Owl, dark, 1280x800](../../artifacts/certified-detail/owl-dark-1280.png): retained command,
  expanded streamed output, final reply and composer.
- [Stable, light, 820x560](../../artifacts/certified-detail/stable-light-820.png): final reply
  and output after scrolling, with the composer controls fitting the minimum window.

Windows display scaling makes the PNG pixel sizes 1.5 times the CSS window sizes. Other captures
are disposable and are not committed. Raw commands and exit-code JSON stay under
`.zstack/perf-991-remaining/`: `build.log`, `electron-certified-detail-final.log`,
`electron-exit.json`, `electron-activity-persistence.log`, `final-probes-exit.json` and
`detail-review-and-sleep-rerun.log`.

## Interrupted first gate attempt

The first full suite is **not a passing gate**. Windows System event 42 records idle sleep at
17:39:27; Power-Troubleshooter event 1 records sleep at `2026-10-14T00:39:27.089683Z` and wake at
`2026-10-14T01:14:49.882419Z`, about 35 minutes later. Two provider tests and a concurrent
read-only tool call span that same pause (about 2,119–2,123 seconds). The verified owned suite
process tree was stopped after preserving `tests-initial-sleep-disrupted.log`. Both affected
files passed in their one isolated rerun above; no unrelated provider behavior was changed.

A hidden, process-scoped system-only wake request protects the remaining checks, without changing
permanent power settings or keeping the display awake. The owning process is recorded in the run
status and will be stopped at the end or on pause. Final exact CI gates run on the settled source
and are reported in the PR; this interruption is not counted as one.

## Final settled-source gates

At source `d716973a8`, exact `npm run typecheck`, `npm run lint` and
`npm run notices:verify` passed (189 notice components). The exact
`npm test -- --maxWorkers=2` completed with native exit code 0: 818 files and
10,385 tests passed; 68 files and 321 tests skipped, in 1,727.04 seconds.
The run started at 19:06:20 and ended at 19:35:08 local time on October 13.
Its owner, source, command, worktree and exit code are preserved in
`.zstack/perf-991-remaining/tests-settled-owner.json`, `tests-settled.log` and
`tests-settled-exit.json`; static checks have separate `*-settled` logs and exit JSON.
No source or fixture changed while those gates ran. The earlier interrupted suite
remains a separate nonpassing attempt.

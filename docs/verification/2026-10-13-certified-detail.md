# Certified detail publishing — October 13, 2026

The two retained captures were refreshed during the PR #973 integration check on
`0ff7b7f873eaee499a6b7f0d99ab47e23ad8b7c9`. The original measurements and gate results below
retain their original revision attribution; the combined verification is recorded at the end.

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

## Combined Muse and Watcher verification

PR #973 merged main `b34e1d48b` into its formerly green `e228f919e` as
`0ff7b7f873eaee499a6b7f0d99ab47e23ad8b7c9`. The runtime keeps Muse and streaming cost as
independent Owl answers. Whole details and deltas retain Watcher's presented messages alongside
owned immutable activity records.

The mechanical integration exposed four failing regressions before the semantic fix: a changed
Watcher proof did not publish through the certified path; a nonempty-message certification
transition advanced its revision unnecessarily; and closing a publicly read detail without a
subscriber retained caches with Watcher both off and on. A shared message signature and gated
cleanup fixed those cases. The three focused files passed 32 tests, followed by the broader
11-file integration selection passing 120 tests, with native exits 0 and no skipped cases.
Independent Standards and Spec reviewers found no unresolved findings. Assets verification,
typecheck, lint and notices also passed; notices verified 189 components.

A fresh build on the exact clean merge commit passed, then the whole Muse, Watcher and certified
detail Playwright specs passed **16 cases**, native exit 0. The two certified cases verify the
actual native Codex adapter and coordinator tracker with the optimization off and on. The Muse
case exercises Settings, requests, steering, recovery and Owl-to-stable-to-Owl preservation.
Thirteen Watcher cases include its actual native input, original visible message, keyboard path,
beside pane and light/dark layouts. These journeys use synthetic providers and owned temporary
profiles. All 165 observed process identities drained and all 18 observed owned profiles were
removed; source hashes and the inherited environment were unchanged.

Fresh captures were written at 03:56:35–03:58:13 UTC on October 14 (October 13 locally). The dark
1280 capture and light 820 capture above now come from this run. Their owl/stable filenames
indicate the optimization gate on/off in the development fixture. They were opened and inspected,
along with the minimum Muse Settings and original-message Watcher views. The transcript, expanded
command output and minimum-size composer remain readable. No design baseline was regenerated.

This records local Windows app verification on the stated source. Full hosted CI and packaging
must run on the pushed revision. Native iOS and host-protocol source are unchanged from the
previous fully green e228 revision; its hosted iOS proof keeps that attribution. Live native Muse
sign-in, approval, installer update and handoff, Android builds and local macOS/Omarchy desktop
journeys remain unverified.
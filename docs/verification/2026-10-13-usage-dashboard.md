# Usage in Sotto Owl

October 13, 2026. Local verification of [issue #976](https://github.com/millZach/Sotto/issues/976) on `feat/usage-dashboard`. The reviewed implementation and fixture fixes are at `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`, following the integrated implementation at `c745c6e4a90193aa238ce9d97a9f97557066e327`. All four required gates and actual Windows package checks passed on that feature revision; both final review verdicts had zero unresolved findings. No installer or host was installed or published.

Zach chose both native subscription limits and Sotto activity, Overview first, numeric history independent of conversation history, a separate Clear action and all connected computers. He selected **C: Focus** from the Opus 5.5 pass launched at xhigh. The [plan](../plans/2026-10-12-usage-dashboard.md) records the accepted prototype and archive; [ADR-0076](../adr/0076-usage-keeps-numeric-history-on-its-own-host.md) records the numeric and authority boundaries.

## Production Windows journey

`npm run build` passed. The final run of `tests/e2e/usage-dashboard.spec.ts` passed its two journeys in 16.2 seconds on production Electron main, the native Claude adapter, the real preload/IPC bridge and SQLite store. The external Claude client was scripted in an isolated profile. Network requests were disabled; no product test bridge, live inference or real account data was used. The neighboring `host-update.spec.ts` and `native-usage-persistence.spec.ts` journeys also passed, two tests in 34.8 seconds.

The [numeric evidence](../../artifacts/usage-dashboard/verified.json) records version `0.1.38-owl.20261012.1`, zero page errors and these outcomes:

- One exact accepted send counts once. Its selected model is `claude-sonnet-4-6`; native token evidence names `claude-opus-5-5`. Models therefore shows the selected prompt separately from the reported token model.
- Native input of 1,000 uncached, 2,000 cache-read and 500 cache-write tokens becomes 3,500 input. With 100 output, total is 3,600 and From cache rounds to 57%. The five-minute cache-write value stays known zero; the one-hour value is 500.
- A stale Clear is refused. A fresh Clear removes the numeric figures; active old request updates and replay stay suppressed. A new turn counts afterward. The same 3,600 tokens and one prompt survive history being off, graceful restart and replay without duplication.
- A stable launch using the Owl-created database exposes neither Usage navigation nor its preload bridge and leaves the database bytes unchanged.

The journey exercised Overview, Subscriptions and Models; provider, computer and date filters; empty and invalid date ranges; keyboard view and chart navigation; disclosures and model details; and Escape with focus return from Clear. It checked a complete 366-day chart at the minimum size after the dense-chart spacing fix, and enabled reduced motion. Passive Claude fixtures supplied a known-zero five-hour window and a 20%-used seven-day window; unsupported providers remained unavailable.

## Retained captures

All five refreshed final PNGs were opened and inspected by the lead and a separate evidence reviewer. Wide Overview, Tokens and Models retain readable figures and focus states. At the minimum width, Overview uses the selected design's horizontally scrollable measure strip; partly offscreen measures require scrolling or keyboard focus. Focus now reveals the entire headline control instantly. The final journey checked all six focused controls inside the strip, including each control's numeric scroll width. The page and room have no horizontal overflow. The minimum light Subscriptions capture shows the full five-hour and weekly figures after vertical scrolling.

| Capture | Actual content size | Visible-text contrast minimum |
| --- | --- | --- |
| [Overview, dark](../../artifacts/usage-dashboard/overview-dark-1600.png) | 1600 × 1000 | 6.97:1 |
| [Tokens, dark](../../artifacts/usage-dashboard/tokens-dark-1280.png) | 1280 × 800 | 6.97:1 |
| [Subscriptions, light](../../artifacts/usage-dashboard/subscriptions-light-820.png) | 820 × 562 | 5.11:1 |
| [Models, light](../../artifacts/usage-dashboard/models-light-1280.png) | 1280 × 800 | 5.11:1 |
| [Overview, dark at minimum](../../artifacts/usage-dashboard/overview-dark-820.png) | 820 × 562 | 6.97:1 |

The minimum target was 820 × 560. This Windows display returned 562 content pixels high. The JSON records both requested and actual dimensions, `contentSizeTolerance: 2` and `contrastVisibleOnly: true`. The opened About disclosure's measured text ratios were 6.72:1. Closed disclosure descendants defer their styles, so hidden text was excluded from the visible-text measurement. Captures and JSON contain synthetic names and numeric evidence, with no prompt/reply text, account details, credentials or provider protocol bodies. The lead also checked the [local evidence gallery](http://localhost:8078/artifacts/usage-dashboard/index.html), confirmed HTTP 200 and inspected its Edge screenshot.

## Gates and review

Builder reports under `.zstack/usage-dashboard/` record meaningful SQLite, parser, service, adapter, transport, renderer and host tests. The final native focused pass was 80 tests; the lead's combined native/store/service pass was 57. Scripted adapter contracts passed 117 with six existing skips. Store/schema tests passed 37 and quota parser tests 24. New transport tests passed 12, with 112 existing regressions. The UI combined pass was 109 tests and its final focused rerun was 12. Owl host unit checks passed 78; launch/update integration checks passed 52 with two existing Windows skips. These scoped results are not a final full-suite result.

The final independent Standards and Spec verdicts both have zero unresolved findings. All four Spec P2s and the overlapping Standards chart finding are resolved. Durable numeric conflict floors preserve Grok uncertainty across identical lower replay, actual SQLite close/reopen and fresh adapters. Complete native vectors meeting or exceeding the retained evidence repair confidence; Clear deletes the floors. The exact-acceptance buffer, dense annual chart and minimum-width headline-focus fixes are also checked.

The first `npm test -- --maxWorkers=2` run finished with exit code 1 in 1,676.80 seconds: 795 files passed, 60 skipped and three failed; 10,084 tests passed, 299 skipped and eight failed. All eight failures were omitted expected-contract fixtures: six update-status objects lacked `usage: false`, the default packaged-feature fixture listed only Watcher, and the exhaustive host-operation fixture omitted `usage-read`, `usage-refresh` and `usage-clear`. The three existing test files now keep strict assertions and include two additional meaningful coverage cases. Their 54-test focused rerun and scoped lint passed; the fixes are included in `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`.

The final `npm run typecheck`, `npm run lint` and `npm run notices:verify` ran serially and passed with exit code 0; notices verified 189 components. The final `npm test -- --maxWorkers=2` started at 02:05:10 local time and passed with exit code 0 after 1,299.69 seconds: 798 files passed and 60 skipped (858 total); 10,094 tests passed and 299 skipped (10,393 total). Its UTF-8 log is `.zstack/usage-dashboard/full-suite.final.log`. All four required gates passed on the final implementation source.

## Actual Windows packages

The [package evidence](../../artifacts/usage-dashboard/package-verification.json) combines actual receipts and rechecked digests from the owned `.worktrees/usage-dashboard-verification` checkout at exact source `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`. The checkout has its own `npm ci` dependencies and no node_modules junction. The record includes the full source and build SHA-256, Windows x64 identity, and explicit installation, publication, remote, Linux and macOS exclusions.

`npm run package:host:owl -- --version 0.1.38-owl.20261013.1 --source 1b013f26ea4a7fdaa4f9b2932203464f447ad8e2` passed. Its real extracted archive started a host with providers disconnected, returned healthy own-version Usage capability and shut down gracefully. `Sotto-host-0.1.38-owl.20261013.1-win32-x64.tar.gz` was checksum-rechecked as `6187149ab6f2904c8388442f760f2e050854c53be0b179de3af45d312a89c2cf`.

`npm run package:owl -- --date 20261013 --number 1` passed its resource and packaged-feature checks. `tools/verify-usage-package.mjs` then passed on the actual packaged Owl: all six headline controls and all three views, one ready empty local host, known-zero prompts, unavailable tokens, no product test bridge and zero page errors. The [packaged Owl capture](../../artifacts/usage-dashboard/usage-owl-package.png) was opened and inspected by the lead and evidence reviewer. Its installer SHA-256 is retained in the JSON.

`npm run package:dir` followed by the stable feature-override and Usage probes passed on packaged stable `0.1.37`. Usage's navigation and bridge were absent, dormant numeric SQLite bytes were preserved and there were zero page errors. The stable directory is verification output, not an installation.

The package probes used isolated PATH, HOME and profile directories. Owl's local runtime was enabled with all four providers explicitly disconnected, no enabled providers, reasoning set to none and client updates off. Stable's local runtime stayed off for dormant preservation. No provider model inference, account request, installation or publication was performed by these checks.

A Windows fake-systemd run does not establish Linux behavior. The read-only forge SSH attempt timed out; a single bounded noninteractive retry also returned no platform metadata before its 12-second timeout. Real Linux and macOS surfaces and a remote host installation remain unverified. Codex and Grok metadata reads were researched and safely probed separately; this desktop journey proves the scripted Claude path, not current live account allowances for every provider.

The final evidence additions also passed `tests/unit/release` and `tests/unit/scripts`: 257 tests passed and 10 skipped across 33 passing files and one skipped file. The owned verification checkout was removed after retaining the cited evidence. This note and those artifacts close local verification; no release or remote installation was performed.

## Integration for merge

Zach authorized merge after the local verification. Latest main `2ff23cc1db51c9a33c13a6f7d9f6ab08b1717b99` overlapped the implementation, so it was integrated before opening the PR. The resolution keeps both Usage and Omarchy bridges and both sets of release and evidence records. Usage's ADR becomes 0076 because main's Claude steering decision uses 0075. A read-only seam check found no semantic conflict in Claude exact acceptance, token contexts, wake-up guards or Omarchy startup. Typecheck, lint and notices passed on the combined tree; the full suite, affected Electron journeys and independent review are being repeated for this integration. The earlier package receipts retain their exact source identity and do not claim to be packages of the later merge commit.

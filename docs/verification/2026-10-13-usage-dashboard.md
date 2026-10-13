# Usage in Sotto Owl

October 13, 2026. Draft verification for [issue #976](https://github.com/millZach/Sotto/issues/976) on `feat/usage-dashboard`. The integrated implementation is committed at `c745c6e4a90193aa238ce9d97a9f97557066e327`; subsequent review fixes are local. Both final review verdicts have zero unresolved findings. The final CI rerun and actual native package verification are pending. Nothing has been installed, published, pushed as an implementation PR or merged.

Zach chose both native subscription limits and Sotto activity, Overview first, numeric history independent of conversation history, a separate Clear action and all connected computers. He selected **C: Focus** from the Opus 5.5 pass launched at xhigh. The [plan](../plans/2026-10-12-usage-dashboard.md) records the accepted prototype and archive; [ADR-0075](../adr/0075-usage-keeps-numeric-history-on-its-own-host.md) records the numeric and authority boundaries.

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

## Scoped checks and remaining evidence

Builder reports under `.zstack/usage-dashboard/` record meaningful SQLite, parser, service, adapter, transport, renderer and host tests. The final native focused pass was 80 tests; the lead's combined native/store/service pass was 57. Scripted adapter contracts passed 117 with six existing skips. Store/schema tests passed 37 and quota parser tests 24. New transport tests passed 12, with 112 existing regressions. The UI combined pass was 109 tests and its final focused rerun was 12. Owl host unit checks passed 78; launch/update integration checks passed 52 with two existing Windows skips. These scoped results are not a final full-suite result.

The final independent Standards and Spec verdicts both have zero unresolved findings. All four Spec P2s and the overlapping Standards chart finding are resolved. Durable numeric conflict floors preserve Grok uncertainty across identical lower replay, actual SQLite close/reopen and fresh adapters. Complete native vectors meeting or exceeding the retained evidence repair confidence; Clear deletes the floors. The exact-acceptance buffer, dense annual chart and minimum-width headline-focus fixes are also checked.

The first `npm test -- --maxWorkers=2` run completed in 1,676.80 seconds: 795 files passed, 60 skipped and three failed; 10,084 tests passed, 299 skipped and eight failed. All eight failures were omitted expected-contract fixtures: six update-status objects lacked `usage: false`, the default packaged-feature fixture listed only Watcher, and the exhaustive host-operation fixture omitted `usage-read`, `usage-refresh` and `usage-clear`. The three existing test files now keep strict assertions and include two additional meaningful coverage cases. Their 54-test focused rerun and scoped lint passed. The final full-suite rerun remains pending. Typecheck, full lint and notices verification of 189 components passed before those fixture and package-probe corrections; their final rerun is also pending.

Own-version Owl host archive preparation, negotiated Usage capability and older-host fallback are implemented and covered by fixtures. The corrected `tools/verify-usage-package.mjs` probe enables the local runtime for Owl while explicitly disconnecting all four providers, clearing enabled providers, setting reasoning to none and disabling client updates in isolated PATH, HOME and profile directories. Its stable path keeps the local runtime off and checks absent Usage exposure and dormant SQLite preservation. A verification worktree with its own `npm ci` dependencies is prepared for the final committed source; no node_modules junction is used. A real native Windows archive, its listener capability and the packaged desktop surface have not yet been verified.

A Windows fake-systemd run does not establish Linux behavior. The read-only forge SSH attempt timed out; real Linux and macOS surfaces and a remote host installation remain unverified. Codex and Grok metadata reads were researched and safely probed separately; this desktop journey proves the scripted Claude path, not current live account allowances for every provider.

Before completion, record the final `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2` and `npm run notices:verify` results, actual package-probe results, native archive provenance and the final local commit here. No release or remote installation is authorized by this verification work.

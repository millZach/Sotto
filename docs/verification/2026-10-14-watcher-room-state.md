# Watcher room state — October 14–15, 2026

The built Windows app is VERIFIED on clean source `a9033b152d582f1af5db61cde6754c6eaa4e5f0c`: all four repository gates passed, then the build and all 22 Watcher/release-track journeys passed. This is local built-app proof with fake providers, not an installed release, live-provider, Mac/Linux desktop or native-phone result.

## Gates and built app

| Command | Result on a9033b152 |
| --- | --- |
| `npm run typecheck` | Native 0, 54.993 seconds |
| `npm run lint` | Native 0, 23.823 seconds |
| `npm test -- --maxWorkers=2` | Native 0; 864 files passed / 78 skipped; 11,222 tests passed / 350 skipped; 1,486.90 seconds |
| `npm run notices:verify` | Native 0; 189 components verified |
| `npm run build && npx playwright test tests/e2e/watcher.spec.ts tests/e2e/watcher-gate.spec.ts` | Native 0; 22 passed in 1.6 minutes after the build |

The full suite ran from 2026-10-15T06:59:03.448Z to 07:23:52.135Z. Its reporter emitted aggregate success, not a separate paired-host result. Focused paired-host and session-log controls also passed all 55 tests. The build/app command ran from 07:24:33.098Z to 07:26:37.619Z. Exact start, exit, guard, keeper and cleanup records are retained in [integrated-verification.json](../../artifacts/watcher-room-state/integrated-verification.json).

Every command acquired its own expanded quiet guard with at least 6 GiB free. The full-suite guard recorded 12,319,884 KiB free; six later samples detected only the owned suite/workers at those observations. The app guard recorded 12,277,544 KiB free; its later sample detected only the owned Playwright/Electron chain. These are bounded observations, not continuous isolation. Each system-only keeper left the display request unchanged and was stopped only after PID, creation time and command matched. Owned command/test/app processes were absent afterward, and clean a903 remained unchanged.

## User journeys and captures

The real main/preload/React journey uses the fake Codex app server. It starts Watcher from its composer and receives its reply. Ordinary Settings updates change Threads in flight from one to two; the test observes the existing select's populated room value, which takes priority over the Settings fallback, before reload and without forcing roomGet. That assertion proves the subscription update. The after-reload image shows the retained user prompt and assistant reply; its closed menu does not show the limit. The separate layout reading `limit.saved = 3` belongs to the mocked limit-control journey, not this main assertion.

A second real-main journey exercises permissions, Watch, Stop watching and own-change reporting. Other journeys cover first entry/model choice, Overview focus trapping and Escape, beside-pane request navigation/draft retention, keyboard order, long titles, disconnection, empty state, dark/light sizes, reduced motion from both the system and Sotto's setting, and stable/Owl saved-record gating. Most layout journeys use a fixed room projection; they establish renderer compatibility rather than actual main delivery. Deterministic publisher tests separately establish complete ownership, timing and direct-result/error ordering.

I opened sixteen current views: the six Sotto room sizes, reduced-motion Overview, minimum beside pane and Overview, all three real-main views, minimum dark/light permissions, and minimum stable/Owl views. Text and controls fit, the floating switch clears the composer, and no visible clipping or overlap appeared. Automated bounds, keyboard and motion assertions passed. The recorded room readings contain 804 contrast ratios, minimum 5.58; permission/watch readings contain 837, minimum 5.71. Image inspection alone does not establish motion. Sizes below are CSS content sizes; Windows scaling makes some saved PNGs larger.

Twelve inspected images are retained in [the evidence folder](../../artifacts/watcher-room-state), each from App04:

- `integrated-room-sotto-{dark,light}-{1600x1000,1280x800,820x560}.png`: six room layouts with main's Conversation/Watched tabs.
- `integrated-room-sotto-dark-1280x800-reduced-motion-setting.png`: Overview open under Sotto's reduced-motion setting.
- `integrated-beside-sotto-dark-820x560.png` and `integrated-list-sotto-dark-820x560.png`: minimum request pane and Overview.
- `integrated-room-main-sotto-dark-1280x800.png`: retained real-main exchange after reload; limit two is asserted separately in the test.
- `integrated-room-main-watched-dark-1280x800.png`: real-main standing watch and Stop watching action.
- `integrated-room-main-own-change-dark-1280x800.png`: real-main own-change line after stopping the watch.

`integrated-readings.json` and `integrated-permission-readings.json` retain the actual readings. [Capture provenance](../../artifacts/watcher-room-state/integrated-capture-provenance.json) maps every retained file to its original App04 path and SHA-256. No design baseline was regenerated; README/guide actions remain unchanged.

## Earlier failed gate and ordering evidence

The earlier bce6cb full suite exited 1 with one failure at `watcherPairedHosts.test.ts:352`: expected takeover reason `native-user-send`, received `undefined`. Later queued-receipt/native-write assertions were not reached. [The failure excerpt](../../artifacts/watcher-room-state/step5-integrated-tests-03-failure.txt) is retained. One unchanged isolated case passed; that did not explain the failure.

A separately labeled temporary passive probe also passed. Its [15 untruncated samples](../../artifacts/watcher-room-state/step5-paired-boundary-01-observations.json) showed the helper returning before the native ID entered the adapter's message log, then owner fencing and remote propagation. The [exact overlay](../../artifacts/watcher-room-state/step5-paired-boundary-01-overlay.diff) and [hashes](../../artifacts/watcher-room-state/step5-paired-boundary-01-manifest.json) preserve its scope. The subscription adds clone/scheduling overhead; later request/rollout reads are non-atomic. This proves that helper return is not ingestion/fence acknowledgment in that successful trace. It does not prove the exact full03 trigger or a flake.

The test now refreshes the target and observes takeover before completing the turn, retaining its deadlines and all queue/native-write assertions. A separate held-provider-preparation case scripts unseen native input at the paired queued writer and checks the failed queue/no second turn. No production authority, transport or deadline behavior changed. Fresh full04 aggregate success is the current full-suite result.

## Measurement and integration provenance

The [performance note](../perf/2026-10-14-watcher-room-state.md) retains the exact remote before/after and complete local AFTER05, every row, mixed CPU, adverse AFTER03 and interrupted AFTER04. These historical measurements keep their original source pins; no current-head performance claim or new timing matrix follows from later integration/test-only changes.

Main's permission, standing-watch, own-change and Usage-history contracts are preserved. Independent Standards and Spec reviews cleared the integrated runtime and a903 test-only follow-up, with all 67 manifest hashes verified. The post-diagnosis phase check at 2026-10-14T23:57:04.6133118-07:00 found unchanged main34d688, no incoming overlap/conflict and successful Windows/Desktop/Package/Linux results. This is phase freshness, not delivery-time freshness.

Historical App01 passed 17 journeys on source `1681abdb50a75056bdf724addae5c6549c488044`. Its images retain that provenance in [storage commit de3c263](https://github.com/millZach/Sotto/tree/de3c2634853e8364336dc4d850f8e835fc131a0d/artifacts/watcher-room-state); they are not relabeled as App04 proof. Existing App01 start/exit/cleanup records remain historical. ADR0073 and CONTEXT record the publication rule. No installed release or live-provider proof is claimed.
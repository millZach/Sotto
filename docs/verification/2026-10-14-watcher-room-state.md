# Watcher room state — October 14, 2026

The historical built Windows app at 1681abdb is VERIFIED for the seventeen Watcher and release-track journeys below. The later integration of main e3e7e2c3 needs fresh repository gates and built-app proof. This is not an installed-release, live-provider, Mac/Linux desktop or native-phone result.

## Built app

Clean source `1681abdb50a75056bdf724addae5c6549c488044` ran `npm run build && npx playwright test tests/e2e/watcher.spec.ts tests/e2e/watcher-gate.spec.ts`. Native exit 0; seventeen passed in 1.4 minutes after the build. The full command started at 2026-10-15T01:10:09.780Z and finished at 01:12:07.255Z. Start/exit and cleanup records are in [the evidence folder](../../artifacts/watcher-room-state).

The real main/preload/React journey uses Sotto's fake Codex app server. It starts Watcher from its composer, receives the reply, changes the in-flight limit through ordinary Settings updates from one to two, and sees the final `0 of 2 watched` without a room command reply. The E2E test reasserts the retained user prompt after reload; the after-reload capture shows both the user prompt and assistant reply. Sequential Settings saves do not prove same-window coalescing; reload does not isolate Get from notifications. Deterministic publisher tests separately establish ownership, timer behavior and direct-result/error ordering.

The other journeys cover first entry/model choice, Overview focus trapping and Escape, beside-pane request navigation/draft retention, keyboard order, limit controls, long titles, disconnection, empty state, dark/light at 1600×1000, 1280×800 and 820×560, reduced motion from both the system and Sotto's setting, and stable/Owl saved-record gating. Most layout journeys use a fixed room projection; they establish renderer compatibility rather than actual main delivery.

I opened and inspected all six retained Sotto dark/light room sizes, the reduced-motion setting capture, the minimum beside pane and Overview, and the real-main capture. Text and controls fit, the floating switch stays clear of the composer, the minimum request card remains usable, and no visible clipping or overlap appeared. Automated bounds/contrast checks and keyboard assertions passed. Independent Standards inspection of fifteen fresh captures found no visible defects. Sizes here describe CSS content sizes; Windows scaling can make the saved PNG larger.

Retained captures:

- `room-sotto-{dark,light}-{1600x1000,1280x800,820x560}.png`: the six room layouts.
- `room-sotto-dark-1280x800-reduced-motion-setting.png`: reduced motion with Overview open.
- `beside-sotto-dark-820x560.png` and `list-sotto-dark-820x560.png`: minimum request pane and Overview.
- `room-main-sotto-dark-1280x800.png`: actual main bridge, final limit and retained exchange. This filename describes content size; the image includes the Windows scale factor.
- `readings.json`: contrast, keyboard order and saved-limit readings. Bounds and overlap assertions passed in E2E; this file does not contain their coordinates.

The expanded quiet guard cleared at 18:10:09.1128539-07:00 with 11,028,216 KiB free. A later gate preflight found an external Usage full suite whose process began at18:10:11, just after that guard; the app proof therefore had external overlap. It is compatibility proof, not an isolated performance measurement. The owned keeper was stopped only after its PID, creation time and command matched; its absence, the command child's exit and absence of owned Playwright Electron processes were verified. Clean1681 remained unchanged. A wall-clock jump from roughly17:04 to18:09 was observed while queued; its cause was not established. The pre-app main check occurred between the recorded17:03:31 guard refusal and17:04:40 wait result; an earlier rounded17:05 note was inaccurate. At that check main was `f59f09343c28228e3b0446c2663ed6bd41fce98d`, with no overlapping changes and a successful merge-tree. Required Windows/Desktop/Package and Linux results were green; iOS was ongoing. This was a phase check, not delivery-time freshness.

## Measurements and neighboring contracts

The [performance note](../perf/2026-10-14-watcher-room-state.md) records the exact remote before/after and complete local AFTER05, every retained row, mixed CPU, historical adverse AFTER03 and interrupted AFTER04. The independent Spec review accepted bounded continuation; it did not claim a general CPU improvement or identify a local runtime defect. No further matrix was run to seek favorable numbers.

Nine remote-focused tests plus exact-content node-tests typecheck and focused lint passed before measurement; independent source reviews cleared integrated1681. They cover both startup gates, bounded ownership, missing/unknown/disconnected caches, old optional-service capability fallback and equality with existing room facts. Existing paired service/registered IPC Stop all tests cover that operation; there is no renderer Stop all button. Final full-suite results will supersede historical focused provenance.

No design baseline was regenerated. README and guide still describe the same user actions and authority boundary; the change affects publication and cached reads rather than a new control or flow. ADR0073 and CONTEXT record the internal publication rule.

## Final gates

`npm run typecheck` passed with native exit 0 on clean de3c2634853e8364336dc4d850f8e835fc131a0d, from 2026-10-15T03:02:25.900Z to 03:03:47.894Z. Its expanded quiet guard cleared with 9,819,216 KiB free; an external typecheck was observed later. The exact keeper and command child were absent after cleanup. This pass predates the required main integration and is historical evidence.

The bounded main check at 20:04 PDT found e3e7e2c34f60d96b876f2de8de8140687585615c with successful Windows, Desktop, Package and Linux results, but overlapping runtime changes and merge conflicts required integration. Main's permission-mode, Watch and Stop watching operations retain complete desktop bridges and settlement flushing; optimized remote rows retain standing-watch-only targets and watched/paused flags. Complete owned captures also retain runtime mode, standing watches and own-change metadata. Main's current room uses Conversation/Watched tabs; the subscription/reload journey now checks the existing Threads in flight select, whose populated room value overrides the Settings fallback.

All four exact commands remain pending on the resolved integration: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2`, and `npm run notices:verify`, followed by fresh built-app Watcher/gate proof. Prior Standards and Spec are clear at de3c263; the integration delta and final PR body need their own reviews. Measurements and captures above keep their original source provenance. No PR has been published.

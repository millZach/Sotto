# iPhone working status

September 28, 2026. Follow-up to #468, based on `dc4d9af4`.

## Reproduction

`WorkingStateTests` decodes the host's current background work and running compaction fields into the actual iPhone model. Before the fix, both read Done; background work vanishes from Working. A live shell regression also drives actual `Wire.readFrame` and `AppModel`: foreground running is recognized, but the transition to idle with a confirmed subagent incorrectly becomes Done. Four focused tests produced ten failed assertions before the fix and all passed afterward.

Command used locally: `wsl -e sh /tmp/sotto-ios-swift/run-working.sh`, with the focused `swift test --jobs 2 --filter 'WorkingStateTests|AppModelTests.testLiveShell'` initially, then the full suite. The scratch harness copies actual sources, retains the previous temporary Darwin DNS and SwiftUI observation stand-ins, and strips the SwiftUI import only in its scratch copy. It does not establish native rendering or real URLSession behavior.

## Verification

- Full local Swift suite: 62 tests executed, one opt-in performance test skipped, zero failures. The Windows wrapper failed with an out-of-memory exception after Swift completed; its saved output contains the completed test result.
- Background commands, mixed agent/command work, future work types, questions, permissions, errors, empty/absent current work, retained historical activity, unreachable computers and live completion are covered.
- Windows typecheck failed with `Zone Allocation failed - process out of memory`, before later gates ran. Disk space was available; PowerShell independently reported memory errors. Full required gates and native compilation run on the PR; their final outcomes are recorded there.
- Throwaway status prototype uses the existing row vocabulary and walks through agent handoff, command waiting and compaction. Prototype evidence is separate from native UI evidence. Archive: `prototype/ios-working-status`.

## Remaining checks

- [ ] Confirm the reported two threads are the background/compaction case; installed build and desktop agreement were asked but not answered at this checkpoint.
- [ ] Native iOS build and package tests in CI.
- [ ] Real iPhone status transitions, VoiceOver, Dynamic Type and rendering.
- [ ] Final independent reviews, merge and TestFlight delivery, recorded on the PR.

No production transcript or protocol payload was captured. No host, permission authority or delivery replay behavior changes.

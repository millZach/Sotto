# iPhone thread stability

September 28, 2026. Branch `fix/ios-thread-stability`, originally based on `ef5ee727`, then merged with main at `8b70f16f`.

## Reproductions and changes

- `ThreadPerformanceTests.testBusyThreadListStaysWithinAnInteraction` runs the actual list sorting path on 500 synthetic threads. Before: 0.545 seconds, failing the opt-in 0.15-second interaction budget. After: 0.018–0.023 seconds. Timestamps are parsed once per row instead of twice per sort comparison.
- The original `AppModel.swift`, compiled against scripted storage and transport, fails both connection regressions: a successful hello followed by a refused observed-thread read disconnects the computer; opening a thread also requests a second full detail and an unnecessary shell. The changed source passes. A third test confirms several missing delta bases share one read and closing a thread invalidates that read.
- The phone's hello now skips event history it does not consume. Frames decode into display models outside the UI actor. The v1 detail-delta extension sends changed text and activity rather than the full conversation; tests cover append, replace, new message, activity completion/removal, gaps, wrong thread, stale revision and atomic failure.
- Settlement follows desktop workspace/project settlement, provider overrides and archives. It does not hide waiting requests from Needs you. Finished turns alone are not settled.

## Local verification

- Swift 6.0.3 on WSL: 55 core/model tests passed, including seven model regressions for connection failure, duplicate reads, receive order, disconnects and recovery races. The harness copies the actual sources and supplies only Darwin DNS and SwiftUI observation/scene stand-ins in its temporary package. It does not simulate SwiftUI rendering, URLSession networking, Keychain or iOS lifecycle behavior.
- Actual `HostConnection.swift` typechecked with Swift 5 language mode and Linux FoundationNetworking.
- Typecheck, lint and 174 third-party notice components passed. `npm test -- --maxWorkers=2`: 6,091 passed and 140 skipped on the original base. The final branch runs the same gates in CI.
- HTML prototype inspected in Sotto's browser in dark and light, collapsed and expanded. Prototype captures and checks used the local ignored `artifacts/review-ios-stability/` directory. They demonstrate the chosen disclosure, not a native iOS result. The original prototype is retained on [prototype/ios-thread-list](https://github.com/millZach/Sotto/tree/prototype/ios-thread-list).

## CI and review

- [Native macOS job](https://github.com/millZach/Sotto/actions/runs/36501765938/job/109194012879) passed on `d6056c6c`: package tests with actual SwiftUI and unsigned simulator compilation. The Linux host/socket contract job also passed. Windows gates were running when this evidence update was written.
- Independent in-session standards and spec reviews found receive-order, recovery-race and Activity retry issues. Each was fixed and both reviewers reported no remaining material findings. A standalone external reviewer launch was blocked by automatic approval review; the external cross-model pass was not run.

## Remaining native checks

- [x] `sh apps/ios/Scripts/verify.sh` on macOS (actual SwiftUI model tests and unsigned iOS build).
- [ ] iPhone: launch, open a thread without reconnecting, stream a long reply, scroll history, background/foreground and switch networks.
- [ ] Native dark/light, Dynamic Type, VoiceOver, reduced motion, keyboard and settled disclosure.
- [ ] Confirm the original laptop/iPhone scenario after installing the new build. TestFlight upload follows green final PR gates and merge; its workflow result is recorded on the PR.

Windows and HTML evidence cannot establish those results. No raw user transcript, credential or production protocol body was captured.

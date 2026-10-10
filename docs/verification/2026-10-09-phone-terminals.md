# Terminal approvals on paired phones

Issue [#884](https://github.com/millZach/Sotto/issues/884), branch `feat/phone-terminals`, based on `origin/feat/terminal-agent-states`. Windows 11 on LAPTOP-RUSSH2J5, October 9, 2026. Source install used this worktree's own `npm ci`; no dependency link was made. No push or pull request is authorized in this run.

**Native iPhone surface: NOT VERIFIED.** Windows cannot compile Swift or run the simulator. SottoCore and AppModel XCTest cases and simulator journeys are written, but none was run here. The Native iOS client (macOS) CI job is the compile/test check after the lead pushes the branch. Simulator screenshots remain a required follow-up; the HTML reference and desktop capture below are not simulator evidence. Android was left untouched because no JDK was found on PATH, through JAVA_HOME or in the standard Java/Microsoft/Adoptium/Android Studio locations.

## Reference inspected

The existing prototype was opened at `?variant=B` and its iPhone frame inspected. [Approved variant B](../../artifacts/phone-terminals/approved-variant-b.png) is a reference capture only. Its persistent native choices are historical illustration; ADR-0066 governs the actual one-time hook answers. The prototype source was preserved unchanged. Reproduce its capture with `node tools/capture-phone-terminal-prototype.mjs`.

## Built desktop and wire: VERIFIED

`tests/e2e/phone-terminals.spec.ts` launches the current built Electron app with an isolated profile, stand-in Tailscale and the native PTY running the synthetic Claude CLI. It turns on phone access, pairs a wire client through the issued code, opens Terminal mode and its real New terminal dialog, submits work and reaches the current native permission screen. [Desktop live approval](../../artifacts/phone-terminals/desktop-live-approval.png) was opened and visually inspected: the Needs you row, full-pane attention edge and live permission are visible without clipping.

The paired client opts into `terminals`, receives the row without screen text, reads the bounded approval preview, is refused with Can answer off, then sends No after the switch is enabled. Its response confirms the actual packaged helper's hook acknowledgement. A second answer is stale. This proves the built desktop path, not a native iPhone or real provider session. No terminal keystroke is sent by the phone path.

`tests/integration/phoneTerminals.test.ts` uses the real socket listener and terminal workspace with a scripted hook. Ten tests cover feature negotiation and older clients, omission of output from rows/pushes, bounded current screen reads, changed/reopened/expired targets, client-bound review, revocation and removal, concurrent answers, receipt reconciliation and payload replay protection, and foreground/background/disconnected visibility. Existing terminal state and phone access journeys check their neighboring surfaces too. Their design captures were not adopted as new baselines because no desktop look change was intended.

## Gates and review

Final gate results and two-axis review outcomes will be recorded here after the integrated checks complete.

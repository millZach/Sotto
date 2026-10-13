# PR #651: late pongs through a tunnel

Windows worktree resumed from `5ab00c95`, branch `fix/bh-02-socketserver`. This pass changes connection liveness without changing UI or protocol v1 fields.

## Acceptance and state

- [x] Reproduce both directions with Node's output buffer already empty and a pong delayed past the first round.
- [x] Require two consecutive silent rounds for host and desktop-client pings; writes since the previous ping and any received bytes prevent silence.
- [x] Check partial incoming frames and bounded closure of genuinely silent peers.
- [x] Count URLSession byte growth as additional phone progress, retaining independent protection for pending reads.
- [x] Integrate current main and complete affected Electron journeys and standards/spec review.
- Windows full-suite result and latest-head CI are recorded below and in [PR #651](https://github.com/millZach/Sotto/pull/651).
- [ ] Owner: check network changes and slow downloads on the physical iPhone.

## Reproduction

`npx vitest run tests/unit/host/socketFrames.test.ts --maxWorkers=2` failed six new cases before the fix: host download and desktop upload connections closed at 50 seconds before the held pong could arrive at 60 seconds; drained writes did not protect the next round; both silent-peer cases closed after one round. The minimal Duplex seam uses the same SocketFrames class as the authenticated listener and desktop socket client, with synchronous write callbacks proving `writableLength === 0`. There are no real sleeps.

After the fix, `npx vitest run tests/unit/host/socketFrames.test.ts tests/integration/socketServer.test.ts --maxWorkers=2` passed all 34 cases. Received partial frames stay alive across multiple rounds; heartbeat-owned pings do not renew activity and completely silent peers close at 75 seconds. Drained application writes prevent a silent round even when a tunnel hides the remaining transfer. Opted-in peers also count outgoing frames as progress.

## Integrated Windows verification

Fix `8db0822a` was followed by merge `4d4ef32b`, integrating `origin/main` at `8002b547` without conflicts. The merge retains #672's command error handling and #674's renderer changes. Before integration, 99 focused tests across socketFrames, socketServer, socketHostService, socketHost and socketComposer passed. The full integrated gate covers those files again.

Typecheck, lint, notices verification (174 components) and build passed on the integrated branch. The required `npm test -- --maxWorkers=2` passed: 516 files passed, 39 skipped; 7,106 tests passed, 154 skipped, no failures (1320.08 seconds). These are actual local Windows results, replacing the earlier Linux-only limitations for this revision.

After build, `npx playwright test tests/e2e/phones.spec.ts tests/e2e/hosts.spec.ts tests/e2e/command-receipt.spec.ts --workers=1` passed all three journeys on Windows (38.8 seconds). They exercise the actual Electron app, preload and phone listener against isolated fixture profiles: phone setup, pairing and shutdown; host settings; and command receipts, retained drafts/settings and model selection across reconnect. They are not live Tailscale/SSH or real-iPhone evidence.

Inspected the light paired-phone view at 820x560 and the dark Hosts view at 1600x1000. The existing journeys also captured 1280x800 and both themes. Retained evidence: [minimum-size Phones](../../artifacts/review-651-r3/phones-paired-820-light.png) and [dark Hosts](../../artifacts/review-651-r3/hosts-1600-dark.png). No UI layout or design baseline changed.

Independent gpt-6.1-sol high reviews of `git diff origin/main...HEAD` at `4d4ef32b` found no actionable Standards or Spec findings. Both axes inspected the integrated implementation and earlier PR fixes. All PR issue comments, reviews and inline comments were read; automated usage/credit-limit notices were the only ignored entries. The earlier pairing comment and ADR now use neutral caller-limit wording. The three composer P2 points retain their real-socket and coordinator regressions. Latest-head CI and the final feedback check are tracked in the PR body.

## Native limits

The phone samples received-byte growth across rounds as additional progress. Pending observe/detail deadlines remain independent of byte counters. Apple documents the inherited [received-byte count](https://developer.apple.com/documentation/foundation/urlsessiontask/countofbytesreceived) but does not promise partial WebSocket-frame updates. A slow unsolicited push on an implementation that does not advance this counter remains unverified on a physical device.

Existing SottoAppModelTests compile the actual AppModel with a replacement HostConnection in Dependencies.swift; they do not compile or inject a transport/clock into the real HostConnection. A wiring test for request begin/finish and heartbeat scheduling would require a new native target and transport/clock seams. This pass adds a SottoCore regression for unrequested byte progress, followed by bounded silence, rather than claiming to test that wiring. Native compilation and XCTest execution require macOS CI on this Windows machine.

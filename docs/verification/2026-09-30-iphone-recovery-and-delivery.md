# iPhone recovery and delivery

Package pkg-06 covers #499, #525, #526 and #584. #491 was already corrected in the
base: the handshake and selected thread read have separate failure paths, covered
by `testAThreadReadFailureDoesNotDisconnectItsOnlineComputer`. The issue has a
comment documenting that evidence; no duplicate patch was made.

## Regression coverage

The app-model tests compile the actual `AppModel.swift` against scripted storage
and transport on macOS. They cover a locked launch followed by automatic
connection after unlock, undecodable saved items, a completed answer receipt with
its request still visible, an unrelated host error, an uncertain request, late pushed
reply acceptance and failure, Stop while a reply is unconfirmed, a marker write
failure, stale authority updates and both current-host and older-host hello races.
The tests script lost acknowledgements rather than waiting for a real timeout.

Raw socket tests exercise Can answer being enabled and revoked without reconnecting
on the desktop phone listener and headless host. Two clients verify that each gets
only its own policy. Dispatch still checks host policy independently of the shell.

The delivery state study exercised Stop after a lost acknowledgement and late
reply evidence with the existing labels. It is a logic demonstration, not evidence
of native execution. Review added the distinction between an answer command's
own completed, error-free receipt with explicit outcome evidence and a request
disappearing for another reason.
The latter clears its marker with "That request is no longer waiting."

The native app-model target now compiles the production `KeychainStore.swift`.
Its test seam supplies raw bytes and storage access failures, with JSON decoding
left in the real store. Regressions distinguish a missing item from a damaged one,
preserve a damaged index, recover readable computer items, name unrecoverable host
IDs, warn about damaged action markers, and refuse an inaccessible item before any
index migration write. Settling a marker also preserves unrelated feedback.

The real coordinator/service/socket regression initially failed for both provider
refusal and uncertainty: each returned only `{ status: "completed" }`. The fix
carries command-local outcome evidence into the receipt without consulting the
published shared error. Both regressions pass, as do success with a concurrent
unrelated failure and the existing explicit-authority journey. Native regressions
also cover older ambiguous receipts and desktop resolution after a refused answer.

## Windows verification

Typecheck, lint, third-party notices and the Electron build passed. The full
two-worker suite and native CI results are recorded in the pull request.
`npx playwright test tests/e2e/phones.spec.ts --workers=1` passed its one journey:
setup failure and recovery, pairing, Can answer, removal and listener shutdown.
It uses a scripted Tailscale service and a real local socket listener.

The journey captured both appearances at 1600x1000, 1280x800 and 820x560 with
reduced motion. The dark 820 and light 1600 paired-phone captures were inspected:
the controls and text remain readable, with no horizontal overflow. This batch
does not restyle the desktop. Incidental captures stay in ignored `test-results/`;
no design baseline or committed artifact was replaced.

Independent standards and specification reviews found no remaining findings.
Review corrected an older-host hello race and ensured recovery connects newly
loaded computers even after an earlier Active callback while storage was locked.
The rework review also found disappearance pushes racing the reconnect shell and
hello. Both now retain the marker through its own receipt check, with regressions
asserting one receipt read and no command resubmission.

## Native visual evidence

The first rework CI run, [36774010024](https://github.com/millZach/Sotto/actions/runs/36774010024),
captured the neutral request message and unreadable-action warning on the small
iPhone simulator before XCTest rejected the longer recovery message as an
identifier. The corrected query matches its full label with a predicate; it keeps
the same assertion.

The corrected [run 36778392859](https://github.com/millZach/Sotto/actions/runs/36778392859)
passed Windows, Linux and native iOS. The native package executed 93 tests with
one skip and no failures. All four Focus journeys passed on each phone size,
including all three feedback scenarios in both appearances and reachable dismissal.
The large simulator also used accessibility text size and reduced motion. This
evidence precedes the clean merge of main at `4af39aa2`; final merged-state gate
status is recorded in the PR.

The merged [run 36782409656](https://github.com/millZach/Sotto/actions/runs/36782409656)
also passed the native package tests (93 executed, one skip) and four journeys on
each phone size. GitHub nevertheless cancelled the job at its 35-minute safety limit during
completion; the check annotation confirms that limit was exceeded. The CI job
now allows 45 minutes for simulator startup, interaction, screenshots and cleanup.
The test assertions and their deadlines are unchanged. The replacement check's
status is recorded in the PR.

Main later advanced to `d343d76a`. Its iPhone new-thread flow was merged with
these fixes; the new creation tests use the same real Keychain decoding seam.
Independent reviews checked the conflict resolutions, including returned creation
results, ID-only reconciliation, receipt scripts and feedback ownership. The PR
records the final merged gates. The first later-merge native run compiled and
executed 122 package tests, with one skip and one assertion failure: an answer
settlement test checked before the activation-owned reconnect finished. The
regression now observes actual marker settlement, preserving its feedback and
no-resend assertions rather than sleeping. The captures below show the feedback surfaces
before that later merge; main's new-thread design evidence is recorded separately
in [its verification note](2026-09-30-iphone-new-threads.md).

Main moved once more to `1f9a5597` while the replacement checks ran. Its coordinator
recovery and secure-settings fixes were merged; the only conflict joined adjacent
socket regression groups. Both groups remain, and all 166 focused coordinator and
socket tests passed, including answer refusal and uncertainty after disappearance.
Both independent reviewers cleared the integration. No iPhone source changed in
this later merge.

These four inspected captures are retained:

- [Neutral request message, small phone in dark](../../artifacts/review-iphone-feedback/request-gone-small-dark.png).
  The message and dismissal remain readable and reachable.
- [Unreadable actions, small phone in light with larger text](../../artifacts/review-iphone-feedback/markers-small-light-larger-text.png).
  The entire warning wraps within the existing feedback surface without clipping.
- [Recovered computer warning, small phone in light with larger text](../../artifacts/review-iphone-feedback/computer-small-light-larger-text.png).
  The host ID wraps and the complete recovery instruction remains visible.
- [Recovered computer warning, large phone in dark at accessibility text size](../../artifacts/review-iphone-feedback/computer-large-dark-accessibility-text.png).
  The larger warning remains readable, with its dismissal at the top of the surface.

## Limits

Windows cannot run SwiftUI or the native package tests. The macOS CI gate ran
those tests and Focus simulator journeys, including revised feedback in both
appearances, larger text and reachable dismissal. Native results and inspected
captures are recorded above and in the PR. Neither scripted transport
nor those journeys establishes physical-device locked Keychain behavior,
cellular-network compatibility or hands-on VoiceOver. No physical iPhone test was
performed for this batch.

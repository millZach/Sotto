# Watcher on the iPhone: the Watcher tab

Ticket 8b of the Watcher plan, branch `feat/watcher-iphone`, built on ticket 8a's `feat/watcher-phone` (the wire contract at `3cb736fdd`, then its host and SottoCore models merged at `da592927c`). Windows 11 on LAPTOP-RUSSH2J5, October 11, 2026. The design is Zach's picks from the phone prototype of the same day (1B, 2B, 3B, 4B, 5A, 6B, 7A), recorded in ADR-0073's October 11 amendment.

**Native iPhone app: NOT VERIFIED.** No Swift was compiled, run or tested on this machine: there is no Xcode or Swift toolchain here, and the brief allowed installing none. Everything below the first section waits for the Native iOS job on macOS. Until that job is green and its `watcher-*` screenshots have been opened and inspected, this work is source only.

## What was checked here

- **Provider logos and the owl as vectors.** The desktop's provider marks (`src/renderer/src/agents/ProviderMark.tsx`) and Watcher's owl (`WatcherOwl.tsx` on `feat/watcher-room`) were rewritten as SVG paths using only absolute moves, lines and cubic curves, with arcs turned into curves, so Xcode's SVG reader has nothing unusual to parse. Each rewritten file and the desktop's own path were drawn at 256 pixels in Chromium and compared pixel by pixel: Claude Code, Devin, Grok Build, the owl and both tab owls match exactly; Codex differs in 9 antialiased edge pixels out of 24,484 drawn. [The comparison sheet](../../artifacts/watcher-iphone/provider-marks-comparison.png) shows each desktop mark beside its rewrite, and the tab owl with its working dot. This shows the shapes are the desktop's; it does not show how the asset catalog draws them on a phone.
- **The prototype.** The approved walkthrough's captures were opened and read for the layout this build follows: `01-threads-dot`, `02-conversation`, `03-watched`, `06-watched-thread-3B`, `07-needs-you-4B`, `13-watcher-permission` and `17-no-can-answer-watcher` (`captures-2/` beside the prototype). The app keeps the system tab bar, so the dot is drawn into the tab's owl rather than beside it in the accent colour, and takes the tab bar's tint.
- **The contract.** The model was written against `phone-contract.md` and `src/shared/watcherPhone.ts`, then switched to 8a's SottoCore models (`WatcherPhoneState`, `WatcherWire` and the result enums) once they landed. Its uses of the wire were read against 8a's host code (`src/main/agents/watcherPhone.ts`, `src/host/socketServer.ts`): the page comes with each shell to a phone that accepted `watcher-phone`; Watcher's own threads never appear in a phone's thread list; `watcher-phone-answer` answers only threads on the computer that runs Watcher, under its Can answer; a card's `mayAnswer` is display only.
- **Review by reading.** Every changed Swift file was read for compile errors by a second reviewer, since nothing here can compile it: SottoCore member and nested type names, conformances SwiftUI needs, enum patterns, file-scoped `private` use, the AppModel test target's sources, the Xcode project's entries and the asset names. It found no compile failure. It found one journey assertion that passed before what it claimed had happened (a receipt row that already existed), which now waits for the second row. Reading is not compiling.

No root gate covers this work: it changes only `apps/ios/`, documents and the iOS job's timeout. The npm suite does not read Swift.

## What waits for the Native iOS job

`sh apps/ios/Scripts/verify.sh` must compile the app and its tests and pass:

- `WatcherModelTests` (SottoAppModelTests, the real `AppModel.swift` against a scripted computer): only a computer offering `watcher-phone` gets a tab and is ever asked for Watcher, and its page comes with hello; the dot and badge, the badge counting only what Threads doesn't show, and neither on a computer that can't be reached; the owl on a watched thread until it is taken over; an older page never replacing a newer one; a card answered through `watcher-phone-answer` with the exact target and command, confirmed only by its own receipt; nothing sent without Can answer; a forbidden answer leaving no marker and turning answering off; the request sheet reading a card where it waits; Stop all sending nothing until confirmed and then only the confirmed preview, and only where the computer offers it; refused and partial Stop all words; one draft ID per exact text, nothing resent, and words leaving the box once a later page says Watcher took them; the box waiting while Watcher's own request waits; Watcher's own requests and errors alerting under the existing switches, never its finished turns, once each, and not while its tab is on screen; a tapped Watcher alert opening the tab; receipts under their reply and a group without one standing alone by its time.
- `HostConnectionTests.testHelloOptsInToWatcherAndKeepsTheSnapshotFeatures`, and 8a's `WatcherTests` in SottoCoreTests.

`sh apps/ios/Scripts/verify-ui.sh` must pass six new Focus journeys on the iPhone SE and the iPhone 16 Pro Max:

| Journey | What it shows | Screenshots |
|---|---|---|
| `testTheWatcherTabOpensAndTakesAMessage` | The tab between Threads and Computers; VoiceOver's value for the working dot; Watcher's model and computer; a receipt row; typing in Ask Watcher, sending, and Watcher's answer arriving | `watcher-conversation-dark`, `watcher-sent-dark`, `watcher-sent-light` |
| `testAReceiptRowOpensItsThread` | A row of what Watcher did opens its thread, with the logo and owl under its title and the takeover line in its reply box | `watcher-receipt-thread-dark`, `watcher-receipt-thread-light` |
| `testAWorkersCardIsAnsweredInWatchersPage` | Fix login test's own question answered in Watcher's page; Answer sent; the card leaves | `watcher-card-dark`, `watcher-card-answered-dark`, `watcher-card-light` |
| `testAPhoneWithoutCanAnswerSaysSoInWatchersPage` | Without Can answer: the badge and its spoken value, both cards read only, Watcher's own card, the held box, the sheet's own words | `watcher-cannot-answer-dark`, `watcher-cannot-answer-sheet-dark`, `watcher-cannot-answer-light` |
| `testStopAllAsksFirst` | 3 of 4 watched; Stop all asks first; Cancel stops nothing; confirming stops the three Watcher started | `watcher-watched-dark`, `watcher-stop-all-dark`, `watcher-stopped-dark`, `watcher-stopped-light` |
| `testAOneTapQuestionIsAnsweredOnItsCard` | A fix found on the way: a Threads card's chip for one structured question now goes as that question's answer | `threads-glow-card-answered` |

`testThreadsAndComputersInTheGlowLook` also checks that a computer without Watcher gives no Watcher tab.

Two parts depend on behaviour this machine could not observe, and the journeys are written to fail if either is wrong:

- **The tab's spoken state.** SwiftUI's tab items take a title, an image and a badge and nothing VoiceOver can read for the working dot, so the app sets the tab bar item's accessibility value through UIKit (`TabItemAccessibility` in `Views.swift`). Two journeys wait for the tab's value to contain "Working" and "1 needs you".
- **The vector assets.** Xcode's SVG reader draws the logos and owls; every journey's screenshots must be opened to see them drawn, at their size, in the line's colour.

The iOS job's safety timeout rises from 75 to 110 minutes: it already ran past an hour with nineteen journeys, and these add six. Before calling the look verified, open the `watcher-*` screenshots in the job's `ios-focus-journeys` artifact, in both appearances and at the large phone's accessibility text size.

## What neither proves

A live Owl desktop running Watcher with a real iPhone: the shell's page arriving over the network, a send's draft settling from `draftDeliveries`, an answer's receipt, Stop all against real threads, alerts on a device, VoiceOver and Dynamic Type by hand, and the keyboard's microphone key dictating into Ask Watcher. Answering a card for a thread on another paired computer (a host such as forge) goes to that computer as an ordinary answer; no journey has a second online computer to show it.

## Decisions made here

- With several computers running Watcher, the tab shows the first in the order they were added.
- A worker's brief from Watcher is not labelled From Watcher in the worker's own thread, as the prototype showed: the wire marks no message as Watcher's.
- Watcher's own requests are not on Threads; the Watcher tab's badge counts them, with any card for a thread this iPhone doesn't list.
- The Watcher box keeps no saved marker for a send. One draft ID per exact text makes sending again safe, and the page's `draftDeliveries` clears words Watcher took.

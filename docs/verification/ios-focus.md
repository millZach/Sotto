# iPhone Focus redesign

September 29, 2026. [PR #474](https://github.com/millZach/Sotto/pull/474), based on `4aeb6257`.

## Scope and reference

The native SwiftUI implementation follows the approved Focus revision at `0d3e5835` on `prototype/ios-threads-redesign`, with approval recorded at `54607463`. Threads opens first, search stays above the scrolling list, and Settings replaces the Needs you tab. Questions lead, working threads remain prominent, recent threads use quieter rows, and settled matches remain searchable. Phone-only appearance and Larger text persist across launches.

## Checks completed

- Local `npm run typecheck`, `npm run lint`, and `npm run notices:verify` passed.
- Local `npm test -- --maxWorkers=2`: 472 files passed, 39 skipped; 6,247 tests passed, 151 skipped. Windows CI at `27fabf23` passed the full gates with 6,251 tests passed and 148 skipped, across 472 passed and 39 skipped files. The Linux host gate passed.
- The native Swift package suite executed 66 tests with one skipped and no failures. The unsigned generic simulator app compiled successfully. Focus tests cover reachable requests and background work in settled threads, offline snapshots, search, computer filtering, waiting commands, compaction and failures.
- Standards and spec each received a built-in GPT-6-astra high review and a Grok 4.7 high cross-check against `4aeb6257`. Fixes preserve access to every pending request, let read-only request sheets close, keep search pinned, select the actual bundled font weight, and align the docs with the approved heading. Follow-up review confirmed the request-access fixes.
- The device-specific UI test build initially failed because the app requested an x86_64 slice from the arm64 SottoCore object. `27fabf23` restricts that invocation to the selected simulator architecture; the next run linked and executed the native UI tests. The generic simulator build continues to exercise the broader build configuration.

## Native inspection and delivery

After correcting overshooting test gestures and switching to full-screen captures, [CI at `c6a3d549`](https://github.com/millZach/Sotto/actions/runs/36596516560) passed all jobs. The three native UI journeys passed on both iPhone SE (3rd generation) and iPhone 16 Pro Max, iOS 26.5. The large phone used accessibility-large text and Reduce Motion. The journeys cover pinned search, foreground/background work, settled results, computer scope, both pending requests and reopening either, Messages/Activity, and preference persistence. Windows passed 6,251 tests with 148 skipped; the native package suite executed 66 tests with one skipped and no failures.

All 14 small-phone captures were inspected, and an independent critic inspected all 14 large-phone captures against the approved reference. The primary reviewer also inspected large Settings, keyboard/search, landscape and Computers. This found two visual issues: the system search placeholder measured about 1.7:1 contrast in light mode, and an accessibility-size computer row truncated Studio Mac. The follow-up uses the existing muted theme role for search (5.27:1 light, 7.51:1 dark) and stacks the computer status under its full name at accessibility sizes. The other text-role pairs used by Focus meet 4.5:1 in both themes. Native recapture at `c4e6d57e` confirmed both fixes, and targeted standards review found no further issues.

[CI at `c4e6d57e`](https://github.com/millZach/Sotto/actions/runs/36599781699) passed Windows (6,253 tests passed, 148 skipped), Linux, native package tests and simulator compilation. All three small-phone journeys and two large-phone journeys passed. The large-phone appearance journey failed before entering the app: Xcode timed out launching it in test setup. The following two journeys on that simulator launched and passed. The final evidence commit reruns CI; its result and delivery are recorded on the PR rather than inferred from this earlier run.

The following unmodified screenshots come from that native recapture:

- [Connected Focus](../../artifacts/ios-focus/small-focus-connected.png) and [foreground/background working cards](../../artifacts/ios-focus/small-working-threads.png).
- [Light appearance with Larger text](../../artifacts/ios-focus/small-focus-light-larger-text.png) and [Settings](../../artifacts/ios-focus/small-settings-light-larger-text.png).
- [Full computer names at accessibility size](../../artifacts/ios-focus/large-computers.png) and [settled search with the keyboard](../../artifacts/ios-focus/large-search-settled-keyboard.png).
- [Landscape at accessibility size](../../artifacts/ios-focus/large-focus-landscape.png) and [the read-only request sheet](../../artifacts/ios-focus/small-thread-question.png).

The pinned header stays visible while the list scrolls beneath it. Native scroll-edge fades and the translucent tab bar can cover parts of a scrolling row; the automated journeys reveal and activate the relevant rows. Reduce Motion was enabled for the large simulator; still captures alone do not establish animation behavior.

The fixture uses the real SwiftUI hierarchy with in-memory host summaries and details, bypasses Keychain, and cannot send commands. Release builds omit the fixture entry point. No desktop design baseline was regenerated; this change affects the native iPhone surface.

The fixture cannot establish live paired-phone networking, streaming, permission delivery, or hands-on VoiceOver behavior. Those remain separate physical-device checks. The PR records the final merge and TestFlight upload state.

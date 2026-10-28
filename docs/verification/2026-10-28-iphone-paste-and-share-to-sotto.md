# iPhone: a paste attaches, and Share to Sotto fills Watcher's box

October 28, 2026, on the iPhone Duo simulator (iOS 27.1, Xcode 27.1), with the UI fixture. ADR-0157, and ADR-0131's October 28 amendment.

## Paste

`FocusJourneyTests.testPastingACopiedFileAttachesItAndWordsStayWords` puts a PDF on the pasteboard, as Files does when a file is copied, and pastes it into a thread's reply box from the field's own menu. Paste is offered, and the PDF goes in as a file pill, **Pasted file.pdf**, with nothing typed in the field. Copied words then paste as words. [`thread-pasted-file.png`](../../artifacts/iphone-share-to-sotto/thread-pasted-file.png).

SwiftUI's vertical text field is UIKit's `VerticalTextView`, which refuses Paste for a pasteboard with no words, even with a paste configuration that takes anything. That was checked with a probe in the running app, which printed `VerticalTextView canPaste=false providers=[["com.adobe.pdf"]]`. So the box's field marks itself, and that class offers Paste when the pasteboard holds a photo or a file, and hands the paste to the marked box. A field without a mark, or a paste of words, goes on as before.

## Share to Sotto

`FocusJourneyTests.testASharedFileAndLinkLandInWatchersBox` leaves a share in the inbox as the extension does: a PDF and a link, with `share.json` written last. It then opens Sotto. The Watcher tab opens with **Quarterly report.pdf** in the box, the link in the field and the keyboard up. [`watcher-shared.png`](../../artifacts/iphone-share-to-sotto/watcher-shared.png). The journeys build unsigned, with no App Group, so in the fixture the inbox is a folder of the app's own.

The share sheet itself could not be driven here. The extension builds and is embedded in `Sotto.app/PlugIns`. Its first run on a device is on TestFlight.

## Signing

An archive made with `CODE_SIGNING_ALLOWED=NO`, as `testflight.sh` makes it, has no entitlements in either bundle. `xcodebuild` refuses ad hoc signing for iOS. So the script signs the archived app and extension ad hoc with `codesign` before the export. A local archive signed that way carries `group.com.millzach.sotto.ios` in both bundles, and `codesign --verify --deep` passes.

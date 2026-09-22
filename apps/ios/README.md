# Sotto for iPhone

Native iOS 17+ client for a Sotto host on a private Tailscale connection. The app pairs with a code read on the host, opens existing threads, sends text, interrupts supported work and answers current requests explicitly. Pairing does not grant permission authority. New threads, terminal, file management, speech, push and Android are outside this first client.

This directory is independent of the Electron/npm package. SwiftUI, Foundation and Security are system frameworks; SottoCore has no external dependencies. The wire models mirror `src/shared/hostProtocol.ts` version 1. One host is saved per installation; cached state is scoped to its persisted host ID. No signing team is embedded and no build has been uploaded.

## Build and test

Use a Mac with Xcode 15 or newer (iOS 17 SDK or newer) and its command-line tools selected. From the repository root:

```sh
swift test --package-path apps/ios
sh apps/ios/Scripts/verify.sh
```

The second command also compiles an unsigned simulator app. This is independent of root npm tests. It must run before calling the native client verified. The shared Xcode scheme is `Sotto`; the package tests cover protocol rejection, host/session identity, native permission IDs, stale requests, structured questions and ambiguous delivery. They do not substitute for a live app journey.

To run the built app on a booted simulator:

```sh
xcrun simctl install booted apps/ios/.build-native/Build/Products/Debug-iphonesimulator/Sotto.app
xcrun simctl launch booted com.millzach.sotto.ios
```

Choose an installed iPhone simulator using Xcode or `xcrun simctl list devices available` first. The app deliberately accepts only certificate-validated `https://*.ts.net` host origins; it has no localhost/cleartext production bypass. Native simulator and device verification therefore require a reachable private host route. Browser fixtures are at `node docs/prototypes/ios-thread-prototype.mjs`; they are not the iOS app.

## Sign and install on an iPhone

Open `apps/ios/Sotto.xcodeproj`, choose the Sotto target, set your own development team in Signing & Capabilities, and confirm that `com.millzach.sotto.ios` is available for that team (change the identifier if needed). Connect the iPhone, enable Developer Mode when Xcode requests it, select it as the run destination and build. Do not commit team-specific provisioning material or account credentials.

Install/sign in to Tailscale on the iPhone and grant the intended tailnet access. Configure Tailscale Serve on the host to forward its private HTTPS origin to the loopback listener from #137. Enter that origin and the fresh code printed by the host's pairing command. Allowing this client's answers is a separate explicit host policy operation; use the host CLI's documented `--allow-answers` operation with this client ID. No credential or pairing secret belongs in a URL or log.

## TestFlight preparation

The owner chose TestFlight. Paid program enrollment, App Store Connect team access and signing remain to be verified on the build Mac. Review a signed device build before uploading. A release-style archive does not depend on Metro or another development server:

```sh
xcodebuild -project apps/ios/Sotto.xcodeproj -scheme Sotto -configuration Release \
  -destination 'generic/platform=iOS' -archivePath apps/ios/.build-native/Sotto.xcarchive \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID archive
```

Copy `ExportOptions.example.plist` to the ignored `ExportOptions.local.plist`, set the actual team ID, then export locally:

```sh
xcodebuild -exportArchive -archivePath apps/ios/.build-native/Sotto.xcarchive \
  -exportOptionsPlist apps/ios/ExportOptions.local.plist -exportPath apps/ios/.build-native/export
```

The example exports and does not upload. Check bundle/version/build numbers, privacy/export-compliance answers and the signing profile before TestFlight submission. Increment build numbers deliberately. This app uses platform TLS/Keychain, does not contain a custom cryptographic algorithm, and declares standard encryption use in Info.plist; review that declaration if the implementation changes. App Store review/acceptance is not implied by a local archive.

## Lifecycle and privacy

The host does the work while iOS suspends the app. Foreground activation gets a fresh signed session, shell and selected-thread snapshot; socket frames never replay commands. Lost acknowledgements retain an ID-only Keychain marker. A receipt that vanished after host restart stays unconfirmed; the user can check the thread and explicitly dismiss the marker without resending it. A completed transport receipt alone does not establish prompt delivery: provider delivery evidence must agree.

The per-device host token uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, with synchronization disabled. Provider keys never enter this client. HTTP and socket credentials are headers/body fields, never URL parameters, and redirects are refused. URLSession is ephemeral with no cookies or disk response cache. Transcript and unsent draft text remain in memory; backgrounding preserves drafts, termination loses them. The app obscures content while inactive. No transcript, token or protocol-body logging is implemented.

Forget first revokes this pairing on the host, then clears Keychain and memory. Offline Forget keeps credentials for retry; an already-revoked token can be removed locally. Keychain reinstall behavior is not a substitute for host revocation. The app asks for no microphone, camera, photo, location or notification access.

## Verification required before delivery

- Native package tests and simulator compile; inspect both themes at small/large text sizes, VoiceOver, reduced motion, portrait and landscape, and the software keyboard.
- On the real iPhone and desktop, read the same thread on the host, reply and receive streaming updates, interrupt, answer structured questions and each supported permission form explicitly.
- Revoke authority while a request is visible; another client answers first; disconnect after send but before acknowledgement; restart host; switch networks; lock/unlock; terminate/relaunch. No automatic resend or stale request answer.
- Expired/invalid pairing, Keychain locked/unavailable, wrong host identity, offline host, revoked token, and revocation followed by local deletion failure.
- Verify host work continues while the app is suspended. Record device/iOS/app versions and native captures. HTML, static source checks and simulator builds cannot establish this result.

## Bundled assets

Figtree is distributed under the included `Sotto/Resources/Figtree-OFL.txt` (SIL OFL 1.1). `Figtree.ttf` is a regular-weight instance of the upstream variable font at [Google Fonts revision a60a77e](https://github.com/google/fonts/tree/a60a77e14f28abd4ef243a1b5dfc48df0cec5205/ofl/figtree), instanced with fontTools as a development operation; fontTools is not an app dependency. The app icon renders this repository's existing `build/icon.svg` on Sotto's canvas. Native named colors are sRGB samples of the default Sotto semantic roles in `tokens.css`, with light/dark variants; no theme/provider text is interpreted as a native color.

Current evidence and limitations: [implementation plan](../../docs/plans/ios-client.md). Native compilation, signing and device execution must be reported separately from source completion.

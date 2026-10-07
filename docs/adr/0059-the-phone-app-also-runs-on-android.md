# The phone app also runs on Android

## Status

Proposed October 5, 2026, by HermeticOrmus, for the owner's decision. Nothing here is accepted until the owner says so. Amends [ADR-0025](0025-headless-host-and-client-identity.md), which chose an iOS-only first phone client.

## Context

The iPhone client (`apps/ios`) is the only way to reach Sotto's threads from a phone, and it needs an iPhone, a Mac or the TestFlight workflow to install. A contributor who uses Android could not reach their computers' threads at all. The host protocol is already the shared contract between clients (ADR-0025): version 1 is frozen, `docs/host-protocol.md` lists every message, and nothing about it is iOS-specific.

The options considered:

1. **iPhone only.** Rejected for the reason above: an Android owner has no phone client.
2. **A cross-platform rewrite** (React Native, Flutter or Kotlin Multiplatform) that replaces the SwiftUI app. Rejected: it would discard a reviewed, tested iPhone client and its native accessibility, signing and Keychain handling, and bring a JavaScript or shared runtime ADR-0025 chose to avoid.
3. **A native Android client that ports the iPhone client.** Chosen. Kotlin and Jetpack Compose, with the protocol core ported line for line from SottoCore and its unit tests ported with it.

## Decision

`apps/android` is a Gradle project, independent of npm and of `apps/ios`, as `apps/ios` is independent of npm. Its libraries are AndroidX, Jetpack Compose, kotlinx.serialization and OkHttp (Android has no built-in WebSocket client). They ship in the APK only; the desktop's runtime dependencies (ADR-0018) are unchanged.

It is the iPhone client's behaviour on another platform, not a new design. The same three tabs, the same two-step pairing, the same rules: questions and permissions first, answers only with the computer's Can answer policy (ADR-0004), unconfirmed actions never resent, every thread named with its computer, nothing logged. The copy is the iPhone's with "iPhone" read as "phone". Its hello accepts the same features except `client-liveness`: OkHttp answers the host's pings, so the host keeps its pings for this client as it does for every client that did not opt in. It accepts `https://*.ts.net` on 443, 8443 and 10000 (ADR-0033, October 4 amendment) and nothing else.

Pairings and unconfirmed-action markers are stored encrypted with an Android Keystore key that never leaves the device; backup and device-to-device transfer are off. The app contacts only the computers the user pairs, over the tailnet.

The application ID is `com.millzach.sotto.android`, beside the iPhone's `com.millzach.sotto.ios`. It cannot change after a build is installed without becoming a separate app, so the owner may want to pick it before anyone installs a build.

## Release path, gates and design

Not decided here; each needs the owner.

- **Release.** Today an APK is built locally and sideloaded, signed with the key of whoever builds it (`apps/android/scripts/build-apk.sh` keeps that key outside the repository). A published build needs one signing key held by the owner and a place to publish it: GitHub releases beside the desktop installers, or Google Play.
- **Gates.** CI runs no Android job. The cheapest gate is a Linux job running `./gradlew :app:testDebugUnitTest :app:assembleDebug` in `apps/android`.
- **Design.** The palette, type and layout follow the iPhone client. There are no design captures for Android yet.

## Consequences

- Two phone clients to keep in step. A protocol addition, a copy change or a new rule in the iPhone client has an Android counterpart, and the reverse.
- An Android owner can reach their computers' threads from a phone without a Mac.
- The protocol stays the only shared contract between clients: no shared code between `apps/ios` and `apps/android`.

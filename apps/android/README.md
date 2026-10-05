# Sotto for Android

A native Android client for Sotto on your computers, over a private Tailscale connection. It is a port of the iPhone client in `apps/ios`: the same three tabs (Threads, Computers, Settings), the same two-step pairing, the same rules about what a paired phone may do, and the same copy, with "iPhone" read as "phone". It speaks host protocol version 1 (`docs/host-protocol.md`) and nothing else from the desktop.

This directory is independent of the Electron/npm package and of `apps/ios`. It is a Gradle project in Kotlin with Jetpack Compose. Its only libraries beyond AndroidX and Kotlin's own are OkHttp (Android has no built-in WebSocket client) and kotlinx.serialization.

## What it does

Pair with a computer by its machine name on the tailnet and the eight-character code from Settings › Phones there. Threads puts questions and permissions first, working threads next, then recent threads, across every paired computer. A thread shows its messages or its activity, takes replies and stops a working turn. A waiting question or permission opens as a sheet, and it can be answered only after that computer turns on Can answer for this phone. New thread (+) chooses a computer, a project or a folder on it, then a model, effort and permission mode.

## Where things are

- `app/src/main/kotlin/com/millzach/sotto/core/`: the protocol core, ported from `apps/ios/Sources/SottoCore`. It is pure Kotlin with no Android imports.
- `net/HostConnection.kt`: health, pairing, sessions and the socket.
- `app/AppModel.kt`: every computer, its connection, reconnects and the unconfirmed-action markers. It is a port of `apps/ios/Sotto/AppModel.swift`.
- `store/SecureStore.kt`: saved computers and markers, each encrypted with an Android Keystore key that never leaves the device. Backup and device transfer are off.
- `ui/`: the Compose screens.
- `app/src/test/`: JUnit ports of the iPhone core tests.

## How it differs from the iPhone client

- Hello does not list `client-liveness`. OkHttp answers the host's pings and sends its own every 25 seconds, so the host keeps its pings for this client, as it does for every client that did not opt in.
- The computer lists this phone by its model name (`Build.MODEL`, such as "Pixel 8") where the iPhone sends "iPhone".
- The recent-apps view shows no thread content (`setRecentsScreenshotEnabled(false)`). This is the Android counterpart of the iPhone obscuring its window while inactive.
- Delivery checks reset the reconnect backoff after a successful connect, not after a liveness round.

## Build and test

You need the Android SDK (compileSdk 37) and JDK 17 or newer. From this directory:

```sh
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
./scripts/build-apk.sh
```

The second command builds a debug APK (`com.millzach.sotto.android.debug`). The third builds the signed release APK. Its signing key is kept outside the repository, in `~/.config/sotto-android/` by default (`SOTTO_ANDROID_KEY_DIR` overrides it). Every later build must use the same key, or Android refuses to install it over the copy already on a phone.

## Install

Install Tailscale on the phone and connect it to the same tailnet, with MagicDNS on. Install the APK by sideloading it. On a computer running the desktop app, turn on phone access in Settings › Phones. Sotto then runs Tailscale Serve on HTTPS port 8443. Like the iPhone, the app accepts only certificate-validated `https://*.ts.net` origins on port 443 or 8443.

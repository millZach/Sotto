# The iPhone app reaches TestFlight from GitHub Actions

Accepted September 26, 2026, by the owner's choice. The owner develops on Windows and has no Mac, but has an Apple Developer Program membership and wants the iPhone app (#225) on their phone. An iPhone build has to be archived and signed by Xcode, which runs only on macOS. TestFlight was already the planned delivery path (ADR-0025, `docs/plans/ios-client.md`). This decides where the Mac work happens. It amends `docs/ci.md`, whose CI "never publishes and uses no secrets": that stays true of every workflow but this one.

## October 8 amendment: only the export signs

The archive step signed the app with an Apple Development certificate. A fresh runner holds none, so Xcode made a new one on every run, and on October 8 the account reached Apple's limit and the next archive was refused ("Your account has reached the maximum number of certificates"). `testflight.sh` now archives with signing turned off, and the export signs the build with the team's cloud-managed distribution certificate, which is made once and reused. The app has no entitlements, so an unsigned archive loses nothing the export needs. The development certificates the earlier runs made can be revoked under Certificates, Identifiers & Profiles; nothing uses them.

## Considered options

**Rewrite the app with Expo.** Expo Go shows a React Native app on the phone within minutes without signing, but it throws away the SwiftUI client that compiles and passes its tests, reverses ADR-0025's choice of SwiftUI, and an installed build still needs EAS, which uploads the source to Expo's build servers. Rejected by the owner.

**Rent a Mac or build on a borrowed one.** Works, but puts signing material on a machine the project doesn't control and makes every build a manual session.

**A GitHub Actions job on a macOS runner uploads to TestFlight.** Chosen.

## Decision

- `.github/workflows/ios-testflight.yml` runs only when a tag named `ios-testflight-*` is pushed, or by hand. It never runs for a pull request, so a fork cannot reach it.
- It runs the SottoCore tests, then `apps/ios/Scripts/testflight.sh` archives the app, signs it and uploads it to App Store Connect with `xcodebuild` alone: no fastlane, no third-party action, nothing added to npm.
- Signing is Xcode's automatic signing with Apple's cloud-managed certificates, authorised by an App Store Connect API key with the Admin role. No certificate, profile or private signing key is stored in the repository, in secrets or on the runner after the job.
- The key, its key ID, the issuer ID and the team ID are secrets of the `testflight` GitHub environment, which only this job names. The key is written to the runner's temporary folder with owner-only permissions for the job and removed after it, whether the job passed or not. Nothing prints it.
- It builds with Xcode 26.6 on a `macos-26` runner, because App Store Connect refuses a build made with an SDK older than iOS 26 (the first upload, from Xcode 16.4, was refused for that). The pull-request gate uses the same Xcode, so what passes review is what uploads. The app still runs on iOS 17 and later.
- The build number is the workflow's run number, so every upload is newer than the last. The marketing version stays in the Xcode project.
- The job contacts Apple (App Store Connect) and GitHub, nothing else. The app itself contacts nothing new: it still talks only to the user's own host over Tailscale.
- Who can install is decided in App Store Connect: the owner adds testers to an internal TestFlight group. External testing, which needs Apple's review, and the App Store are separate decisions.

## Consequences

The owner can put a new build on their phone from Windows by pushing a tag, about half an hour later, without owning a Mac. The macOS gate in `ci.yml` still compiles every pull request unsigned; this workflow is the only one that signs. Anyone with push access can publish a TestFlight build, which is acceptable while the repository has one maintainer and should be revisited, with required reviewers on the environment, when it has more. An API key with the Admin role can do more than upload; it can be revoked in App Store Connect at any time, and should be if the repository's secrets are ever in doubt.

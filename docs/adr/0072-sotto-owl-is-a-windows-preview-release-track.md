# Sotto Owl is a Windows preview release track

Accepted by Zach on October 9, 2026. Amended October 10, 2026 for the now-superseded promotion rule and the night sky, October 12 for the feature list, and October 13 for stable releases from main (below). **Number provisional until merge:** 0072 is free on `origin/main` at `1d6295c7a`, where 0071 is local transcription, and the open #906 claims 0070; Watcher's decision moved to 0073 for the same reason. Recheck and renumber all references before merging (docs/agents/domain.md).

Zach chose [T3 Code's nightly model](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md) to run Watcher before it reaches main. **Sotto Owl** is the preview release track and its builds. **Watcher** is the coordinating thread, a separate thing. Owl replaces Sotto on a machine: app ID, product name, executable, installer identity, shortcuts and data directory stay Sotto's. Of the release artifacts, only the installer filename and release title say Sotto Owl. The running build says it from the version-derived track: its window title, tray tooltip and version lines read "Sotto Owl", and the sidebar's top row and the strip show the Sotto mark alone as a 24-pixel tile where stable shows the mark beside "Sotto" (Zach's choice, from the approved mock-up). Sentences in which Sotto is the app or the speaker, and the window controls' names, keep "Sotto".

An Owl version is `<next stable patch>-owl.<UTC YYYYMMDD>.<positive daily number>`. Package version `0.1.36` produces `0.1.37-owl.20261011.1`. The release lead chooses the day's next number. `package:owl` overrides packaged metadata without changing either source package manifest. Builds come from `main` (see October 13 below).

Windows Owl releases are GitHub prereleases on the existing public `millZach/Sotto-releases` repository, never marked latest, with `owl.yml` and NSIS blockmaps. The installed electron-updater GitHub provider selects the `owl` prerelease identifier from Atom tags, ignoring stable tags even when GitHub marks old stable releases as prereleases. A validating provider requires an Owl manifest version matching that tag before an offer can become downloadable, including the upstream provider's `latest.yml` fallback within the selected Owl release. Setting a channel enables downgrades upstream, so Owl explicitly disables them. The normal semantic-version gate admits only a strictly newer build. Stable keeps its existing `allowPrerelease = false`, GitHub latest release and `latest.yml` behavior. Owl is never made GitHub's latest release and receives no stable manifest for publication.

Both tracks keep automatic download and installation on quit disabled. Existing consent, check cadence and privacy settings stay in force. No new host, permission grant, IPC channel or production dependency is added. `UpdateStatus.releaseTrack` and `useReleaseTrack()` expose the track through existing update information, including when updates are unsupported.

This track is Windows only. macOS still has no updater (ADR-0001); a later Owl Mac build would be cut by hand on Zach's Mac. Linux is out of scope. Stable package commands, output names and platform targets are unchanged.

Installing a stable installer switches back to its stable feed. Before Watcher reached `main`, stable dropped Watcher's records when it saved the shared profile; [the verification note](../verification/2026-10-09-sotto-owl.md) records those load and save paths. With Watcher's code on `main` behind the gate below, stable reads and keeps those records, so the profile moves between the two tracks without losing them.

## October 10, 2026: every change reaches Owl before Sotto

**Superseded in part by “October 13, 2026: the switch is the rule” below.** The stable-source promotion requirement, Mac source rule and subsequent-stable-release statement are historical. The daily Windows Owl track and Watcher gate remain in force.

Zach chose to make Owl the stage every change passes through, the way T3 Code's stable releases promote a nightly its users already ran:

- **Stable ships only a commit a published Owl build already carried.** A stable release is promoted from the latest Owl build Zach has run: it builds that Owl build's source commit, with the stable version set at packaging the way `package:owl` sets the Owl version, never whatever is newest on `main`. The `Release X.Y.Z` pull request then records the version on `main`. `npm run release:check` refuses a stable build whose source no published Owl build carried; an Owl build names its source commit in its release.
- **Owl is built from `main` once a day** when anything has merged since the last Owl build, not after every merge, so Owl does not ask to restart all day. The version rule above is unchanged; the base is the next patch of `main`'s package version.
- **Watcher is on `main` behind a gate.** Zach merged Watcher into `main` before it is finished, so Owl can build from `main`. Watcher is on only in Owl builds: anything that is Watcher's asks the gate before it exists, `useWatcherEnabled()` in the renderer and the release track read once at start in main, the way memory is gated (ADR-0013). With the gate off, stable shows nothing of Watcher, starts none of it, and keeps its saved records whole. This includes dormant Watcher history when stable has Keep local history off; stable still clears ordinary history. Owl applies ADR-0073's history setting as before. This gate exception follows the requirement to preserve every Watcher record in main when a profile moves between tracks. Zach's October 10 scope decision excludes renderer view state: pane layout, focused pane and selection treat a hidden Watcher like a missing thread, with no preservation or restoration of hidden panes. Promoting Watcher to stable is a later decision that turns the gate on for both tracks.
- **macOS has no Owl build yet.** Zach agreed that the Mac stable build ships the same promoted commit without an Owl stage of its own, until a Mac Owl build is cut by hand.

Stable 0.1.35 and 0.1.36 shipped from `main` on October 10 before the promotion check was implemented. The latter ships source commit `f3e5e2041` (`Release 0.1.36`); subsequent stable releases follow this rule.

October 10, 2026: Zach picked a night sky for an Owl build's sidebar header from [the header stars prototype](C:/Users/zache/AppData/Local/zstack-scratch/owl-stars/index.html), its third variant, the night tint with the slow twinkle; the prototype stays outside the repository. Behind the top row and the search field lies a faint band in the theme's own night hue (Sotto's blue where a theme has none), with the accent glowing behind the tile and eleven tiny stars, four of which slowly dim and come back by night (three by day, when the faintest are dropped) unless motion is reduced. By day the stars take the accent and the band is a faint wash of it. Stable's header is unchanged. [The verification note](../verification/2026-10-10-sotto-owl-night-sky.md) records how it was checked.

## October 12, 2026: one list keeps a feature in Owl until Zach sends it to stable

Zach asked to call something an Owl feature to turn its switch on, then say it can go to stable when he is confident in it. `src/shared/owlFeatures.ts` is the one list: each entry names the feature, its ID, the date it became an Owl feature, its owning ADR or plan, and whether Zach has sent it to stable. Watcher is the first, dated October 10 and not yet sent to stable. The list's rule turns every entry on in Owl and only sent entries on in stable. Every part of a feature asks the list before it exists; stable shows and starts none of a held feature and keeps its saved records whole. Watcher's renderer view-state exception above is unchanged.

Main reads all answers once at startup from the running version and passes them to their owners. Existing update status carries the map to `useOwlFeature(id)` in the renderer. Watcher's existing hook, startup function, options and status field remain compatibility wrappers around the list for branches in flight. No new bridge, host or production dependency is introduced.

Unpackaged development, e2e and design runs may use comma-separated `SOTTO_OWL_FEATURES` entries, such as `watcher=1` or `watcher=0`. Unknown IDs and values other than 0 or 1 are ignored; the last valid entry wins. `SOTTO_WATCHER_ENABLED` remains an alias, with explicit list entries taking precedence. Packaged builds ignore both.

Stable release packaging on Windows and Mac, and Owl packaging on Windows, launch the packaged app on an owned throwaway profile with all feature overrides set to 1. `scripts/verify-owl-features-package.mjs` reads the real startup answers and fails stable packaging if a held feature is on or a sent feature is off, and Owl packaging if any listed feature is off. The profile is removed after the check. Directory packaging, Linux packaging and CI's Package (Windows) are unchanged.

**The following Owl-first timing clause is superseded by the October 13 switch rule below.** Sending a feature to stable changes only its entry's `sentToStable: false` to `sentToStable: true`. The change passes through Owl before the next stable promotion. Once stable has carried the feature, its code's switches can be removed in a later change; keep the sent entry as the record of the decision.

October 12, 2026: Zach chose Usage (ADR-0078) for every connected computer in its first Owl version. This extends the preview distribution to plain Node **host archives** built from the desktop Owl's exact source and full version, attached to the same prerelease. Each host gates its own features from its packaged version; a client cannot activate a stable collector. Desktop preview builds and their updater remain Windows only. macOS and Linux can run matching Owl headless hosts without gaining an Owl desktop release or updater.

## October 13, 2026: Linux stable uses the promoted source too

**Superseded in part by “October 13, 2026: the switch is the rule” below.** The Owl source, version and promotion requirements are historical. Linux artifact checks, nested Hyprland isolation and the non-publishable rehearsal remain in force.

Linux still has no Owl desktop build. `package:linux:stable` checks the newest published Windows Owl’s exact source and packages its stable base version, as Windows and Mac do. It checks the tarball and the real stable Owl feature answers in an isolated nested Hyprland session. The unchecked `package:linux` stays available for offline verification.

`release-linux.mjs` finishes the pacman package, recipe, `.SRCINFO` and checksum lines without installation or publication. The generated recipe and `.SRCINFO` are recorded in the later Release PR after publication. An explicit rehearsal version runs the same checks from any clean commit while skipping promotion; its artifacts are marked not publishable and cannot be consumed by the stable finishing command.

## October 13, 2026: the switch is the rule

Zach corrected the release rule: “there is a switch for Owl, so Owl features sit behind a switch other features go straight to stable.” This supersedes the October 10 stable promotion rule, its Mac source requirement, the October 12 Owl-first sending clause and the October 13 Linux promotion note. Their history remains above.

Owl features in `src/shared/owlFeatures.ts` are on in Owl and off in stable until Zach sends them by setting `sentToStable: true`. Every part still asks the list before it exists. Stable keeps held features' saved records whole. Everything else goes straight to stable.

Stable is cut from a clean commit on `origin/main` whose required Gates (Windows) and Package result CI checks succeeded for that exact commit. `release:check` refreshes main, reads the public GitHub check-runs and release APIs without credentials, and records the source, checks and version in the ignored release file. The default version is the next patch of the source `package.json`; an explicit plain stable version is allowed. Either must exceed every published plain stable version, including superseded stable releases now marked prerelease. Packaging rechecks the clean source, main membership and saved evidence, overrides only packaged metadata and guards both source manifests.

Windows, Apple silicon Mac, Linux desktop and release host archives use that checked source and stable version. Stable desktop packaging still launches the real packaged app and verifies held Owl features off and sent features on. Linux's rehearsal skips stable eligibility and is clearly marked not publishable; stable finishing refuses it.

Owl stays a Windows preview track built from main once a day when it has changed, with Owl features on and the next-patch version rule unchanged. A published Owl build is no prerequisite for stable on any platform.

## October 19, 2026: Owl ships for Apple silicon Macs too

Zach asked for every Owl release to ship for Mac users. [ADR-0093](0093-sotto-owl-also-ships-for-apple-silicon-macs.md) records the decision and supersedes this ADR's "This track is Windows only" paragraph, the October 12 sentence that desktop preview builds and their updater remain Windows only, and the October 13 sentence that Owl stays a Windows preview track; the rest of that sentence, its daily build from main and its version rule, stands. Each Owl's Apple silicon build is made by GitHub Actions from the Windows Owl's exact source commit and version and attached to the same prerelease. It is ad-hoc signed and has no updater until Developer ID signing, notarization and an `owl-mac.yml` feed land; then Mac Owl updates in the app as Windows does. Linux still has no Owl desktop build, and stable on every platform is unchanged. The file keeps its name so links to it stay whole.

## October 21, 2026: Owl ships for Linux too

Zach asked for each Owl to ship for Linux. [ADR-0099](0099-sotto-owl-also-ships-for-linux.md) records the decision and supersedes the October 13 sentence that Linux has no Owl desktop build and the October 19 sentence that Linux still has none. Each Owl's x64 tarball and `sotto-bin` pacman package are made by GitHub Actions from the Windows Owl's exact source commit and version and attached to the same prerelease. Owl and stable replace each other on Linux as elsewhere. Linux has no updater, so each Owl is installed by hand with `sudo pacman -U`.

## October 23, 2026: every Owl feature goes to stable

Zach sent every Owl feature to stable: "for everything that is currently on OWL only I want to push that all to stable. It's awesome and ready." All nineteen entries in `src/shared/owlFeatures.ts`, Watcher through desktop notifications, now say `sentToStable: true`, and Stable 0.1.40 is the first stable release to carry them. Nothing else in the rule changes: the switches stay in the code until a later change removes them, the entries stay as the record, and the next feature Zach calls an Owl feature is held again with `sentToStable: false`. The cross-machine orchestration work in flight (epic #1023) is not among the nineteen; Zach has said it will be an Owl feature when it lands.

Stable desktops from 0.1.40 run Usage, so, like an Owl desktop, they ask a paired host for exactly their own version. A stable release therefore attaches a host archive for every platform its hosts run on, or a host on a platform without one is told there is none. Stable 0.1.39 and earlier still hide these features and keep their saved records, as above.

## November 1, 2026: a nightly Owl, cut in GitHub Actions

Zach asked: "I would like to start a schedule that a new owl build is cut every night at midnight." His picks: midnight **UTC**; every platform built and published in GitHub Actions, so the night needs no computer of his switched on; **no Owl** when `main` has not changed since the newest Owl's source commit, or when `main`'s required checks on that commit (Gates (Windows), Package result and Desktop result) have not all succeeded; and an **automated launch check** of each built app, which must pass before anything is published.

The **Sotto Owl nightly** workflow (`.github/workflows/owl-nightly.yml`) runs at `0 0 * * *` and when started by hand, one run at a time. It builds the Windows Owl on a hosted Windows runner with the hand cut's own pinned command, calls the Mac and Linux workflows with the same version and source, and builds the Linux host archive on a hosted runner instead of forge. Each downloaded installer is then installed or opened on a runner that did not build it, and must open its window reporting that version on the Owl track: the Windows installer installed silently, Sotto.app copied out of the disk image and passed by Gatekeeper, the Linux tarball extracted under a virtual display. `release:owl`'s checks then run unchanged against a clean checkout of the source, every release file is attested, and only then is the prerelease published, never Latest, with the checksums last. Afterwards it checks saysotto.com links the new Owl and deploys the site once more if not (#1894). `docs/release/releasing.md` has the detail.

This changes three things above. The October 10 rule that Owl is built from `main` once a day when anything has merged now runs on a clock, and adds the required-checks condition, which a hand cut follows too. The day's number is one past the highest Owl tag of that UTC day, whatever its base, so a nightly after a hand cut on the same day takes the next number. And ADR-0093 and ADR-0099's "started by hand" Mac and Linux workflows are also called by the nightly; their builds are unchanged.

What stays: the version rule, the hand cut on the Windows PC with `release:owl`, the unsigned Windows installer (Windows code signing is its own decision, waiting on its certificate), the signed and notarized Mac build in the `owl-mac` environment, and every check a hand cut makes. The app contacts no new host and nothing reaches a user's computer that a hand cut would not have published.

One credential is new: `SOTTO_RELEASES_TOKEN`, a fine-grained token for `millZach/Sotto-releases` alone, allowed to write releases and start that repository's workflows. It lives in an `owl-release` environment that admits only `main`, and only the publishing and site jobs read it. It is the first credential that publishes a desktop release with no one at a keyboard, so what guards a night is the skip rules, the launch checks and `release:owl`'s checks, all of which must pass. A dry run, the default when started by hand, builds and checks everything and publishes nothing.

### Consequences

- An Owl can reach Owl users every night without a person reviewing it first. Their updates still ask before download and restart, as before.
- A commit whose CI finishes after midnight waits a night. A night with nothing merged costs one short job.
- The macOS runner queue can delay a night. A failed night publishes nothing and is re-run from the run's page with the same version.
- Each night that builds costs three hosted Windows runs, two Mac runs and about ten Linux runs, most of them short, free while the source repository is public.


# Cutting a release

Releases are cut by hand on two machines and published to the public `millZach/Sotto-releases` repository, not to the private source repository. First-time macOS setup is `macos-bringup.md`; the rationale for the unsigned Apple silicon build is ADR-0001. ADR-0001's "no auto-updater on any platform" is superseded on Windows by the in-app updater (#103); macOS still has none.

## Steps

Before cutting the Windows release, run `npm ci` and `npm run test:desktop-smoke` on the release checkout in an interactive Windows desktop. Record the commit and passing result in the release evidence before packaging or publishing. The check builds that checkout once and runs isolated fake-provider recovery, Settings and daily-workspace journeys, including a real temporary shell, Git repository and local-only push. It makes no paid provider call and does not publish a release or regenerate design baselines. Run it without another Electron journey using the desktop; see [the desktop check](../ci.md#manual-windows-desktop-check) for scope and failure handling. Normal CI gates must also pass.

The first desktop release whose Add host turns on a host's tailnet connections (ADR-0053, October 6 amendment) waits for the iPhone build that reads a host's 403 `forbidden` as a reason to keep trying. Check that build is on TestFlight before step 4, or publish both together. An older iPhone paired with that host reads the refusal as unpaired while the host's phone access is off.

1. Bump the version: `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json` together, then update the two `package:*` installer paths in `package.json` that carry the version. Commit on `main` as `Release X.Y.Z` with a body that says what the release is. The source repository carries no tag.
2. On each machine, move that machine's previous installers, disk images and blockmaps from `release/` into `release/archive/`, so `release/` holds only the current version.
3. Build: `npm run package:win` on the Windows PC, `npm run package:mac` on the Mac. Each run verifies the Claude SDK and terminal assets, writes build provenance and checks the packaged resources. The check refuses retired voice workers and ONNX runtime assets.
4. Create release `vX.Y.Z` titled `Sotto X.Y.Z (beta)` on `millZach/Sotto-releases` and attach every installer and disk image.
5. Assemble `SHA256SUMS.txt` and upload it last, after every artifact is attached.
6. Mark the superseded release as a pre-release so the newest release is the only "Latest".

## Artifacts

Each machine produces only its own platform's artifacts:

- Windows PC: `Sotto Setup X.Y.Z.exe`, the dashed `Sotto-Setup-X.Y.Z.exe` copies for GitHub upload, blockmaps, `latest.yml`.
- Apple silicon Mac: `Sotto-X.Y.Z-arm64.dmg` and its blockmap. There is no `latest-mac.yml`: the mac build has a dmg target only, no zip target, and no auto-updater.

The local `release/` folder (gitignored) holds only the CURRENT version's artifacts for the machine it was built on.

`SHA256SUMS.txt` spans both platforms: each machine appends its own hashes as `<hash>  <filename>` (two spaces, lower-case hex), and the assembled file is uploaded LAST, after every installer and disk image is attached. On the Mac that is `shasum -a 256 <file>`; on the Windows PC:

```powershell
Get-ChildItem release\Sotto-Setup-*.exe, release\*.blockmap, release\latest.yml |
  ForEach-Object { (Get-FileHash -Algorithm SHA256 $_).Hash.ToLower() + '  ' + $_.Name }
```

## Release notes

macOS builds are ad-hoc signed (`identity: '-'`) and not notarized, so the release notes must carry the Gatekeeper instructions from the README (Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Sotto.app`) plus "Apple silicon only".

## Where the feeds point

electron-builder's publish config and the Windows auto-update feed point at `millZach/Sotto-releases`. Windows installs are offered the new version by the in-app updater; macOS users download the disk image by hand.

## Linux host archive

The host is a Node process, not a Linux desktop app. Build on Linux with Node 24 and a clean `npm ci`, then run `npm run test:socket` and `npm run package:host`. The CI job **Host archive and socket contract (Linux)** does the same work and retains its archive for review. CI never publishes a release.

`package:host` builds only the headless entry. It produces `release/Sotto-host-X.Y.Z-linux-x64.tar.gz` and a matching `.tar.gz.sha256` sidecar on the x64 Linux runner. Local builds carry their actual platform and architecture in the filename; a Windows smoke build is not a Linux release. There is no cross-platform native-module copy or Electron packaging step.

`build-host.mjs` and `package-host.mjs` use the checkout's `out/host` folder by default; `package-host.mjs` writes archives into the checkout's `release` folder. Set `SOTTO_HOST_OUT_DIR` and `SOTTO_HOST_RELEASE_DIR` to use other output folders, as the packaging regression test does. Relative overrides resolve from the checkout, regardless of the command's working folder. The test builds once through packaging and removes its temporary build and archive folders afterward.

The archive extracts directly into an installation directory:

```text
host/index.js
host/external-dependencies.json
host/bundled-dependencies.json
node_modules/zod/
package.json
runtime-manifest.json
build-provenance.json
LICENSE.md
THIRD_PARTY_NOTICES.md
```

The manifest requires Node `>=24 <25`; Node itself and provider CLIs are not included. Install Node 24 and the desired provider CLI on the host and sign in there. The reviewed runtime closure is Node built-ins and zod, with no bundled dependencies or native modules. Packaging refuses a new external, an unexpected transitive dependency, or a native binary. The existing notices check covers the host inventory. Provenance records the source commit, dirty-tree status, build-input digest, Node/build platform, and every packaged file's size and digest. Only a reviewed clean-commit build is eligible for publication.

The packaging command verifies the staged directory, extracts the resulting archive into a fresh temporary directory, verifies all hashes again, starts its `host/index.js` outside the checkout with every provider turned off, so no client installed on the machine starts, checks the loopback listener's identity, and verifies that shutdown saved the workspace. Linux delivers a real SIGTERM. A Windows development smoke substitutes that signal through a test-only IPC handler; it is not evidence of Linux execution.

After reviewing the green Linux job and its matching provenance, attach the Linux archive and its `.sha256` sidecar beside the desktop installers on `millZach/Sotto-releases`; a host update downloads and checks both. Add its sidecar line to the combined `SHA256SUMS.txt` before uploading that file last. Do not publish a Windows smoke archive as Linux. Publishing is still a separate manual release action.

A host that runs an older release is updated from the desktop's Threads page (ADR-0040): the host downloads `Sotto-host-X.Y.Z-<platform>-<arch>.tar.gz` and its `.sha256` sidecar from `https://github.com/millZach/Sotto-releases/releases/download/vX.Y.Z/`, so both must be attached to the release under exactly those names, and a platform without an archive is told there is none. The update unpacks the archive into the installation folder's `versions/X.Y.Z/` and writes the version into the folder's `current` file, which is what the launch script starts.

To do the same by hand on Forge, verify the release checksum, extract into a version folder, point `current` at it, and restart the host (Stop host in Settings > Hosts, then switch it on):

```sh
cd "$HOME/.local/share/sotto-host"
sha256sum -c Sotto-host-X.Y.Z-linux-x64.tar.gz.sha256
mkdir -p versions/X.Y.Z
tar -xzf Sotto-host-X.Y.Z-linux-x64.tar.gz -C versions/X.Y.Z
printf 'X.Y.Z\n' > current
```

A folder without `current` holds one flat install, extracted into the folder itself, and the launch script starts its `host/index.js` as before. To run a version by hand instead, start it from its folder:

```sh
cd "$HOME/.local/share/sotto-host/versions/X.Y.Z"
node host/index.js --data "$HOME/.sotto"
```

No `npm install` is needed in the extracted archive. Keep the data directory outside the versioned installation. A new empty host can start without a credential key; saving hosted-provider credentials requires a separately stored key file passed with `--key-file` or `SOTTO_HOST_KEY_FILE`. Never copy the desktop credential store to Forge. The listener binds loopback only. Point the desktop's SSH host settings at the installation folder (`~/.local/share/sotto-host`, not a version folder inside it), then pair explicitly. Installing an archive grants no permission authority.

The scripts and CI job do not establish that an archive has been published or that Forge has been tested. Record the release URL, Linux CI run, and actual Forge SSH connection evidence when those acceptance checks are completed.

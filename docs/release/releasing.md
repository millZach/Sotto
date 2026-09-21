# Cutting a release

Releases are cut by hand on two machines and published to the public `millZach/Sotto-releases` repository, not to the private source repository. First-time macOS setup is `macos-bringup.md`; the rationale for the unsigned Apple silicon build is ADR-0001. ADR-0001's "no auto-updater on any platform" is superseded on Windows by the in-app updater (#103); macOS still has none.

## Steps

1. Bump the version: `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json` together, then update the two `package:*` installer paths in `package.json` that carry the version. Commit on `main` as `Release X.Y.Z` with a body that says what the release is. The source repository carries no tag.
2. On each machine, move that machine's previous installers, disk images and blockmaps from `release/` into `release/archive/`, so `release/` holds only the current version.
3. Build: `npm run package:win` on the Windows PC, `npm run package:mac` on the Mac. Each run verifies the runtime, writes build provenance and checks the packaged resources. The ONNX runtime ships only under `resources/runtime`; the check rejects a copy inside `app.asar`.
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

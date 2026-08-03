# Sotto

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (millZach/Sotto) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Release artifacts

A release is built on two machines and each one produces only its own platform's artifacts:

- Windows PC — `Sotto Setup X.Y.Z.exe`, the dashed `Sotto-Setup-X.Y.Z.exe` copies for GitHub upload, blockmaps, `latest.yml`.
- Apple silicon Mac — `Sotto-X.Y.Z-arm64.dmg` and its blockmap. There is no `latest-mac.yml`: the mac build has a dmg target only, no zip target, and no auto-updater.

The local `release/` folder (gitignored) holds only the CURRENT version's artifacts for the machine it was built on. When cutting a new release, move that machine's previous installers/disk images/blockmaps into its `release/archive/` so `release/` always reflects the newest version.

`SHA256SUMS.txt` spans both platforms: each machine appends its own hashes in the two-space `shasum -a 256` format, and the assembled file is uploaded LAST, after every installer and disk image is attached to the GitHub release.

macOS builds are ad-hoc signed (`identity: '-'`) and not notarized, so the release notes must carry the Gatekeeper instructions from the README (Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Sotto.app`) plus "Apple silicon only". See `docs/adr/0001-macos-unsigned-arm64-distribution.md`.

On GitHub (millZach/Sotto), superseded releases are marked as pre-releases so the newest release is the only "Latest".

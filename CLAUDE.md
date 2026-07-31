# Sotto

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (millZach/Sotto) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Release artifacts

The local `release/` folder (gitignored) holds only the CURRENT version's installer artifacts (`Sotto Setup X.Y.Z.exe`, the dashed `Sotto-Setup-X.Y.Z.exe` copies for GitHub upload, blockmaps, `latest.yml`, `SHA256SUMS.txt`). When cutting a new release, move the previous version's installers/blockmaps into `release/archive/` so `release/` always reflects the newest version. On GitHub (millZach/Sotto), superseded releases are marked as pre-releases so the newest release is the only "Latest".

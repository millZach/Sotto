# Sotto

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (millZach/Sotto) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Subagent model routing

Pick the subagent by the kind of work, not by convenience. Non-Claude models run through their CLIs from Bash.

| Work | Model | How to run |
|---|---|---|
| Backend code, or any task where the subagent must reason (debugging, architecture, tricky refactors) | gpt-6-astra, reasoning `high` | `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-6-astra -c model_reasoning_effort=high --skip-git-repo-check - < prompt.txt` |
| Deep research (validating specs, comparing architectures or libraries, reading papers, anything where the answer needs judgment) | gpt-6-astra, reasoning `xhigh` | Same command with `model_reasoning_effort=xhigh`. Research runs read-only unless it needs to write a findings file under `docs/research/`. |
| Simple research (look up one API's shape or pricing, confirm a flag or file path, find where something lives in the repo, check a version) | grok-4.6, reasoning `xhigh` | `grok -p "<prompt>" --model grok-4.6 --reasoning-effort xhigh --always-approve --cwd "<repo>"`. Grok has web search on by default. |
| Design work (mockups, UI, copy, visual review) | Claude Fable 5.1 only | `Agent` tool with `model: "fable"`. Never send design work to Codex or Grok. |
| Easier implementations that need little reasoning (mechanical edits, scripts, test scaffolding, wiring that follows an existing pattern) | grok-4.6, reasoning `xhigh` | `grok -p "<prompt>" --model grok-4.6 --reasoning-effort xhigh --always-approve --cwd "<repo>"` |

Run Codex from the repo root through Bash, with the prompt in a file and `-` for stdin, and run it in the background with output to a log because a research run takes many minutes. Do not use the `codex:codex-rescue` agent or the codex-companion helper on this Windows machine: its sandbox fails to start PowerShell and Node (`helper_unknown_error: apply deny-read ACLs`), so the job returns without reading the repo. Codex (`~/.codex/config.toml`) already defaults to gpt-6-astra at xhigh, so pass `high` explicitly for backend work. Grok (`~/.grok/config.toml`) defaults to grok-4.6 at xhigh.

Give every delegated task the repo path, the files involved, and the definition of done. Read the result before acting on it; Codex and Grok output is not shown to the user.

## Release artifacts

A release is built on two machines and each one produces only its own platform's artifacts:

- Windows PC — `Sotto Setup X.Y.Z.exe`, the dashed `Sotto-Setup-X.Y.Z.exe` copies for GitHub upload, blockmaps, `latest.yml`.
- Apple silicon Mac — `Sotto-X.Y.Z-arm64.dmg` and its blockmap. There is no `latest-mac.yml`: the mac build has a dmg target only, no zip target, and no auto-updater.

The local `release/` folder (gitignored) holds only the CURRENT version's artifacts for the machine it was built on. When cutting a new release, move that machine's previous installers/disk images/blockmaps into its `release/archive/` so `release/` always reflects the newest version.

`SHA256SUMS.txt` spans both platforms: each machine appends its own hashes in the two-space `shasum -a 256` format, and the assembled file is uploaded LAST, after every installer and disk image is attached to the GitHub release.

macOS builds are ad-hoc signed (`identity: '-'`) and not notarized, so the release notes must carry the Gatekeeper instructions from the README (Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Sotto.app`) plus "Apple silicon only". See `docs/adr/0001-macos-unsigned-arm64-distribution.md`.

Releases are published to the public `millZach/Sotto-releases` repository, not to the private source repository: electron-builder's publish config and the Windows auto-update feed point there, and the website's download links go there. Superseded releases are marked as pre-releases so the newest release is the only "Latest".

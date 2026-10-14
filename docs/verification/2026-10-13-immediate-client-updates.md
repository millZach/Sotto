# Explicit client updates install immediately

The owner chose that every explicit Update, Try again and Update all press skips mise's release-age delay on this computer and every connected host. Checks still install nothing. The shared updater sets `MISE_MINIMUM_RELEASE_AGE=0s` for the upgrade process and adds `--minimum-release-age 0s` only when the installed mise's local help lists it. The supported flag also overrides a per-tool delay. Details gives the equivalent command for Windows or POSIX shells. It does not write mise settings or change which manager owns a client. ADR-0042 records the decision; the throwaway behavior prototype is retained at [prototype/immediate-client-updates](https://github.com/millZach/Sotto/tree/prototype/immediate-client-updates/docs/prototypes/immediate-client-updates-prototype.html).

## Real forge

Verified on forge through SSH, using its installed mise 2026.9.10 and the release-age override now used by the shared updater:

```text
mise upgrade claude --dry-run
  Newer release 2.1.299 ignored by minimum_release_age (24h).
  Latest eligible release: 2.1.296. Eligible: October 14, 2026, 19:49 PDT.
  All tools are up to date.

mise upgrade claude --dry-run --minimum-release-age 0
  Would install claude@2.1.299

mise upgrade claude --minimum-release-age 0s
  Upgraded 1 tool: claude 2.1.296 → 2.1.299

The program in mise's claude/latest folder, run with --version:
  2.1.299 (Claude Code)
```

The first three lines summarize mise's warning. The actual install finished successfully; forge's Claude binary now reports 2.1.299. No Sotto host process was restarted. This verifies the installer command on the real host; it does not claim that forge's already running Sotto host has loaded the patched updater.

## Built Windows app and remote-host journey

`npm run build` passed, including its headless host build. `npx playwright test tests/e2e/host-client-updates.spec.ts` passed again after the compatibility correction (one journey, 23.8 seconds). It opens Settings → Hosts, adds the fixture forge through scripted SSH and the real headless host, updates Claude from its tile, then runs the host's Update all. Codex's scripted download fails; Grok still finishes both its upgrade and install step. Try again finishes Codex, and all three report their new versions. The fixture now models a newly published release: without the age override, mise returns success while leaving the old client installed, so this journey catches the original bug through the remote command path.

The journey captures light and dark at 1600×1000, 1280×800 and 820×560 with reduced motion on. It checks window overflow, the update popover's placement, keyboard focus and Escape. Refreshed and manually inspected the retained 1600×1000 dark and 820×560 light captures after the compatibility correction: the longer child-cmd command wraps within the existing Details field, Copy remains visible and installer paths stay redacted. The remaining captures are transient under `test-results/` and `artifacts/e2e-runs/`.

- [Dark, 1600×1000](../../artifacts/immediate-client-updates/details-dark-1600.png)
- [Light, 820×560](../../artifacts/immediate-client-updates/details-light-820.png)

## Regression checks

The new release-age regression failed first for Claude, Codex and Grok: the runner reported success but each installed version stayed old. All three passed after the shared command changed.

Eight focused unit and integration files passed (104 tests, one platform-specific skip). The Update all card then passed again with its added multi-host case (11 tests): one press queues the local Claude update plus Codex and Grok updates on two connected hosts. These are simulated hosts; the real macOS desktop and a second live host were not exercised.

Typecheck, lint and third-party notice verification passed. Before the compatibility review fix, `npm test -- --maxWorkers=2` passed on Windows: 10,392 tests passed and 321 skipped (818 passing files, 68 skipped). Independent Standards and Spec reviews both found no issues. The installed desktop and forge's running Sotto host have not been replaced with this development build; both need a release carrying the patch for future presses to use it.


## Compatibility review fix

PR review found that mise 2026.5.11 rejects the release-age CLI flag. A new legacy regression failed before the correction and passed afterward. The update now applies an environment override to its child process, leaving the app environment unchanged, and reads local `mise upgrade --help` before adding the flag. Fixtures inject that capability so their result does not depend on the development machine's mise.

Verified with the official mise 2026.5.11 Linux binary in owned scratch on forge, after checking the release archive against its published SHA-256: `upgrade --dry-run --minimum-release-age 0s` exits 2, while the environment override with plain `upgrade --dry-run` exits 0. Nothing was installed by this legacy probe. Forge's installed mise 2026.9.10 resolves Claude 2.1.296 normally and 2.1.299 with `MISE_MINIMUM_RELEASE_AGE=0s`. A separate scratch configuration with a per-tool seven-day delay showed why the supported flag stays: the environment override alone selects 2.1.292, while the supported flag selects 2.1.299. No saved mise policy was changed.

The Windows child-cmd form was also run with Node reading its environment: the child received `0s`, and the calling PowerShell's value remained unset. The POSIX real-child regression checks the default executor and help probe, the exact arguments and the override, and verifies the parent retains its seven-day value.

Compatibility validation: the four focused files passed on Windows (79 passed, two platform skips). Windows typecheck, lint, notice verification and the rebuilt desktop journey passed. A fresh validation worktree on forge, using Node 24.21.0 and the same source diff, passed all four required gate forms: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2` and `npm run notices:verify`. The full suite passed 10,515 tests and skipped 204 (825 passing files, 61 skipped), in 577.38 seconds. This includes the POSIX real-child regression. Both independent review axes were checked again and found no remaining issues. The refreshed desktop captures above show the corrected manual command.

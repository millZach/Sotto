# Explicit client updates install immediately

The owner chose that every explicit Update, Try again and Update all press skips mise's release-age delay on this computer and every connected host. Checks still install nothing. The shared updater passes `--minimum-release-age 0s` for that one command and gives the same command under Details. It does not write mise settings or change which manager owns a client. ADR-0042 records the decision; the throwaway behavior prototype is retained at [prototype/immediate-client-updates](https://github.com/millZach/Sotto/tree/prototype/immediate-client-updates/docs/prototypes/immediate-client-updates-prototype.html).

## Real forge

Verified on forge through SSH, using its installed mise 2026.9.10 and the same command the shared updater now runs:

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

`npm run build` passed, including its headless host build. `npx playwright test tests/e2e/host-client-updates.spec.ts --output=artifacts/e2e-runs/explicit-mise-updates/desktop` passed (one journey). It opens Settings → Hosts, adds the fixture forge through scripted SSH and the real headless host, updates Claude from its tile, then runs the host's Update all. Codex's scripted download fails; Grok still finishes both its upgrade and install step. Try again finishes Codex, and all three report their new versions. The fixture now models a newly published release: without the age override, mise returns success while leaving the old client installed, so this journey catches the original bug through the remote command path.

The journey captures light and dark at 1600×1000, 1280×800 and 820×560 with reduced motion on. It checks window overflow, the update popover's placement, keyboard focus and Escape. Manually inspected the retained 1600×1000 dark and 820×560 light captures: the longer command wraps within the existing Details field, Copy remains visible and installer paths stay redacted. The remaining captures are transient under `artifacts/e2e-runs/`.

- [Dark, 1600×1000](../../artifacts/immediate-client-updates/details-dark-1600.png)
- [Light, 820×560](../../artifacts/immediate-client-updates/details-light-820.png)

## Regression checks

The new release-age regression failed first for Claude, Codex and Grok: the runner reported success but each installed version stayed old. All three passed after the shared command changed.

Eight focused unit and integration files passed (104 tests, one platform-specific skip). The Update all card then passed again with its added multi-host case (11 tests): one press queues the local Claude update plus Codex and Grok updates on two connected hosts. These are simulated hosts; the real macOS desktop and a second live host were not exercised.

Typecheck, lint and third-party notice verification passed. The full repository test suite was not run. The installed desktop and forge's running Sotto host have not been replaced with this development build; both need a release carrying the patch for future presses to use it.

# Removing voice control and thread management

October 9, 2026 update: brought `feat/remove-voice-control` up to date with `origin/main` at `9d6eff099a46a9d1dbd1a8570e90f385719b50cb`. The merge keeps the owl, Linux desktop and dictation changes, Claude Code naming, nine-step first-run setup and the Threads tour while keeping voice control and per-thread management removed. The removal record is now ADR-0065. Only the OpenRouter wording changes in setup; there was no new voice step to remove. The rerun passes 8,620 unit tests (222 skipped), 19 requested e2e tests and 27 additional e2e tests; notices verifies 155 components and the manifest verifies 144 design tuples. Current results, all conflict resolutions and the pixel audit are in [the merge verification note](2026-10-09-voice-control-main-merge.md).

October 9, 2026, on Windows 11 with Electron 43, at `e7b410df9` on `command-center`, for [ADR-0065](../adr/0065-remove-voice-control-and-thread-management.md) and [the removal plan](../plans/2026-10-08-remove-voice-control.md). Runs used the built app and the repository's own suites; nothing was installed over the owner's copy of Sotto.

## Earlier removal evidence

- **The gates.** `npm run typecheck`, `npm run lint`, `npm run notices:verify` (155 components, down from 174) and `npm run build` pass. `npm test -- --maxWorkers=2` passes 8,292 tests and skips 185. Six fail, and each fails the same way on untouched `main` (`c53d2908c`) on this laptop: four submodule and nested-worktree reclaim cases in `tests/unit/main/threadWorktrees.test.ts` and the two slow-fetch and slow-GitHub-lookup cases in `tests/integration/workspaceSendGit.test.ts`. They time out on Git under load; a clean checkout of `main` reproduced them.
- **The surviving app, end to end.** The full Playwright suite on `c6f6f5a1d` passed 240 tests. Of its 27 failures, 21 also fail on untouched `main` on this laptop. The other six were the removal's: five stale specs and one real regression, a save acknowledgement that let an older state put back a prompt's earlier text. `095df4348` fixed it with a unit test, and a rerun of 28 spec files on drafts, the window policies, the widget, dictation and the Memory page passed 92 of 95; the three left (two provider-recovery draft cases and a screenshot preview in thread creation) fail the same way on `main`.
- **Dictation is unchanged.** `widget-dictation`, `pill-controls`, `dictation-focus`, `dictation-retry`, `app` and `crossing` pass against the built app: the widget pill starts and stops dictation, a dictation that could not be delivered is kept and delivered when the pill is pressed, **Discard recording** or Escape in Sotto's window lets it go, and the dictation hotkey keeps the other app's text target and caret.
- **Upgrade keeps saved work.** `tests/unit/main/voiceControlUpgrade.test.ts`, `retiredVoiceCache.test.ts`, `settingsRepository.test.ts` and `credentialStorage.test.ts` cover an old profile: the voice setting is dropped without touching other settings, saved assignments end before any provider is observed and are never revived, drafts, images, user follow-ups and delivery evidence stay, the xAI speech key is cleared while the OpenRouter key stays, and only the voice caches Sotto downloaded are removed, never a wake folder the user chose.
- **Older phones and hosts.** `tests/integration/socketHost.test.ts`, `tests/unit/main/remoteCommands.test.ts` and `desktopHostRouter.test.ts` show host protocol v1 still reads with inert placeholder fields, management commands are refused in plain words, and a host still running legacy management keeps reading, drafting and stopping until it is updated.
- **Nothing announces itself.** A connection Sotto makes at start leaves no notice; one the user asks for says it connected (`agentControlRecovery.test.ts`, red without `6daa2de1c`).
- **The look changed only where it should.** 47 baselines change, each checked against `main`'s copy with the capture test's own pixel rule. Every change is one of six, by intent:
  - the switch reads Dictate and Threads with no Agents (Dictate, focus, Settings and the 760-wide captures; the 125% Dictate capture moves by one pixel);
  - the theme preview in Settings, Appearance shows the Sotto mark where the voice orb was;
  - the OpenRouter key field says it is "Used for transcription and AI cleanup", without Kokoro voice (onboarding and Settings);
  - Settings, Agents is "New threads & projects", without the reasoning account and the automatic follow-up limit;
  - the design fixture's "Streaming WAV stall" thread failed rather than being stopped by Sotto at its follow-up limit, a state that no longer exists, so its row reads Needs attention;
  - Help shows the current version, 0.1.33, where the baseline was taken at 0.1.31.
  Seven other baselines were rewritten with no pixel change and were put back, and the listening capture keeps `main`'s "00" timer rather than this laptop's slower "01". Six were left as they are, because they differ by size for reasons that are not this change: the 125% and 150% scale captures for Dictate and onboarding come out 51 pixels shorter here, since this screen's work area is 1920 by 1032 and Windows clamps the window, and the idle widget captures here at the 124 by 54 footprint the code has always set, where the committed images are 124 by 56. The four scale captures still show the switch with Agents and need taking again on a screen tall enough for them. `npm run design:verify` passes every capture group except those; one group, "phase two workspace composition", sometimes finds Files still reading the folder ("Files is busy.") under load here and passed when run again.
- **Review.** A two-axis review (standards and spec, Sol at xhigh) found two stale document sentences, a duplicated command list and a test branch that could not run; `e7b410df9` fixed them. It also noted the branch name `command-center` lacks a `feat/` prefix, which is the owner's choice, and that `AgentReasoner` now only reads provider accounts; that rename is left for the command center, which is built on top of this.

## Captures

In `artifacts/voice-control-removal/`, each `main` on the left and this branch on the right:

- `settings-appearance-before-after.png`: the theme preview, orb then Sotto mark.
- `settings-agents-before-after.png`: Settings, Agents before and after the dead reasoning controls were hidden.

The design baselines themselves are in `artifacts/design/app-review/baseline/`.

## Not shown here

- The packaged installer, and an upgrade of a real installed profile; the upgrade evidence is from synthetic profiles in the unit suite.
- Apple silicon macOS, which CI's macOS job checks.
- The iPhone and Android apps. No phone code changed; their protocol compatibility is shown only from the desktop and host side.
- A real paired host that still runs legacy management, and live provider accounts.

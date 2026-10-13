# Update all and resuming threads after a restart

October 12, 2026, on the Windows laptop, in the built app on the Owl track (ADR-0076, ADR-0077). Both specs start the
app with an Owl version (`tests/e2e/support/releaseTrack.ts`), so the Owl list turns both features on as a packaged Owl
build would.

## Resuming after a restart

`SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/restart-resume.spec.ts` runs the real Claude adapter over the
fake CLI in `tests/fixtures/`, which holds a turn open until the test ends it.

- Settings → Application shows **Resume threads after a restart**, on.
- A prompt was sent and the turn left running. `restart-resume.json` then named the thread, by its own ID.
- Sotto was quit the way the tray's Quit does. The CLI was stopped, and the record still named the thread afterwards.
- Sotto was started again. The CLI was launched with `--resume` on the same session and sent one more prompt. The
  session file holds exactly two prompts: the user's, then the resume note word for word. The user's prompt was not
  sent again.
- The thread shows the note as Sotto's, with Sotto's mark and the **Resumed** tag, and the turn running again.
  `artifacts/restart-resume/resumed-dark-1280.png` and `resumed-light-820.png` show it. Nothing scrolls sideways at
  1280x800 or 820x560, in dark or light.
- The test then ended the resumed turn, and the thread left the record.

`tests/unit/main/restartResume.test.ts` covers the rest against the coordinator and a scripted host: the record stops
changing once closing starts, the setting off clears the record, a fourth stop in a row and a record older than a week
send nothing, a note already queued is not handed over twice, and an archived thread is left alone.

## Update all

`SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/update-all.spec.ts` connects a real headless host, forge,
over the scripted SSH used by `host-client-updates.spec.ts`, with Claude Code, Codex and Grok Build installed by mise and
all behind.

- On the Threads page the card lists forge's three clients with installed and published versions. The client update
  card and the host update pill are not shown. `artifacts/update-all/offer-dark-1280.png`; at the 820x560 minimum the
  card sits wholly inside the window, `offer-dark-820.png`.
- The chevron folds it into the **Update all** pill, with focus on it, and Enter opens it again,
  `folded-dark-1280.png`.
- One press of **Update all** queued all three on forge. Codex's download was made to drop and Grok Build held at its
  second step. The card read **Updating**, 2 of 3, with Codex failed, Claude Code done and Grok Build on step 2 of 2,
  `updating-light-1280.png`.
- Once Grok Build was let go, the card read **Not everything updated**, "forge's Codex did not update.". Codex's row
  says nothing was changed and that Settings → Hosts shows what the installer said, with **Try again** and **Copy
  commands**, `one-failed-dark-1280.png`. Try again finished it, the card read
  **Updated**, and Dismiss put it away.

`host-update.spec.ts` and `host-client-updates.spec.ts` still pass on the stable track, where nothing changed, and the
Owl-track specs `sotto-owl-branding`, `sotto-owl-night-sky` and `watcher-gate` pass with the card in place.

**Not run in the app.** Sotto updating itself and the restart prompt: a development run has no updater, so the
download, **Restart to finish** and **Restart now** are covered by `tests/unit/renderer/updateAllCard.test.tsx` and
`updateAll.test.ts` only. A host's own Sotto update is the same press `host-update.spec.ts` drives from the pill; the card
starts it once the host's clients finish (unit tests), and that order was not run against a real host. macOS and Linux
were not run.

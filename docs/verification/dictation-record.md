# The dictation record and the delivered app

Checked on Windows on October 21, 2026, for #1292 and ADR-0100. Two things a user sees change: the Keep local history description in Settings says what is kept with it off, and History keeps older transcripts listed after a restart with history off. Everything else is the record behind them.

## What was done

**The delivered app on Windows, through the real paste helper.** `SOTTO_NATIVE_PASTE_SMOKE=1 npx vitest run tests/integration/pasteCommand.windows.test.ts` passed. It opens a Windows Forms text field in PowerShell, brings it to the foreground, asks the warm helper for the foreground app and gets `Windows PowerShell`, then pastes into it through the same helper. A separate run of the helper against the development PC's own desktop answered `Adobe Acrobat`, the app that had focus, with its file description's trailing space removed.

**What it costs.** Measured on the development PC by starting the helper five times with and without the new type, alternating:

| | Starts (ms) | Median |
| --- | --- | --- |
| Before (`origin/main`) | 572, 538, 492, 506, 491 | 506 ms |
| After | 551, 674, 461, 512, 530 | 530 ms |

The helper starts in the background when Sotto starts, so the difference is not felt at a paste. Ten `app` queries in a row took 21.6 ms for the first, then 0.3 to 0.8 ms each. A query is sent as delivery starts and answered inside the paste delay (at least 50 ms), so it adds nothing a user can notice to a paste.

**The journey in the built app.** `tests/e2e/app.spec.ts` passed, 18 of 18, including the new journey: dictate with history on, turn it off, dictate again, and both dictations have a record in `dictation-records.jsonl` with `Sotto` as their app and no transcript words, while `history.json` holds only the first transcript, with its app. Sotto is closed and started again with history still off; History shows "History is off. Older transcripts are still here." and the older transcript, which deletes, taking its record with it. A test run delivers into Sotto's own window, so its delivered app is always Sotto. The journey also takes the screenshots below; `SOTTO_E2E_EVIDENCE=publish` writes them here, and without it they go to the ignored `artifacts/e2e-runs/`.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/dictation-record/history-off-after-restart-1280x800.png` | After a restart with history off, History lists the older transcript, and the footer says "History is off. Older transcripts are still here." Dark, 1280x800 |
| `artifacts/dictation-record/history-off-after-restart-820x560.png` | The same at the 820x560 minimum. The search field's placeholder is cut short there, as History already does at that width on `main`; nothing this change adds clips |
| `artifacts/dictation-record/keep-local-history-dark-820x560.png` | Settings > Application: the Keep local history description over four lines beside its switch, dark, at the minimum |
| `artifacts/dictation-record/keep-local-history-light-1280x800.png` | The same description in light, at 1280x800 |

The description is plain text on theme colours with no motion, so reduced motion changes nothing there. `dictation-recovery.spec.ts`, `dictation-retry.spec.ts`, `dictation-focus.spec.ts` and `widget-dictation.spec.ts` passed, 10 of 10.

## Not checked here

- **macOS: NOT VERIFIED.** There is no Mac here. The macOS reader runs `/usr/bin/lsappinfo front` and then `lsappinfo info -only name` for that application, and its parsing has unit tests (`tests/unit/main/focusedApp.test.ts`). It has never run on a Mac. To check it there: dictate into Mail or Notes with Automatic paste on and with it off, then read `dictation-records.jsonl` in Sotto's data folder; each line should end with that app's name, and no permission prompt should appear. If `app` is missing from those lines, the reader read nothing and the dictation was kept without it.
- **Linux: NOT VERIFIED on forge.** The reader reads the class from `hyprctl activewindow -j`, the same call the paste adapter runs, and is covered by unit tests only.
- **Design captures.** `npm run design:verify` fails on `origin/main` before this change reaches anything: the onboarding baselines still show "Transcribed on this computer by Parakeet v3", where the app on `main` says "by the speech model you choose". That stops the spec before Settings, and regenerating every capture also moves Help, Dictation and Transcription for reasons outside this change. So no baseline is regenerated here. When they are refreshed, Settings' Application captures (`settings-application-privacy`, dark and light) will also show the longer Keep local history description from this change.

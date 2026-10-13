# Dictation history, delivery and spellcheck privacy

This change fixes #512, #515, #516 and #546 on Windows. It changes main-process behavior and keeps the existing controls and layout. The owner's spellcheck decision is to keep spellcheck enabled while blocking dictionary downloads, with no new host and no README exception.

## Reproductions and fixes

- **History (#512).** Seeded `history.json.tmp-123-12345678-1234-1234-1234-123456789abc` files survived Clear history with and without an active history file. Startup removes only temporary history siblings with the store's process ID and UUID filename pattern. Locked files and directories get the same bounded retries as atomic saves; a failed sweep sends `history-temp-cleanup-failed` through the injected startup operational logger and startup continues. Saved history still loads. Clear history removes temporary and corrupt siblings. Saved history and startup recovery backups remain intact; another store's temporary file remains untouched.
- **Delivery order (#515).** Holding widget hide or paste completion let a history copy overwrite the clipboard. Three concurrent dictations all pasted the third transcript. Every nonempty delivery now holds its place from clipboard write through paste completion, a 150 ms settle time after every paste attempt and widget restoration. The settle time also applies when the helper fails or loses its acknowledgement after dispatch. Prompt copies and file-path copies use the same queue and await its result. Clipboard errors release the queue for the next delivery.
- **Unconfirmed paste (#516).** Scripted helper exit, error and timeout invoked a second paste through the fallback. Dispatched commands now return false when their outcome is unknown. Late acknowledgements cannot change the settled result. Backpressure still waits for acknowledgement, and a helper unavailable before its ready line can use the one-shot fallback. No paste command is sent until Add-Type has loaded and the helper reports ready. Disposing a pending helper cancels that paste without a fallback.
- **Spellcheck (#546).** Session mocks confirmed that neither the default policy nor browser sessions configured dictionary downloads. Both now use the hostless `data:,` dictionary base without disabling spellcheck. The real Electron journey forces a missing Afrikaans dictionary on Sotto's actual default and BrowserService sessions, observes begin/failure events, confirms spellcheck remains enabled, and checks the network log for remote dictionary URLs.

The unit regressions failed before their corresponding fixes. The spellcheck network assertion was also checked with a temporary built-only diagnostic using a refused loopback dictionary base: dictionary download still failed, but HTTP dictionary requests made the assertion fail. Restoring the hostless base made the journey pass. This distinguishes the protection from ordinary network failure without contacting the public dictionary CDN.

The second review combined the real warm helper adapter with OutputService and a waiting history copy. Helper exit, `fail` and response timeout after dispatch each reproduced an immediate clipboard overwrite before the fix. Each regression now holds the clipboard and widget unchanged through 149 ms, releases the copy after 150 ms and confirms no fallback paste runs. The history cleanup regressions also failed when logging still used `console.warn`; they pass with the injected operational event, including an unreadable directory through the startup storage factory. The guide states that a fallback before helper readiness can paste up to about ten seconds after dictation into whichever window has focus then.

The independent spec review found that the old filename filter accepted 36 hexadecimal characters or hyphens in any arrangement. Startup and Clear history regressions reproduced deletion of those malformed lookalikes. Cleanup now requires the UUID's `8-4-4-4-12` structure and preserves the unrelated files while still removing temporary files written by the store.

Electron 43.1.0's [dictionary URL patch](https://github.com/electron/electron/blob/v43.1.0/patches/chromium/feat_add_support_for_overriding_the_base_spellchecker_download_url.patch) appends the dictionary filename to a process-wide base URL. `data:,` has no host and cannot return a valid Hunspell dictionary. Electron's [spellchecker documentation](https://www.electronjs.org/docs/latest/tutorial/spellchecker/) describes OS spellchecking on macOS. OS spelling suggestions were not manually tested on macOS; a language needing a downloaded dictionary may offer none.

## Running app

The revised helper also compiled under native Windows PowerShell, emitted `ready` and exited cleanly without dispatching a paste.

`npm run build` succeeded. The second review reran `npx playwright test tests/e2e/dictation-recovery.spec.ts tests/e2e/agent-browser.spec.ts tests/e2e/spellcheck-privacy.spec.ts tests/e2e/new-thread-settings.spec.ts tests/e2e/git-actions.spec.ts tests/e2e/files-panel.spec.ts --workers=1`: eight journeys passed, including the exact copied path through the E2E clipboard adapter and no paste command. After tightening the temporary-file matcher and rebuilding, `npx playwright test tests/e2e/app.spec.ts --grep 'onboards, dictates|paste rejection' --workers=1` passed both first-use dictation/history and rejected-paste copied-result journeys. The spellcheck journey uses the actual production browser session.

The dictation journey covers clipboard-failure recovery, keyboard Copy text, navigation, later dictation, and history off. It checks dark and light at 1600x1000, 1280x800 and 820x560 with reduced motion enabled. The browser journeys cover real local-page actions, user decisions, default grants, Stop, keyboard actions, themes, sizes and the focused-thread player. These are fixture-driven journeys; they do not establish live provider or native target-app behavior.

Inspected captures:

- [Completed text at 820x560, dark](../../artifacts/main-infra-bundle/recovery-820-dark.png): the retained transcript, Copy text and Dismiss text fit and remain readable.
- [Browser in Tools at 1280x800, dark](../../artifacts/main-infra-bundle/tools-1280-dark.png): a native window capture includes the actual local page beside the thread. Renderer-only screenshots omit the separate native browser view, so this retained image uses the native capture.

No design baseline was regenerated. Existing tracked captures overwritten by the journeys were restored; only the two images cited here are retained.

The second review also inspected fresh dark and light recovery captures at 820x560. The final local gates passed: typecheck, lint, notices, and `npm test -- --maxWorkers=2` with 6,542 passed and 153 skipped (489 files passed, 39 skipped). All 93 focused history, helper and output cases passed. Runtime verification passed. Independent Standards and Spec reviews by gpt-6.1-sol at high reasoning report no remaining findings after the malformed-name fix. The inline paste-settle comment is answered with fix commit `4e97eee6`.

Full gate results and final revision are recorded in the pull request. No UI design, shortcut, setting, provider protocol, authority policy, production dependency or allowed host changed.

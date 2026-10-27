# Restart stopped threads

October 26, 2026, on the Windows laptop, in the built app on the Owl track (ADR-0144). The spec starts the app with an Owl version (`tests/e2e/support/releaseTrack.ts`), so the Owl list turns the feature on, as a packaged Owl build would.

## A usage limit, and the restart at its reset

`SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/restart-stopped.spec.ts` runs the real Claude adapter over the fake CLI in `tests/fixtures/`.

- A prompt was sent, and the fake CLI ended the turn with Claude Code's usage-limit result, `api_error_status` 429, with the reset epoch it appends 20 seconds out.
- The thread shows Sotto's sentence for the stop, "Send again after it resets at 5:30 PM."
- The Threads sidebar shows the band, "Claude Code's limit resets at 5:30 pm. Sotto restarts 1 thread then.", with the thread's title and **Don't restart them**. The thread's row reads "Restarts at 5:30 pm". A strip over the composer reads "Restarts at 5:30 pm, when Claude Code's limit resets." with **Don't restart**. All three name the same time as the stop. `artifacts/restart-stopped-threads/scheduled-dark-1280.png` and `scheduled-light-820.png` show it. Nothing in the sidebar or the strip scrolls sideways at 1280x800 or 820x560, in dark or light.
- A minute after the reset, the CLI was sent one more prompt, the restart note word for word. The thread shows it as Sotto's, tagged **Restarted**, the band is gone, and the turn runs again (`restarted-dark-1280.png`). The turn then finished, and nothing more was sent.

## After Sotto restarts

`npx playwright test tests/e2e/restart-resume.spec.ts` passes on Owl with Settings → Threads showing **Restart stopped threads**, on, and the resume note tagged **Restarted**.

## Not checked here

- Codex, Grok Build and Muse limit stops in the running app. Codex's is covered by `tests/integration/codexLimitStop.test.ts` over the fake app-server. Muse's error kinds are a guess, since no Muse protocol document names them.
- Watcher hearing `threads-restarted` in the running app. `tests/unit/main/watcherWakeUp.test.ts` covers it.
- Watcher's pull request news without babysitting in the running app. `tests/unit/main/agentRuntimeBabysittingRetired.test.ts` covers it over the fake `gh`.
- `tests/e2e/babysitting.spec.ts` fails on "the pose starts below the queue" on this laptop. It fails the same way on `origin/main` at bc301891f, so it is not from this change.

# A prototype waiting for review needs you

October 22, 2026, on Windows 11, from `tests/e2e/prototype-ready.spec.ts` against the built app, and from the unit tests named below. The provider's effects come from the E2E host. Only the operating system's opening is recorded: `shell.openPath` and `shell.openExternal` are replaced, so nothing opens.

## Why

Watcher kept telling Zach that nothing needed him while a prototype sat waiting. Only question and permission cards counted as needing him. Separately, a question about a prototype that named no page he could open reached him anyway. He asked for both to change (#1351) and picked variant A from `prototype/prototype-ready` (ADR-0108).

## What was shown in the app

- A real project folder holds `docs/prototypes/settings-restyle-prototype.html`. The agent's finished reply names it by that path. The sidebar row reads **Prototype ready** with the page glyph. Above the composer, a strip says **Prototype ready for review** and has one row, "Open the prototype, settings-restyle-prototype.html".
- At 1600x1000, 1280x800 and 820x560, in light and dark, the row fits inside the strip and the strip does not scroll sideways. Its title and the row's two lines meet 4.5:1.
- Enter on the row opened the file through main, in the system browser, since **Web links in threads** is set to the system browser. The strip and the sidebar's **Prototype ready** both went.
- The agent then asked "Which usage chart prototype should I build?", with listed choices only and no page in it or in the reply before it. That question cannot carry Sotto's note, so the card showed within seconds, once Sotto had looked for its pages. Where the page row would be, it says "No working link. This question is about a prototype, and no page it names opens." The row is not a control, and its words meet 4.5:1 in both themes.
- #954's spec (`tests/e2e/question-message-links.spec.ts`) now serves its review page for real, because a prototype question whose page does not answer is held and sent back. `tests/e2e/question-prototype-pages.spec.ts` and `tests/e2e/thread-sidebar-question.spec.ts` pass unchanged.

## What the tests prove

- `tests/unit/main/prototypeReady.test.ts` and `prototypeReadyControl.test.ts`:
  - A finished reply's working pages mark the thread, and so does a waiting question's.
  - A reply the user answered, a settled thread and Watcher's own threads are never marked.
  - Opening a page clears the mark, through the host service as the phone's page route does, and a restart keeps it cleared.
  - A reply written before marks began earns none, and that time survives a restart.
- `tests/unit/main/questionPages.test.ts`:
  - A loopback page counts as working only when it answers.
  - A reply is searched once.
  - A question's last empty search reports a change, so a question held for it does not wait for the 30-second ceiling. The app showed that case.
- `tests/unit/main/prototypeQuestions.test.ts` and `prototypeQuestionsControl.test.ts`:
  - A prototype question is held while its pages are looked for, and sent back once with the fixed note.
  - The next question in the minute shows, marked link missing when it still has no working page.
  - With no new question, Sotto's copy appears, and its answer goes to the thread as the user's message.
  - A choice-only question is never sent back.
  - The follow-up queue waits while a question is held.
- `tests/unit/main/questionPageDestination.test.ts` and `desktopHostRouter.test.ts`:
  - Sotto's browser opens an address as it is, and a file through the phone access listener.
  - With phone access off, a file opens in the system browser.
  - A prototype's page opens only by a token on its thread's mark.
- `tests/unit/host/questionPageRoute.test.ts`: a GET the page answers reports the page opened, and a HEAD does not.
- `tests/unit/main/watcherWakeUp.test.ts`, `watcherSlimReads.test.ts` and `tests/unit/shared/watcherOverview.test.ts`:
  - Watcher hears prototype-ready news once for each source.
  - Its thread reads name the waiting prototype.
  - The Overview puts the thread under Needs you.
- `tests/unit/renderer/prototypeReadyStrip.test.tsx`, `threadSidebarStatus.test.tsx`, `watcherView.test.tsx` and `requests/agentRequestCard.test.tsx` cover:
  - the strip, and the row's status and its order;
  - the needs-you line and the Overview's **Open the prototype**;
  - the link-missing line, including beside a loopback page that did not answer;
  - a page that opened in Sotto's browser being shown in the thread's Tools > Browser.

## Not shown in the app

Watcher's room is an Owl surface. Its needs-you line, Overview and Watched cards are checked by the renderer tests above, not in the running app. Sending a question back and Sotto's copy depend on a provider asking again, which the E2E host does not do, so those are checked against a real coordinator in `prototypeQuestionsControl.test.ts`. The iPhone's own marks are a follow-up.

## Captures

In `artifacts/prototype-ready/`:

- `prototype-ready-1600x1000-dark.png`, `-1600x1000-light.png`, `-1280x800-dark.png`, `-1280x800-light.png`, `-820x560-dark.png` and `-820x560-light.png`: the sidebar row and the strip.
- `link-missing-1280x800-dark.png` and `-1280x800-light.png`: the question card marked link missing.

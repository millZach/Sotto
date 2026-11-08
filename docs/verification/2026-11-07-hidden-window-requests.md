# A question or an approval while the window counts as hidden

November 7, 2026, on forge (Linux, under `xvfb-run`), in the built app, for #2156. On a Mac, a Codex question and two
command approvals reached main's state but not the open thread until the user went to Settings and back. The session was
driven by a computer-use agent, which reads the page while the system may call the window hidden.

`npm run build && SOTTO_E2E_EVIDENCE=publish xvfb-run -a npx playwright test tests/e2e/codex-request-open-thread.spec.ts`
runs the real Codex adapter over the fake app-server in `tests/fixtures/`. A Codex thread in Ask for approval is sent a
prompt and left working, and the test raises each request on the open thread through the fake's `control.json`.

## With the window shown

- A `request_user_input` question, then two command approvals, each showed in the pane and as **Needs your answer** or
  **Needs your approval** in the sidebar, with nothing pressed and no other page visited. Answering each took its card
  away and the row went back to **Working**.
- This passes on `main` too. With the window shown, Linux does not show the bug.

## With main saying the window is hidden

Main tells the page whether anyone can see the window (`sotto:app:window-visible`). The page holds broadcasts while it
says no (#993). Here main said no while the window stayed on screen, so the page could be pictured. Hiding the window
itself gave the same page on forge in earlier runs, but a hidden window draws no picture.

- **Before**, on `main`'s `AgentContext.tsx`: main held the approval, but a second later the pane still showed no card and
  the sidebar still said **Working**, `artifacts/hidden-window-requests/hidden-request-before-1280.png`. In an earlier run,
  with the window itself hidden, a visit to Settings and back to Threads made the card and **Needs your approval**
  appear, as the issue says. The page going back to Threads sends a command, and a hidden page commits a command's reply.
- **After**: the card and **Needs your approval** showed at once,
  `artifacts/hidden-window-requests/hidden-request-1280.png`. The command summary Sotto asked Codex for (**Sotto asked
  Codex what this does**) came under the same request after it and showed too.
- **After**: still hidden, **Allow once** took the card away, and when the fake ended the turn its reply, **Wrote
  probe-three.txt.**, showed in the transcript and the row stopped saying **Working**. With the first version of this
  fix, which let through only requests coming and going, the spec failed there: the reply and the turn's end stayed held.

`tests/unit/renderer/agentShellAssembly.test.tsx` covers the same in the window's connection alone. A request that
comes, gets its summary or goes, and a turn that ends, each commit while hidden. A broadcast that changes neither is
still held.

## Not checked here

- A Mac. The issue's session was on one, and whether its window was truly covered or on screen while Sotto counted it
  hidden needs one: with a Codex thread open, read `document.visibilityState` and the root's `data-window-hidden` while
  a card is missing.
- Watcher's card for a worker's request, which sits under Watcher's reply to it. That reply now shows when Watcher's turn
  ends, which this run did not exercise.

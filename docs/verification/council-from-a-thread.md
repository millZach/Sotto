# A thread's agent asks the Council

November 5, 2026, on forge (Linux), with `tests/e2e/council-from-thread-live.spec.ts`. The production build ran over an isolated profile (`tests/fixtures/nativeThreadsMain.cjs`) under `xvfb-run` at 1080×720, with real Claude Code and Codex signed in. The Council Owl feature was on. Settings → Council held two panelists, Claude Sonnet 5.5 at low and Codex GPT-6.1 Sol at low, and Sonnet 5.5 at low as the chair. This checks the amendment of November 5, 2026 to [ADR-0177](../adr/0177-the-council-puts-one-question-to-threads-on-several-providers.md).

## Asked

A new Claude Code thread in a small Git project (branch `feat/readme`) was sent:

> Have the council review README.md in this folder: are its install steps correct and complete for a new user? Ask the Council with Sotto's Council tool, tell me you did, and end your turn.

- Claude found `sotto_council__ask_council` through its tool search and called it with its own wording of the question. The call returned `started`.
- The thread's pane opened the Council tab of its drawer by itself, with the chamber running the chair's framing ([asked-drawer-opens.png](../../artifacts/council-from-thread/asked-drawer-opens.png)). The record reads "Asked by Claude Code in this thread, because you said …" (also covered by `tests/unit/renderer/features/council/askedByLine.test.tsx`).
- The seats were Settings → Council's.
- The Codex seat asked once on its permission card. The spec answered it as the user would, once.
- Once the fairness check was done, Sotto sent the thread a message tagged Council, from Sotto. It held the verdict note, the Council's ID and the text Send to drafts ([verdict-back.png](../../artifacts/council-from-thread/verdict-back.png)). Claude then replied to it, and the thread came to rest.

## Not asked

A second Claude Code thread was sent a message that names the tool but never the Council ("ask_council" is one word):

> Call Sotto's ask_council tool once with the question "Is README.md clear?". Then reply with what the tool returned, word for word, and do nothing else.

Claude called the tool and quoted its answer ([not-asked-messages.json](../../artifacts/council-from-thread/not-asked-messages.json), [not-asked-refused.png](../../artifacts/council-from-thread/not-asked-refused.png)):

> {"status":"refused","message":"The user's own newest message in this thread does not ask for the Council, so Sotto refused this. Nothing was started. Do the work yourself, or tell the user they can ask for the Council."}

No Council was started.

## What the first runs found

The first live runs started the Council but showed an empty window as the drawer opened. The new "Asked by" line used JSX without importing React, which the build's JSX runtime needs. The integration tests do not render the window, so they passed. The renderer test above now fails without the import. The asked and not-asked cases were proven in separate runs of the same build.

## Not checked here

- Windows and macOS. The change adds no platform-specific code.
- A Climb started from a real thread. The fake-provider test in `tests/integration/councilFromThread.test.ts` covers its setup, the approval wait and the one-per-message rule.
- Light theme, reduced motion and the 820×560 minimum for the new line. It is one line of muted text in the existing record, styled with the record's own tokens.

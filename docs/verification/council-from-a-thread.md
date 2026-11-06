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

## Hand checks (November 5, 2026, after the merge)

The checks the pull request left for the next Owl were run on the merged code (`4612f9eeb`, the PR head that merged). Each card a thread raised was answered once, as the user would answer it, and each answer is recorded in that run's JSON.

- **Windows.** On Zach's laptop (Windows 11), a real Claude Code thread was asked the same question. The pane opened the Council tab by itself ([windows-asked-drawer-opens-claude.png](../../artifacts/council-from-thread/windows-asked-drawer-opens-claude.png)). The verdict came back tagged Council, and Claude answered it ([windows-verdict-back-claude.png](../../artifacts/council-from-thread/windows-verdict-back-claude.png), [windows-asked-messages-claude.json](../../artifacts/council-from-thread/windows-asked-messages-claude.json)). The first attempt seemed to stall after the verdict: Claude had stopped on a card in its own thread to run the README's start step and check the Council's claim. The spec now answers cards there too.
- **Codex thread.** On forge, a real Codex thread asked the Council, got its verdict back, and told the user what it found ([asked-drawer-opens-codex.png](../../artifacts/council-from-thread/asked-drawer-opens-codex.png), [verdict-back-codex.png](../../artifacts/council-from-thread/verdict-back-codex.png), [asked-messages-codex.json](../../artifacts/council-from-thread/asked-messages-codex.json)).
- **Light theme, reduced motion, 820×560.** Measured in the same runs, with appearance set to light and reduced motion on, after the window was resized to 820×560. On both Linux and Windows, the "Asked by" line read 6.15:1 against its surface. The drawer and the page did not overflow, the line stayed inside the window, and the chamber was still over 1.5 seconds ([look.json](../../artifacts/council-from-thread/look.json), [look-light-820x560.png](../../artifacts/council-from-thread/look-light-820x560.png), [windows-look.json](../../artifacts/council-from-thread/windows-look.json), [windows-look-light-820x560.png](../../artifacts/council-from-thread/windows-look-light-820x560.png)).
- **Climb from a thread.** On forge, a real Claude Code thread was asked "put README.md through a council climb", and the pane opened the Council tab in Climb mode. The chair's proposal waited "Before round 0", and nothing was judged until it was approved in the drawer ([climb-waits-for-approval.png](../../artifacts/council-from-thread/climb-waits-for-approval.png)). It was approved with one attempt. The builder got its fix brief tagged Council, and two rounds were judged. The Climb ended "All required targets met", and its end note came back to the thread ([climb-ended.png](../../artifacts/council-from-thread/climb-ended.png), [climb.json](../../artifacts/council-from-thread/climb.json)). The judges were all Claude.
  - **A Codex judge failed.** With a Codex judge from the Settings panel, the Climb paused after its first judging: "Codex rejected the operation. Review the thread before retrying." That failure is in Climb's own Codex judge path, which this change does not touch.
  - **Builder cards pause the Climb.** Each card the builder raised (five in this run) paused the Climb until **Continue Climb** was pressed. That is Climb's existing rule.

## Not checked here

- macOS. The only Mac on the tailnet is a teammate's, and it refuses SSH. The change adds no platform-specific code.

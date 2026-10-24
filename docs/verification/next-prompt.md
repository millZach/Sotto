# Next prompt and the Next list (ADR-0131)

Proved in the built app on October 24, 2026, on an Apple silicon Mac, with `tests/e2e/next-prompt.spec.ts` (both tests pass). The thread is a Codex thread on the fake app server (`tests/fixtures/fakeCodexAppServer.mjs`), whose `codex exec` answers the side call from `oneshot.json`. The images named here are in `artifacts/next-prompt/`; a run with `SOTTO_E2E_EVIDENCE=publish` writes every capture there, and only these are committed.

## What the run shows

- **One side call per finished turn, on the thread's own provider.** After the thread answers its first prompt, the fake Codex records exactly one `codex exec` call, ephemeral, read-only and tool-free (no `violations.jsonl`), whose material starts "Recent conversation, oldest first" and carries the user's prompt. Thread titles are off in the run, so that call is the next prompt's.
- **The ghost.** The empty prompt shows `Open the pull request for this fix` in placeholder ink with a **Tab** keycap, in place of the placeholder, which draws nothing under it. `ghost-1280x800-dark.png`. Tab takes it into the prompt.
- **The Next list.** Up in the emptied prompt opens the list over the transcript, headed by the headline, with the two answers in the accent, the next prompt keyed Tab, and the four suggestions numbered 1 to 4 with their marks in ink. The composer's height does not change when it opens. `list-1280x800-dark.png`.
- **At each size.** At 1600x1000, 1280x800 and 820x560, dark and light, the list stays inside the window and nothing scrolls sideways; at 1280x800 every row shows, and at the 820x560 minimum the rows scroll inside the list. `list-820x560-dark.png`, `list-820x560-light.png`.
- **Reduced motion.** With reduced motion the list is the same; it has no motion of its own. `list-820x560-light-reduced-motion.png`.
- **Keys.** 2 puts the second suggestion's text in the prompt and closes the list; Escape closes it with nothing written and the ghost comes back.
- **Next and an answer.** **Next** in the footer opens the same list; Enter on the first answer sends `Do both themes` as the user's own message, and the ghost is gone once it is sent.
- **Off.** With `next-prompt` off, the same finished turn makes no side call, and there is no ghost, no **Next** button and no list on Up.

## Checked elsewhere

- Unit tests: the reply parser, the material and its caps, the generation guard (a send, a new turn, a newer user message, a question and a newer finish each drop a late answer), Devin's null side call, stable failure names, the coordinator's finish and send hooks, and the Owl gate in the runtime (`tests/unit/main/nextPrompts.test.ts`); the composer's Tab, prefix, Up, Next, digits, Escape, answers and hiding while a turn runs (`tests/unit/renderer/composerNextPrompt.test.tsx`); the setting through the allow-list (`tests/integration/settingsHistoryIpc.test.ts`).
- Not checked here: Windows and Linux, and a live provider. The design captures do not change, since no design fixture finishes a turn.

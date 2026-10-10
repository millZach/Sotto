# A leftover draft on the empty Threads page

October 9, 2026: Voice control and thread management described below are historical under [ADR-0068](../adr/0068-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

October 5, 2026, on Windows 11 with Electron 43, from `tests/e2e/empty-page-saved-draft.spec.ts` against the built app (issue #736). The profile starts disconnected, with the coordinator's saved state holding a 197-character prompt written for a thread that is not listed, the way the owner's 565-character prompt sat on their machine, beside the design fixture's other threads. A second run starts with the same prompt written for **Footer links**, which is listed. Voice is off, as in the beta.

The page is variant A (In the page) of `docs/prototypes/empty-page-saved-draft-prototype.html`. The owner delegated the pick on October 5, 2026, and A was chosen because it changes the page least and keeps the draft as the one thing to deal with.

## What was shown

- **Disconnected, the page asks to reconnect.** It says "Your draft is saved." and "Reconnect to continue your saved draft.", shows the draft read-only and offers **Connect providers**, as before.
- **Connected, it never asks to reconnect.** It says "A draft from an earlier thread is saved." and "Its thread is no longer here. Start a new thread with it, or discard it.", shows the draft read-only, and offers **New thread with this draft** and **Discard draft**. No text on the page mentions reconnecting.
- **It fits** at 1600x1000, 1280x800 and the 820x560 minimum, in light and dark: the heading, **New thread with this draft** and **Discard draft** are in view and nothing scrolls sideways.
- **Discard asks first.** Enter on **Discard draft** opens "Discard this draft?" with focus on **Keep draft**. Escape closes it, focus returns to **Discard draft**, and the coordinator still holds the draft.
- **New thread with this draft moves it.** A thread opens in the current project with the draft in its composer and the cursor there. Main saves that composer, and only then is the coordinator's copy cleared: `draft` reads empty and the new thread's saved draft reads the same text.
- **A draft whose thread is listed** says "Your draft for Footer links is saved." with **Open thread** and **Discard draft**, all in view at the same three sizes in light and dark. **Open thread** opens the thread with the cursor in its composer.

The unit tests in `tests/unit/renderer/emptyWorkspaceDraft.test.tsx` cover what the running app was not driven through here: the draft is kept when the new composer's save is not confirmed; its images move with it and are named on the page; a draft that answered a question is called an answer; moving it again, after a refused new thread or into the same unused thread after its old copy stayed, adds nothing twice; focus lands on the page heading after a discard; **Open Agents** shows only with voice on, and the draft is offered either way; and a recovered draft after a provider retirement is left to its own notice. `tests/unit/renderer/threadDraftStore.test.ts` covers the store's side: placing the same draft twice, typing while it saves, and a draft too long to add after what the composer holds, which writes nothing.

## Captures

In `artifacts/empty-page-saved-draft/`, which `.gitignore` keeps out of a run's commit; these six are added by hand:

- `disconnected-dark.png`: the page before the providers connect.
- `leftover-1280-dark.png` and `leftover-820-light.png`: the page connected, at 1280x800 in dark and at the 820x560 minimum in light.
- `listed-820-dark.png`: a draft whose thread is listed, at the 820x560 minimum in dark.
- `discard-question-820-dark.png`: the question **Discard draft** asks, with focus on **Keep draft**.
- `new-thread-with-draft-820-dark.png`: the new thread with the draft in its composer.

## Not shown here

- How the owner's draft lost its thread, which #741 follows. The page now handles any draft whose thread is not listed, whatever removed the thread.
- The design captures' `threads-empty.png` differs from its baseline in the sidebar on `main` as well, before this change; its workspace half, where the empty page is, matches the baseline pixel for pixel. The baselines were left alone.

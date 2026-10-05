# A leftover draft on the empty Threads page

October 5, 2026, on Windows 11 with Electron 43, from `tests/e2e/empty-page-saved-draft.spec.ts` against the built app (issue #736). The profile starts with the coordinator's saved state holding a 197-character prompt written for a thread that is not listed, the way the owner's 565-character prompt sat on their machine, beside the design fixture's other threads. Voice is off, as in the beta.

## What was shown

- **Disconnected, the page asks to reconnect.** It says "Your draft is saved." and "Reconnect to continue your saved draft.", shows the draft read-only and offers **Connect providers**, as before.
- **Connected, it never asks to reconnect.** It says "A draft from an earlier thread is saved." and "Its thread is no longer here. Start a new thread with it, or discard it.", shows the draft read-only, and offers **New thread with this draft** and **Discard draft**. No text on the page mentions reconnecting.
- **It fits** at 1600x1000, 1280x800 and the 820x560 minimum, in light and dark: the heading and both buttons are in view and nothing scrolls sideways.
- **Discard asks first.** Enter on **Discard draft** opens "Discard this draft?" with focus on **Keep draft**. Escape closes it, and the coordinator still holds the draft.
- **New thread with this draft moves it.** A thread opens in the current project with the draft in its composer. Main saves that composer, and only then is the coordinator's copy cleared: `draft` reads empty and the new thread's saved draft reads the same text.

The unit tests in `tests/unit/renderer/emptyWorkspaceDraft.test.tsx` cover what the running app was not driven through here: the draft is kept when the new composer's save is not confirmed, a draft whose thread is still listed offers **Open thread**, and a recovered draft after a provider retirement is left to its own notice.

## Captures

In `artifacts/empty-page-saved-draft/`, which `.gitignore` keeps out of a run's commit; these five are added by hand:

- `disconnected-dark.png`: the page before the providers connect.
- `leftover-1280-dark.png` and `leftover-820-light.png`: the page connected, at 1280x800 in dark and at the 820x560 minimum in light.
- `discard-question-820-dark.png`: the question **Discard draft** asks, with focus on **Keep draft**.
- `new-thread-with-draft-820-dark.png`: the new thread with the draft in its composer.

## Not shown here

- How the owner's draft lost its thread. The page now handles any draft whose thread is not listed, whatever removed the thread.
- The design captures' `threads-empty.png` differs from its baseline in the sidebar on `main` as well, before this change; its workspace half, where the empty page is, matches the baseline pixel for pixel. The baselines were left alone.

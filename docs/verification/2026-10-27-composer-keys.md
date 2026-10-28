# The composer's keys

Checked on an Apple silicon Mac on October 27, 2026, for Drake's pick of 9b in `prototype/prompt-send-stop`. ADR-0153 records the decision. The app was not launched: the composer's real markup was rendered in the unit test environment (the same mounts `threadQueueSkills.test.tsx` and `watcherView.test.tsx` use, with a Mac's settings for the Threads composer and Windows' for Watcher's), set in the stylesheet the build writes (`electron-vite build`), with Sotto's own dark and light palettes, and captured with headless Playwright. The before captures are the same states from `origin/main` at `4899f5080`.

## What was done

Six states, each in dark and light, in a 1320px pane (the 1600px window with its sidebar) and a 560px pane (the 820px minimum with its sidebar open):

1. at rest with text typed;
2. at rest with nothing typed;
3. a turn running with nothing typed;
4. a turn running with text typed and one follow-up queued;
5. Watcher's composer while Watcher works, with text typed and one queued;
6. the follow-up editor.

Before, the send square was filled with the accent text colour and drew its glyph in the accent fill's ink. In Sotto's own palettes that reads; the prototype measured the same pair in T3 Chat's dark half at 1.0:1. After, the filled button is the theme's text colour with its canvas as the ink. The theme test already holds that pair in every bundled palette, and the prototype measured it at 19.5:1 in dark, 15.7:1 in light and 16.1:1 in T3 Chat's dark half.

In the wide pane each button shows its word and its key: Send ↵, then Steer ⌘↵ (dim until there is text), and Stop ⇧⌘S filled while a turn runs with nothing typed. With text typed, Stop steps back to a flat key and Queue ↵ is filled. The light round Stop shows in both. In the narrow pane the same buttons show their keys alone, and nothing overflows the card. Watcher's composer showed Ctrl+Enter and Enter, as on Windows, and Stop with its word alone, since the stop chord does not answer in Watcher. The follow-up editor shows Cancel Esc and Save ↵.

`threadQueueSkills.test.tsx` gained a check that Ctrl+Enter (the Windows chord, which the unit environment uses) steers while a turn runs and queues nothing; Enter still queues, as its existing checks say.

## Evidence

In `artifacts/prompt-send-stop/`: `before-dark-wide.png`, `after-dark-wide.png`, `before-light-wide.png`, `after-light-wide.png`, `before-dark-narrow.png`, `after-dark-narrow.png`, `before-light-narrow.png`, `after-light-narrow.png`. Each shows the six states top to bottom.

## Not checked here

The running app, motion with reduced motion turned on, and Windows and Linux rendering. The light's motion was checked in the prototype, not in these still captures. The design captures (`design:verify`) are left to CI.

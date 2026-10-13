# Composer typing lag verification

Issue #286. Typing in the Threads composer lagged in every thread whenever an agent was working.

## What was measured in the running app

A script pasted into the DevTools console of the installed 0.1.16 window measured the owner's own data: 61 threads and 608 models. It recorded timings, counts and sizes only, never the typed text.

- Half of all keystrokes took over 21 ms to reach the screen, and the worst 71 ms. No frame took longer than 50 ms, so no single piece of work was at fault.
- With reduced motion on, nothing animated and typing was just as slow. The sidebar ring and the activity pulse are not the cause.
- While a thread worked, main sent the window its whole state about 1.4 times a second, each copy 1.6 MB. Reading one in took the window 8 ms.
- 1.4 MB of each copy was the model list twice: once for the host (688 KB), and again in the per-host list the desktop keeps so each thread can read its own host's models (689 KB), with only one host connected.

## The change

The desktop host router now builds the per-host list from the same model array the host uses. When the same array appears twice in one message, Electron sends it once, so each host's models cross to the window once per update.

## Results

- `tests/unit/main/desktopHostRouter.test.ts` measures the state the way Electron sends it. It failed before the change and passes after.
- The window's work for one arriving state, measured against the owner's saved workspace: 34.5 ms before, 24.6 ms after. Reading the state in fell from 8.8 ms to 3.9 ms.
- In the built app, a temporary Playwright spec gave the test provider a model list the owner's size, changed another thread 1.4 times a second, and typed into a thread meanwhile. Before the change, keystrokes took 24 ms to reach the screen, against 16 ms with nothing changing. After it, they took 16 ms either way.

The temporary spec was removed; the unit test is the lasting guard. The test app has two threads against the owner's 61, so it showed a milder lag than the owner saw. The change has not yet been measured on the owner's installed app.

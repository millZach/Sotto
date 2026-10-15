# Greet a new thread above its composer in the middle of the pane

Zach chose variant a of `docs/prototypes/new-thread-greeting-prototype.html` on October 14, 2026: the greeting, a
project line and the composer as one block in the middle of the pane, rather than variant b, about 40% of the way down.
He found the prototype's 900px composer too wide and picked 720px from 560, 640, 720 and 900. Before the prototype he
chose a bit playful greetings, a project line under the greeting (project, branch and where the thread runs), every
pane centring its own new thread, the placeholder left as "What would you like to do next?", and straight to stable
rather than an Owl feature. He approved the eleven lines and the three timed ones as the prototype listed them.

Acceptance checks:
- A thread nothing has been sent to shows one greeting, picked at random and kept while the window is open, in place
  of "What is next for this thread?". A timed line shows only at its time of day.
- The greeting and composer stand in the middle of the pane, the composer no wider than 720px. The first send slides
  the composer to the bottom and widens it; reduced motion moves it at once.
- A working or compacting thread, one with a request or older history, and Watcher's own conversation keep the line
  they had.
- Theme tokens only; dark, light and reduced motion checked at 1600x1000, 1280x800 and 820x560, with nothing clipped
  at the minimum and the option pickers still inside the window.

Checklist:
- [x] Pick recorded
- [x] Greeting, slot and composer slide in the Threads pane
- [x] Unit tests, the new Electron journey and the effort picker journey
- [x] Glossary, guide and verification note

Evidence is in `docs/verification/new-thread-greeting.md`.

# "Writing a reply" said once

November 9, 2026, on forge (Linux, Omarchy), in the built app (ADR-0134, November 9 amendment), under `xvfb-run -s "-screen 0 1920x1200x24"`. `npx playwright test tests/e2e/writing-reply-once.spec.ts` runs the real Claude adapter over the fake CLI in `tests/fixtures/`, with Settings › Threads › Replies in threads set to **When finished**; it passed.

- A prompt was sent, and the fake CLI started a reply and wrote its first words. The working line reads "Writing a reply". No reply is drawn for it: no "Writing a reply…", no header, none of its words (`artifacts/writing-reply-once/writing-dark-1280.png`). The line stays in view and nothing scrolls sideways at 1280x800 and 820x560, in dark and light (`writing-dark-820.png`).
- The turn ended: the reply shows whole, "The essay is finished.", and the working line is gone (`finished-dark-1280.png`).

Zach saw it in a Codex thread. What the transcript draws does not depend on the provider, so the Claude adapter stands in here.

## Not checked here

- A reader inside a reopened turn's answer coming back to it once the answer is whole: `tests/unit/renderer/threadWorkspace.test.tsx` ("comes back to where they were reading…") and `tests/unit/renderer/readingPlace.test.ts` cover the keeper.
- Windows and macOS: CI's desktop journeys run this spec there.

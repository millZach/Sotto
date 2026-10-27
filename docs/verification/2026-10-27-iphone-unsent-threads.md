# The iPhone leaves unsent threads off Threads

October 27, 2026. ADR-0152.

What was checked:

- `swift test --filter FocusThreadsTests` in `apps/ios` on an Apple silicon Mac: 16 tests, no failures. `testAThreadNeverSentToIsListedOnlyWhileOpenOrHeld` lists a thread on its default title with no messages only while it is open on the iPhone or the iPhone holds something for it; a thread with messages, a renamed one, a settled one, and one from a computer that sends no message count stay listed as before.
- The iPhone app and its UI tests were built and run by CI's Native iOS client job, not on this Mac.

Not checked in the running app: the four empty rows on Drake's computer. They meet the rule (default title, idle, no messages), so this build leaves them off Threads; they stay on the computer, as on the desktop.

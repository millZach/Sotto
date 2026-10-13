# Settings fixes, pkg-18

The owner chose microphone prototype variant B in issue #518: `docs/prototypes/reclaim-and-mic-test-prototype.html?q=mic&variant=b`. The prototype remains outside this branch. Use Sotto's existing Button and VoiceWave: **Stop test** while listening, **Sotto heard you. The microphone is closed.** after stopping a successful test, and **Test again**. Hiding the window or leaving Dictation closes the input too. Pending permission must not reopen it after cancellation.

Acceptance checks:

- S-044: already fixed upstream; preserve selected exact input and onboarding's default input. Existing unit and Electron regression tests cover both.
- S-045: Stop test works by keyboard, hidden windows and category/page exits release the input, and late permission results stay cancelled.
- S-093: the dictionary accepts at most 4,000 characters, explains the limit, and saves a changed draft when Settings unmounts.
- S-094: quick cleanup changes preserve each other before settings publications arrive.
- S-123: unchanged shortcut and numeric fields do not write or announce a save; changed and failed drafts retain their existing acknowledgement behavior.

Before delivery: run the four repository gates, build and exercise the affected Electron journeys, inspect the captures, review the diff against standards and these acceptance checks, then open the PR and wait for CI on its latest revision. Merge origin/main after the first green result and check any subsequent push. The PR stays open for its reviewer.

Second-review acceptance checks: retain both `.gitignore` additions when merging main; keep the dictionary paste status mounted and clear its text below 4,000 characters; call a chosen microphone disconnected only when its ID is absent from the current list; and move onboarding to missing when its test input ends, allowing retry and ignoring older callbacks. Preserve the existing UI and owner-selected variant B. The state prototype is captured on the local `prototype/pkg-18-second-review` branch, outside this PR.

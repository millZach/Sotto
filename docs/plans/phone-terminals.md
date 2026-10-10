# Terminals on paired phones

Issue [#884](https://github.com/millZach/Sotto/issues/884), based on `feat/terminal-agent-states`. The owner approved variant B of `../prototypes/terminal-agent-state-prototype.html`; keep the original prototype unchanged. Follow ADR-0066's hook authority and approval-only preview, and ADR-0051's Glow components.

- [x] Install this worktree with `npm ci`.
- [x] Read the issue, protocol and relevant ADRs.
- [x] Advertise `terminals` only when the desktop's phone listener has a terminal workspace; old clients remain thread-only.
- [x] Keep output out of rows and pushes. Read at most eight current screen lines for one live Claude approval. Require an exact reviewed preview, current Can answer and hook acknowledgement.
- [x] Put terminal rows into Needs you, Working and Recent on iOS; clear Just finished only while a foreground detail shows the terminal.
- [x] Add protocol, SottoCore, AppModel and simulator journey tests.
- [x] Complete the required Windows gates after review corrections; record exact results in `../verification/2026-10-09-phone-terminals.md`.
- [x] Review standards and issue requirements independently; fix concrete findings in separate commits.
- [x] Make local selection immediate and ignore delayed navigation replies after a detail closes.
- [x] Keep visibility withdrawals independent of busy terminal operations and retry failed observations against current selection and connection generation.
- [x] Use capability-aware empty-list wording within the approved variant B layout.
- [x] Enable CI for pull requests against the stacked desktop base.
- [x] Queue preview reads below the host connection limit and keep overlapping approvals in the native CLI.
- [x] Preserve current permission screens when submission metadata arrives late, without accepting another turn's screen.
- [x] Run the final local gates with the two-worker cap.
- [x] Push and open [pull request #903](https://github.com/millZach/Sotto/pull/903) against `feat/terminal-agent-states`; do not merge.
- [ ] Complete the macOS native gate and inspect and commit simulator screenshots.

The small status view is the working assumption for tapping a terminal without an approval. It provides the foreground detail observation ADR-0066 already defines. The lead was asked and no reply arrived, so this reversible choice was retained; it does not change the approved list or Permission card.

No Java executable or JDK was found on PATH, through JAVA_HOME, or in the standard Java, Microsoft, Eclipse Adoptium and Android Studio locations. Android remains untouched as permitted by the issue and lead instructions. Windows cannot build Swift or run an iOS simulator. The finishing run is authorized to push and open the stacked pull request after the local gates pass, then use macOS CI for native compilation, tests and screenshots. Native verification remains required before calling the issue complete.

The design pass's missing timestamps are intentional: `openedAt` identifies terminal creation, not work start or permission arrival. Do not label it as either. More choices keeps the one-time Yes/No boundary and explains that the native CLI owns other choices, as ADR-0066 requires. The empty-list correction changes only wording; the approved variant B structure remains the reference. `tools/capture-phone-terminal-empty-prototype.mjs` renders both copy scenarios in a temporary copy of that prototype.

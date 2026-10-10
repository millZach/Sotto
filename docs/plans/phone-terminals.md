# Terminals on paired phones

Issue [#884](https://github.com/millZach/Sotto/issues/884), based on `feat/terminal-agent-states`. The owner approved variant B of `../prototypes/terminal-agent-state-prototype.html`; keep the original prototype unchanged. Follow ADR-0066's hook authority and approval-only preview, and ADR-0051's Glow components.

- [x] Install this worktree with `npm ci`.
- [x] Read the issue, protocol and relevant ADRs.
- [x] Advertise `terminals` only when the desktop's phone listener has a terminal workspace; old clients remain thread-only.
- [x] Keep output out of rows and pushes. Read at most eight current screen lines for one live Claude approval. Require an exact reviewed preview, current Can answer and hook acknowledgement.
- [x] Put terminal rows into Needs you, Working and Recent on iOS; clear Just finished only while a foreground detail shows the terminal.
- [x] Add protocol, SottoCore, AppModel and simulator journey tests.
- [ ] Complete the required Windows gates after review corrections.
- [x] Review standards and issue requirements independently; fix concrete findings and commit coherent changes without pushing.

The small status view is the working assumption for tapping a terminal without an approval. It provides the foreground detail observation ADR-0066 already defines. The lead was asked and no reply arrived, so this reversible choice was retained; it does not change the approved list or Permission card.

No Java executable or JDK was found on PATH, through JAVA_HOME, or in the standard Java, Microsoft, Eclipse Adoptium and Android Studio locations. Android remains untouched as permitted by the issue and lead instructions. Windows cannot build Swift or run an iOS simulator: macOS CI remains the native compile/test check, and simulator screenshots remain a required follow-up. No push is authorized here, so that CI job cannot be triggered from this branch during this run.

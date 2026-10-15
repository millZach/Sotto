# Questions above the composer

Zach approved prototype A on September 20, 2026 and asked to proceed. Desktop only.

The question arrives above its thread's message bar; choosing an answer prepares it, and Send answer delivers it.

## Acceptance checks

- [x] Stacked choices match the approved A reference; the model's recommendation is labeled beside its option, never inferred or preselected.
- [x] Custom answers have a visible, dedicated text box. Typing selects that answer, Enter adds a line, and only Send answer submits. Whitespace is not an answer.
- [x] A choice change retains custom text without sending it. The general message draft is independent. Existing saved-draft and uncertain-delivery protections remain intact.
- [x] Questions remain above the composer, separate from scrolling history. Long forms scroll within a bounded region. Permissions retain their existing behavior.
- [x] Collapse/Escape and reopen preserve answers and restore usable keyboard focus. Native radio and checkbox keyboard behavior remains intact.
- [x] Figtree, theme-role tokens, quiet surfaces, readable 4.5:1 text contrast. Question/option text leads, with only necessary labels and delivery feedback. No duplicated question headline.
- [x] A brief arrival motion gives way to selection feedback; reduced motion shows the settled panel.
- [x] Review the real Electron app at 1600x1000, 1280x800 and 820x560 in dark/light and reduced motion, including single and multi-question forms, custom answers and submission.
- [x] Run relevant renderer and delivery tests, typecheck, lint, unit/integration suite, notices and affected Electron journeys. Review standards and requested behavior separately.
- [x] Update user documentation and record actual verification evidence. Preserve unrelated working-tree changes.

## State

Implemented on `feat/question-choices`, isolated from concurrent work on the shared checkout and based on `origin/main`. Final isolated gates pass: typecheck, lint, notices, 3,972 unit/integration tests on the initial revision, and 16 Electron journeys after the legacy persistence review fix. Standards and spec review findings are resolved. Hosted checks must pass before the user-authorized merge. The chosen reference is `src/renderer/src/agents/question-choice-prototype.html?variant=A`; the current conversation is the decision authority: after viewing the question A screenshot, Zach said "Awesome lets go with that." Variants B and C are rejected alternatives; the production change is a rewrite using the existing question component and durable answer store.

No new host, model call, dependency, setting or permission grant is needed. The provider supplies the choices and marks any recommendation; plain unstructured questions retain their text-answer fallback. Prototype archived on local branch `prototype/question-choices-a` at `f87b6ba83b79865834d55a8a5ae6d41ecaebbdd6`, without changing the active index or branch. Verification results are in `docs/verification/question-choices.md`.

The short-pane adjustment gives an expanded question the history area below 420px pane height and keeps the independent general draft to one scrollable line. Collapse restores history. If history contains a pending permission or saved-answer recovery, both regions stay available in a scrolling pane. This was required by actual Electron hit-testing and geometry failures; final minimum-size and stacked-pane journeys pass.

## Links from the agent's message (October 11, 2026)

The docked card covers the end of the agent's message, so a prototype link an agent handed over just before asking was out of sight, and the card links only an address written into the question itself. Zach chose from the prototypes on the tag `prototype/question-message-links`: on the desktop, variant A, an "Open the link" row for each web link in the agent's newest message, between the question and its choices, leaving out any the question already shows; on the iPhone, the same links added to the "Open the link" rows its question sheet already shows, with no caption. Verification is in `docs/verification/2026-10-11-question-message-links.md`.

## Pages for a question (October 14, 2026)

The message links above lifted only `http` and `https` addresses, and most prototype hand-offs were a file path or a `localhost` address, so a question about a prototype still had nothing that opened on the phone. Zach chose for Sotto to find a question's pages itself, for every provider (ADR-0084): HTML files in the thread's folder and pages the agent serves on its computer's loopback, served by the host under a token through phone access. A `localhost` page is passed through rather than opened on the computer only, and the iPhone opens a page in Safari's in-app browser over the sheet. From the prototypes on the tag `prototype/question-prototype-pages` he picked variant A: an **Open the prototype** row for each page, before the **Open the link** rows, on the desktop card and the iPhone sheet alike. Verification is in `docs/verification/2026-10-14-question-prototype-pages.md`.

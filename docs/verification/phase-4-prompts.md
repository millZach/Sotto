# Phase 4 editable prompts (#72)

The current personal chat can produce a separate editable prompt through its original provider/model. Generation reads the complete chronological transcript, preserves the source chat and unsent draft, and does not create project work. Oversized or changing discussions fail explicitly instead of silently losing corrections. Pending native delivery, requests or history recovery must settle first.

Output uses objective, relevant context, accepted decisions, constraints/non-goals, deliverables, acceptance checks, unresolved questions and suggestions. Empty sections disappear. Every generated item carries source quotations that are checked against exact message IDs and text; actionable requirements require user evidence. This validates attribution, not semantic fidelity by itself.

## Fidelity and usefulness

`tests/fixtures/chatPromptCases.ts` contains four synthetic discussions: a short objective with missing details; explicit changed decisions; contradictory offline/team requirements; and a longer workshop brainstorm with later corrections and a supplier-integration non-goal. The rubric checks latest-decision fidelity, separation of proposals and acceptance, constraints/non-goals, missing details and contradictions, source attribution, standalone usefulness and avoidance of invented work.

`SOTTO_NATIVE_PROMPT_REVIEW=1` ran all four through the installed Codex subscription client using `gpt-6-astra` at low reasoning. All four passed the structured output and source-attribution checks (73.84 seconds). Actual discussions, outputs and rubric are saved in [the review worksheet](../../artifacts/phase-four-prompts/review.md) and [machine-readable results](../../artifacts/phase-four-prompts/native-results.json). Agent inspection found later corrections retained, unresolved contradictions exposed, proposals separated and requested constraints/deliverables represented. **Human review is pending; the format is provisional, not declared proven.** No answer to the optional review request has been inferred from silence.

## Verification

- Nine service tests passed, including changed-source rejection, attribution failures, original-chat preservation, pending-state guards, overlapping generation and oversized transcripts. The changed-source regression was red before its guard and green afterward.
- Trusted-main-frame IPC checks passed for generation and bounded clipboard writes. Browser clipboard access failed in the actual Electron app, so copying now uses the existing trusted main-window IPC boundary.
- `tests/e2e/phase-four-prompts.spec.ts` passed at 820x560: generate, edit, exact native clipboard match, Escape, focus restored to Edit prompt, reopen without losing edits, unchanged source chat/draft and unchanged project/thread/assignment state. A later correction marks the existing prompt stale; deliberate Regenerate incorporates it. Edited text survives until regeneration succeeds, including pending and failure states. This additional Electron regression failed before the stale indication/regeneration control and passed after the fix. The initial test lacked a completed-onboarding profile; the corrected test starts with that prerequisite saved before launch.
- The shared Electron capture harness exercised 1280 and 820 windows in light/dark with reduced motion. Root inspected the minimum light/dark editor: title, review instruction, editable text, Copy and Close remain legible and reachable. Native dialog focus containment and Escape use platform behavior. Captures are under `artifacts/phase-four-usage/prompt-*.png`.

Prompt drafts remain local to the mounted personal-chat view; generating or editing does not overwrite the saved conversation. Final integrated checks and review are recorded in [phase-4-implementation.md](phase-4-implementation.md).

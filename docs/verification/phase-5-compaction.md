# Phase 5 — native compaction (#67)

## Acceptance and evidence checklist

- [x] Native adapter seam: Codex native RPC, Claude native slash command, Grok unsupported; duplicate and uncertain delivery protection, actual completion/failure.
- [x] Clock-controlled rendered composer seam: Claude >=100,000 context tokens AND >=70 minutes, no running/pending recommendation; snapshot dismissal and native Don't ask again.
- [x] Preserve native auto-compaction defaults and explicit configuration/environment overrides. No custom summarizer.
- [x] Desktop target from approved plan: normal and minimum Windows window, keyboard, supported themes, rendered screenshots inspected.

## Reference and design checks

Read pinned T3 `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`: ContextWindowMeter.logic.ts (predicate and capability), ChatView.tsx (session-scoped set of thread/context-timestamp dismissals), ClaudeAdapter.ts (native `/compact` and resume_return), CodexSessionRuntime.ts (`thread/compact/start`). Installed Claude SDK protocol supplies request_user_dialog and compact_boundary/status events. Native resume Don't ask again remains a separate persistent provider preference.

This is a context control beside the working draft; the proving moment is a recommendation that can compact natively or preserve the current history.

Concepts: (1) inline composer recommendation; (2) context popover action; (3) transcript status entry. Chosen: inline recommendation beside existing usage, with a quiet manual action and native state feedback.

Tastify: retain Sotto's theme roles and existing button typography; composer remains dominant. Recommendation has one explanatory sentence, Compact and Keep full history (three text purposes). Manual action and state feedback are functional exceptions. No artwork required for a scoped text control. Motion is existing button feedback; state appears without movement to protect draft placement and reduced-motion behavior. Verify wrapping, focus and contrast in rendered desktop/minimum/theme views.

## Verification results

- Eight native protocol fixture cases pass: Codex dispatch acknowledgement versus actual boundary, duplicate rejection; Claude advertised capability, native `/compact`, actual failure, all three native dialog responses, persistent never preference, supported environment overrides and missed-live-boundary reconciliation; Grok explicit unsupported rejection.
- Clock-controlled component tests pass for inclusive 100,000-token/70-minute boundary, absent/invalid context time, pending/running suppression, session-only dismissal across remount and A→B→A snapshots, persistent native dismissal, provider differences and truthful feedback. A dedicated contextUpdatedAt excludes output/cost bookkeeping and old replay.
- Public AgentControl/Codex regression passes: second compaction rejected while pending; restart preserves uncertain state and does not issue another native RPC.
- NativeUsage regression passes: old assistant usage cannot restore pre-compaction context, while a new assistant context is accepted.
- Focused existing suites passed: Claude adapter contract/safety, Codex host, native request forms, native usage, Claude subscription, Grok adapter contract. Final full suite, review and commit are owned by the integration agent.

Installed-client check: `SOTTO_PHASE5_COMPACTION_NATIVE=1 npx vitest run tests/integration/compactionNative.test.ts` passed both clients on 2026-09-13 (latest run 36.81 seconds). Each created one owned synthetic thread, submitted one bounded no-tools prompt and requested native compaction. Both reported actual completion and returned idle; only the original Sotto prompt remained in authored user history. Codex App Server 0.154.0; Claude native transcript identifies 2.1.270. Evidence: `artifacts/phase-five-compaction/codex-native.json` and `claude-native.json`. The native resume-return age prompt was not induced with a large aged real thread; its three choices and persistence are verified against the installed SDK protocol and scripted native process.

Native verification exposed Claude synthetic summary/control-command echoes. They are now excluded by native metadata and exact command-envelope identity, preserving real external authored prompts and avoiding false management takeover. Dedicated Sotto compaction input UUIDs stay in the adapter alias, not public state. Missed persisted boundaries reconcile only if their native timestamp is after the durable compaction request; stale historical boundaries cannot settle later work.

Native settings/config files are not rewritten. The existing Claude environment filter now preserves the four documented compaction controls (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), without setting any defaults. [Claude Code environment variables](https://code.claude.com/docs/en/env-vars) checked 2026-09-13. Codex native auto-compaction configuration remains untouched.

Rendered Windows check: the integration agent ran `scripts/inspect-phase5-compaction.mjs` successfully on the integrated production build. It supplies a clearly identified provider-state fixture to inspect aged context without generating 100,000 live tokens. Captured 1280×860 and 820×560 in dark/light appearances, plus running/failure/completed states; keyboard dismissal and disabled duplicate action passed, with no horizontal overflow. The integration agent inspected `recommendation-820-light.png` and `failure-820-light.png`: the recommendation and actions fit, copy is readable, keyboard focus is visible, and failure feedback wraps within the composer. The transcript and draft retain the dominant space; the context actions remain subordinate below native usage. Recommendation copy has three purposes (one sentence, Compact, Keep full history), no repeated fact or companion headline. These captures use Tide; the remaining palette matrix is being completed by the integration agent before final acceptance.

Final palette verification is complete: the script dynamically reads all six built-ins and passed 24 normal/minimum light/dark captures, followed by keyboard dismissal and running/failure/completed states. Root inspected every minimum-size palette through `artifacts/phase-five-review/compaction-{dark,light}.png` and the individual Tide state views. Text and actions remain readable and contained in each palette. The capture script re-emits its synthetic provider state after resetting appearance, since updating settings can broadcast the ordinary fixture host state; that harness correction required no product change.

# Usage in Sotto Owl

Zach requested native subscription tracking and a Usage dashboard on October 12, 2026, explicitly as an Owl feature. He chose both account limits and Sotto activity, Overview first, independent retained numeric history with its own Clear action, and all connected computers with Owl host support. ADR-0075 records the boundaries.

The first prototype's overall visual feel was rejected. Zach asked Opus 5.5 at xhigh for an independent design pass and selected **C: Focus**: the headline index and one focused view, with shared Subscriptions and Models views. Both passes and verdicts are archived in the [`prototype/usage-dashboard` tag](https://github.com/millZach/Sotto/tree/prototype/usage-dashboard/docs/prototypes), commit `a01a355115903b7a22d62c363dbe0f5c3ba8263f`. The standalone HTML is evidence; the implementation is a production rewrite.

Deliverables and acceptance checks:

- [x] Verify native provider metadata sources without model inference; record primary sources and real capability gaps.
- [x] Prototype, inspect sizes/themes/keyboard interactions and record Zach's choice.
- [x] Bounded shared schemas and local numeric store: whole-row replacement, unknown versus zero, partial and undated data, original pending prompt metadata, clear exclusions, local-date and DST aggregation.
- [x] Native token/quota observation and thread/model mapping, preserving existing accounting.
- [x] Exact coordinator acceptance hooks and resilient host-owned collection service, including recovery without prompt text.
- [x] Optional local/remote read, metadata refresh and revision-guarded clear, with partial host failures and existing client authority.
- [x] Own-version Owl host archive preparation and negotiated capability; stable preservation and older-host compatibility in scoped fixtures.
- [x] Selected C production UI, all provider/computer/date filters, Overview/Subscriptions/Models, clear dialog and honest loading/unknown/partial states.
- [x] Owl startup gates, hidden stable surface and dormant record preservation.
- [x] Actual local Windows Electron journeys and visual inspection at three sizes, light/dark/reduced motion, keyboard, clear/reload and failure states.
- [x] Focused Playwright: two Usage journeys and the neighboring host-update and native-usage-persistence journeys passed.
- [x] Guide, overview, glossary and ADR updated; final captures and numeric evidence retained.
- [x] Resolve all four Spec findings and the Standards chart finding; both final review verdicts have zero unresolved findings.
- [ ] Final CI gates: typecheck, lint, full suite with two workers and notices.
- [ ] Verify the native Windows Owl host archive and packaged desktop surface from the final clean source.
- [ ] Finalize the [verification note](../verification/2026-10-13-usage-dashboard.md) and reviewable local commits.

Provider coverage is intentionally bounded by evidence: Codex and Grok support native metadata reads; Claude supplies passive limit events and cannot refresh idle allowances through a billed probe; Devin token and allowance metrics remain unavailable. Prompt counts begin with this collector's accepted sends. Existing token ledgers can contribute undated observed usage; neither those rows nor account limits prove complete Sotto-only or account-wide model history. Automatic side calls are not reconstructed.

No release publication or merge is requested. Completion means integrated local code, verification and reviewable changes; a published Owl and updating a real remote installation remain separate release actions.

On October 13, the integrated implementation is committed at `c745c6e4a90193aa238ce9d97a9f97557066e327`, with subsequent review fixes still local. Both final review verdicts have zero unresolved findings. Durable numeric conflict floors preserve Grok uncertainty across duplicate replay, SQLite close/reopen and fresh adapters; complete native evidence repairs confidence and Clear deletes the floors. The final Usage journeys passed with all six headline controls revealed inside the minimum-width strip when focused. The first full suite found eight omitted expected-contract fixtures in three files; those fixtures are fixed and 54 focused tests pass. The final CI rerun, actual packaged checks, final evidence note and local review-fix commit remain pending. No real macOS or Linux desktop or remote host installation has been verified; the read-only forge SSH attempt timed out.

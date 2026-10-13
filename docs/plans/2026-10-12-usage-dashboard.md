# Usage in Sotto Owl

Zach requested native subscription tracking and a Usage dashboard on October 12, 2026, explicitly as an Owl feature. He chose both account limits and Sotto activity, Overview first, independent retained numeric history with its own Clear action, and all connected computers with Owl host support. ADR-0076 records the boundaries.

The first prototype's overall visual feel was rejected. Zach asked Opus 5.5 at xhigh for an independent design pass and selected **C: Focus**: the headline index and one focused view, with shared Subscriptions and Models views. Both passes and verdicts are archived in the [`prototype/usage-dashboard` tag](https://github.com/millZach/Sotto/tree/prototype/usage-dashboard/docs/prototypes), commit `a01a355115903b7a22d62c363dbe0f5c3ba8263f`. The standalone HTML is evidence; the implementation is a production rewrite.

Completed local checkpoint and acceptance checks, before main integration:

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
- [x] Commit the reviewed implementation and strict fixture fixes locally at `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`.
- [x] Final typecheck, lint and notices verification of 189 components passed.
- [x] Final full suite with two workers: 798 files and 10,094 tests passed; 60 files and 299 tests skipped; exit code 0.
- [x] Verify the native Windows Owl host archive, packaged Owl desktop and stable dormant preservation from exact `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`.
- [x] Finalize the [verification note](../verification/2026-10-13-usage-dashboard.md) with final gates, reviews and actual package provenance.
- [x] Record the final evidence locally in the closing verification commit.

Provider coverage is intentionally bounded by evidence: Codex and Grok support native metadata reads; Claude supplies passive limit events and cannot refresh idle allowances through a billed probe; Devin token and allowance metrics remain unavailable. Prompt counts begin with this collector's accepted sends. Existing token ledgers can contribute undated observed usage; neither those rows nor account limits prove complete Sotto-only or account-wide model history. Automatic side calls are not reconstructed.

Zach authorized the merge phase on October 13 after the local checkpoint: integrate current main, open the pull request, resolve CI and review feedback, merge with a merge commit once required checks pass, watch main's CI and remove the owned branch. Release publication, stable promotion and updating a real remote installation remain separate actions.

On October 13, the final reviewed implementation and fixture fixes are committed locally at `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`, following the integrated implementation at `c745c6e4a90193aa238ce9d97a9f97557066e327`. Both final review verdicts have zero unresolved findings. Durable numeric conflict floors preserve Grok uncertainty across duplicate replay, SQLite close/reopen and fresh adapters; complete native evidence repairs confidence and Clear deletes the floors. The final Usage journeys passed with all six headline controls revealed inside the minimum-width strip when focused. The first full suite exited 1 after 1,676.80 seconds: 795 files passed, 60 skipped and three failed; 10,084 tests passed, 299 skipped and eight failed. Its eight omitted expected-contract fixtures in three files are fixed, and 54 focused tests pass.

Actual Windows Owl host and desktop packages at `0.1.38-owl.20261013.1`, plus stable `0.1.37` directory probes, passed from exact `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`. The [combined package evidence](../../artifacts/usage-dashboard/package-verification.json) retains archive, installer and build provenance; the [packaged Owl capture](../../artifacts/usage-dashboard/usage-owl-package.png) was inspected. All four required gates passed at that local checkpoint. Its full suite started at 02:05:10 local time and finished with exit code 0 after 1,299.69 seconds: 798 files passed and 60 skipped; 10,094 tests passed and 299 skipped. Final evidence additions passed the local document checks, 257 tests with 10 skipped; the owned verification checkout was removed. The completed verification note and package evidence form the closing local commit. This is historical exact-source evidence, not a package result for the later main integration. No real macOS or Linux desktop or remote host installation has been verified: the read-only forge SSH attempt timed out, and one bounded noninteractive retry returned no platform metadata before its 12-second timeout.

## Authorized merge phase

The pre-PR integration checkpoint includes main `2ff23cc1db51c9a33c13a6f7d9f6ab08b1717b99` at `9d7b66b5b46b2e018570a18b3c0b36d9aa6274f3`. Usage's ADR is now 0076; the prototype choice and numeric boundaries are unchanged. Both fixed-head Standards and Spec reviewers report zero unresolved findings. Combined typecheck, lint and notices passed. The integrated full suite passed 10,207 tests with 316 skipped across 807 passing files and 63 skipped files, exit code 0 after 1,436.13 seconds. All five affected Electron journeys passed after rebuilding, and the lead and independent reviewer inspected the refreshed captures. The only subsequent source diff at `400d6cb7863752e523425ba32862c5b672e4dcf9` is the remote-command test's ADR comment changing from 0075 to 0076.

- [x] Integrate current main and resolve the ADR number collision.
- [x] Recheck the integrated fixed head on both review axes.
- [x] Run combined typecheck, lint and notices.
- [x] Complete the integrated full suite with two workers.
- [x] Rebuild and repeat the affected Usage and Claude-steering Electron journeys; inspect current captures and record actual Owl host, Owl desktop and stable preservation packages of source `400d6cb7863752e523425ba32862c5b672e4dcf9`.
- [ ] Open the PR and resolve required Windows CI and review feedback on its latest revision.
- [ ] Merge with a merge commit, confirm main's CI and delete the owned remote branch.

The earlier package JSON continues to identify source `1b013f26ea4a7fdaa4f9b2932203464f447ad8e2`; the [new integration package JSON](../../artifacts/usage-dashboard/package-integration-verification.json) identifies source `400d6cb7863752e523425ba32862c5b672e4dcf9`. No installation or publication has occurred. The remaining checkboxes record the pre-PR checkpoint; GitHub records the later required checks, review resolution and merge. Its current main ruleset requires Gates (Windows), Package result and Desktop result.

## Latest pull request checkpoint

[PR #985](https://github.com/millZach/Sotto/pull/985) is open. Main's paired-host Watcher changes subsequently required another integration, main `503991806efa249e12b33b9f3213c424afa5fc9f` at source `77b19c0965f5616413b3a1b410ad74fe6cf14f22`. The resolution preserves both host capabilities, independent Usage gating and ADR-0073's admitted headless worker on either track. A new real paired-host numeric test verifies four Watcher prompts and one user continuation across retries, steering, queue/now, changed model and restart.

Current typecheck, lint and notices passed; 257 focused tests and all 35 paired-host tests passed. Rebuilding and nine affected Electron journeys passed, including the Watcher gate. Both fixed-head review axes have zero unresolved findings; the five refreshed captures have no material visible defect. The [latest package proof](../../artifacts/usage-dashboard/package-watcher-merge-verification.json) pins actual Windows host, Owl desktop and stable preservation checks to `77b19c096`, separately from the earlier full-suite and package evidence. The verification note gives exact provenance and the physical macOS/Linux/remote gaps.

- [x] Open the pull request and integrate paired-host Watcher without changing the accepted design or numeric boundaries.
- [x] Complete focused cross-feature checks, fresh rendered journeys, both review axes and actual packages of the latest integration.
- [ ] Resolve main's failing iPhone Focus journey and all latest-head PR checks and feedback.
- [ ] Merge with a merge commit, verify main's CI and remove the owned branch.

The remaining states are recorded by GitHub after this checkpoint. No release, stable promotion or real installation is authorized by the merge instruction.

## Review follow-up checkpoint

All six public review findings are fixed at `b807d72`: indexed/cached archive reads, bounded batched pending recovery, incremental Codex bucket preservation, Claude partial-reading age/order, reuse of recent refreshable allowances on open, and explicit immutable host-version recovery. The combined twelve-file run passed 214 tests with one skip. Both fixed-head review axes have zero unresolved findings. Typecheck, lint, notices and twelve rebuilt Electron journeys passed, including real host conflict/backup/retry and the three terminal surfaces.

Main's Settings wording at `302f2c0` overlapped the shared contracts, so it was integrated without conflict at `82d6f9d`. Both bounded seam reviews report zero findings. Combined typecheck, lint, notices and build passed, followed by three Usage/host Electron journeys. The preceding iPhone rerun was canceled by this main push, so current GitHub checks remain the readiness source. The [verification note](../verification/2026-10-13-usage-dashboard.md) separates these results from earlier exact-source full-suite and package receipts.

- [x] Fix and independently review the six public findings; preserve exact accounting assertions.
- [x] Drive and inspect the host conflict, owner backup and successful retry in the real app at all sizes and themes.
- [x] Integrate current Settings wording, recheck the overlapping seams and repeat combined app checks.
- [x] Verify actual Windows host, Owl desktop and stable preservation packages of follow-up source `82d6f9d`; retain separate exact-source receipts and inspected captures.
- [ ] Resolve current GitHub checks and review threads.
- [ ] Merge, watch main's CI and clean the owned branch and verification checkout.

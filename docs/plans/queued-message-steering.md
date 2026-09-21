# Queued message steering

Add Steer now beside a saved queued message so it can join the running turn.

Acceptance checks:
- The action uses the saved queue item, including edits, images, skills and files; newer composer text remains untouched.
- Main claims the item durably before steering. Success removes it; refusal retains it; uncertain delivery cannot replay after retry or restart.
- Any queued item can steer, without reordering the remaining queue. Unsupported providers, pending requests and inactive threads cannot steer.
- Keep the desktop queue layout, Figtree, theme tokens and existing arrival/reduced-motion behavior. Add one plain action label, with keyboard focus recovery.
- Inspect dark and light at 1600x1000, 1280x800 and 820x560; no clipped controls. No new surface, artwork, typography system or signature motion is needed for this affordance.

State: implemented and verified locally. See ../verification/queued-message-steering.md for evidence and repository-wide check limitations.


Delivery checklist:
- [x] Isolate the steering fix on a main-based branch, preserving unrelated work.
- [x] Independent standards and spec reviews.
- [x] Typecheck, lint, notices and the steering Electron journey.
- [x] Complete the full CI-equivalent suite and document the neighboring baseline comparison.
- [x] Open PR #165 and fix the settled-project UI guard reported by review.
- [ ] Wait for latest-revision CI and review results.
- [ ] Merge with a merge commit once green.

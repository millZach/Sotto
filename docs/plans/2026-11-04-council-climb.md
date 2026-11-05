# Council Climb

Drake approved the amendment and controls mockup on November 4, 2026, then asked to build, open pull requests and merge. The amendment is now in [ADR-0177](../adr/0177-the-council-puts-one-question-to-threads-on-several-providers.md#climb-amendment-november-4-2026). This is the implementation handoff, not a new product proposal.

The detailed reports and approved mockup remain on the owner's Mac:

- `/Users/drakemorey/Developer/Reports/council-climb-plan-2026-11-04.md`
- `/Users/drakemorey/Developer/Reports/council-climb-adr-0177-amendment-2026-11-04.md`
- `/Users/drakemorey/Developer/Reports/council-climb-mockup-2026-11-04/index.html` and `REVIEW.md`

Those reports were reconciled with the mockup before implementation. Their historical citations name `541d1a1f`; the first branch started at fetched `origin/main`, `894240ead`. Inspect the current seam before using an older line reference.

## Approved behavior

Climb is domain-general. Design is a preset. Evidence comes from a Git working folder, an ordinary folder or selected artifacts; Git must not be a requirement of capture, judging, comparison or export. An existing local origin thread is the Builder; starting a fully folderless origin is outside this slice.

The existing Council tab in the thread pane's drawer owns setup, approval, progress, assessments and export. Ordinary Council remains available with its current workflow. Climb stays behind the existing `council` Owl gate; do not change `sentToStable`.

The approved mockup settles these details:

- Attempts and Model turns are sliders ending at **No limit**. Defaults are five attempts and 30 model turns. Both caps are optional.
- There is no spend cap or estimated cost in Climb. Progress shows completed and planned model turns.
- Explanations use tooltips that also open on keyboard focus and dismiss on Escape. Decisions and blockers remain visible.
- Admit seats one at a time in the approved roster's order. Do not sort by known prices: incomplete pricing must not silently reorder the user's roster or substitute another model.
- Without finite caps, target met, two completed attempts without meaningful improvement, and Stop still end the loop.

Setup proposes and the user approves one self-contained specification: goal, evidence recipe, criteria and constraints, judge roster, and target/stop rules. The initial roster has three eligible judges and a chair. Show selected evidence, recipients and limits before sending it.

Main owns the loop and every dispatch identity. Assess the baseline first. Then send a fix brief to the approved Builder, wait for that exact turn, capture the candidate, and assess it with fresh judges and a fresh adjudicating chair. The setup chair is never reused as an adjudicator. User activity in the origin pauses automatic sends. Recovery never resends an uncertain builder turn blindly. Stop records cancellation before dispatching more work and interrupts the Builder only if its active turn is the one Climb sent.

Each assessment receives the approved brief and complete frozen exhibits, with neutral letters and counterbalanced order. Keep the baseline visible; include the incumbent and optional fixed reference where needed. Identical content is shown once. Hide origin conversation, target thresholds, old scores, old verdicts and peers' answers from independent judges. The adjudicating chair receives only that round's judgments after they finish. File permissions alone are not a provider sandbox: a provider must enforce the read-only boundary or be unavailable for Climb judging.

Use a separate structured result contract; ordinary Council's idea scores are not Climb scores. Every required seat and criterion must return a valid result before success. Permit one format repair. Preserve dissent and incomplete evidence. The chair cannot waive failed requirements. Relative same-round improvement is the default; do not compare unmatched old raw scores as proof of progress. Absolute targets and fixed references remain available. Keep tradeoffs instead of averaging away regressions.

## Pull request 1: evidence foundation (slice 1a)

Merged as [#2195](https://github.com/millZach/Sotto/pull/2195), merge commit `3ff64513c`.

- Bounded regular-file and artifact capture, manifest hashes, exclusions, preview consistency and immutable canonical bytes.
- Default limits: 10,000 files, 100 MiB per set, 20 MiB per binary, 1 GiB retained per Climb. No silent truncation or partial published capture. Default-excluded ordinary files need explicit selection; `.git` is never copied.
- Manifest-backed citations, bounded paired-text and binary-change comparison, and export to a new folder containing `manifest.json` and `files/`. Existing destinations are refused.
- Owned disposable exhibit directories, separate from canonical storage and the Builder. The following PR must enforce the adapter boundary before using these for model work. This PR introduces no judge launch path.
- Version 2 history with source-neutral evidence identities and per-round references. A version 1 singleton becomes one `legacyGit` descriptor referenced by every old round; no singleton becomes `legacyLive`, without inventing historical evidence. Validate before migration, preserve an exact version 1 backup, write atomically, and refuse future or invalid versions without replacing the history. After a history-off save succeeds, remove the old backup so it cannot retain Council text.
- Keep ordinary Council's live-folder and Git worktree behavior. Existing ordinary rounds continue to reference their one source; they must not claim new captures.
- Clear temporary evidence, abandoned captures and disposable judge copies at startup. The loop's close/settle integration belongs in PR 2. Retained canonical evidence is not a judge's working directory.

## Pull request 2: panel-only Climb (slice 1b)

Built from updated main after #2195 and the independent CI repair #2197. The implementation admits only Claude’s enforced tool-free profile for judges; the Builder may use any existing local provider. The setup chair proposes criteria and constraints, with the remaining fields supplied by the user before approving the complete specification. Unsupported media and limits hold for a narrower new Climb; in-place specification revision remains later work. The artifact input uses explicit paths and supplied text.

- Source selection and preview, approved setup, frozen baseline, fresh independent judging, Builder continuation, candidate capture, all-required targets, no-improvement rule, optional limits and Stop.
- Main-owned durable loop state and exact delivery identities. Separate ephemeral form retention from the run record. Reconcile after restart; show held, uncertain and unavailable states truthfully.
- Enforced owned read-only judge profiles, never a fallback to the origin folder. Refuse unsupported adapters without silently swapping the model. Providers' ordinary permission requests still reach the user.
- Round evidence references, raw seat/criterion/exhibit results, same-round incumbent selection, kept rounds and export.
- Apply history-off cleanup at close/settle. No new prompt, transcript, result or key logging.
- Preserve drawer hide/show state, existing From/reply handoff, scrolling at minimum size, and lazy terminal loading. Opening Council starts no shell.
- Bring forward from 1c only the sequential admission and completed/planned turn accounting needed to honor the approved limits.

## Later slices

Command judges and their one bounded recipe grant per Climb need the companion ADR-0004 amendment and a separate owned runner. No command grant is implemented by these two PRs. Forks, in-place rollback, remote origins, detailed quota behavior and the rest of 1c are deferred. No new network host or key is authorized here.

## Verification and handoff

No local CI gates, Sotto launch, Playwright/e2e or design captures on this Mac. Windowless typecheck, lint and individual unit files are permitted. GitHub CI runs the full regression gates. Visual proof for PR 2 comes from forge or CI at the required desktop sizes, light/dark and reduced motion.

PR 1 checks capture without Git on PATH, exclusions and bounds, frozen citations and tamper refusal, binary changes, safe export and all migration variants. PR 2 adds provider fixtures for the complete loop, fresh contexts, hidden targets, exact builder delivery, Stop, user intervention, invalid scores, restart and history-off behavior, and no-Git drawer journeys.

After each push, end the turn. Watcher resumes the thread on CI failure or when the required checks permit merge. Merge with a merge commit once Gates (Windows), Package result and Desktop result are green and the branch has no merge conflict. Build the second PR from current main after the first merges. The request remains unfinished until both PRs are merged.

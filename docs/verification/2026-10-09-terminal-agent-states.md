# Terminal agent states

Issue [#883](https://github.com/millZach/Sotto/issues/883), following ADR-0066 and the owner's variant B. Verified on the Windows laptop on October 9, 2026, in `feat/terminal-agent-states`, based on `76c673cb`. The historical prototype and research note remain unchanged. Terminal state and the unread mark belong to main and to one run; native desktop answers stay in the CLI.

## Native boundary

The integration fixture launches fake Claude, Codex and Grok CLIs with the actual private launch configuration and Node-capable helper. It fires lifecycle hooks and Codex notify, holds a Claude Write permission connection and draws versioned native approval/question controls. Tests cover authentication, the 8 KiB allow-list, connection bounds, duplicate and stale IDs, exact one-time allow/deny, competing answers, delivery acknowledgement, uncertain delivery without replay, expiry and cancellation. Private content sentinels never appear in normalised frames; unknown tool/question shapes produce no decision. No desktop or phone answer API is added.

The running Electron app uses real Windows ConPTY and three owned PATH shims over that fixture. First use opens an agent through the New terminal dialog and types through xterm. Subsequent setup uses the ordinary preload bridge, without seeding agent states. The journey drives Working, Needs you, Just finished and Idle for all three providers, including native questions. It checks the cross-project order, the thread completion dot and bold title, the attention edge, keyboard selection, cancellation without completion, and that an unfocused visible split pane earns no unread mark. Minimising withdraws visibility; restoring clears a completion earned while hidden. Plain-shell, recovery, Closed/Reopen and shared pane-layout journeys run alongside it.

The app journey exposed and fixed legacy PowerShell stripping quotes at both hops of Codex notify. Literal TOML launch arguments and the private runner's base64 JSON transport preserve paths with spaces/apostrophes and notify bodies. It also caught Grok input echo reusing an old ready screen: completion now requires the native work widget followed by ready. Source and unit inspection additionally covered startup with absent/changed banners and split banners, keeping fallback conservative. Review regressions cover overlapping permission connections, conflicting Codex session IDs, quoted native controls, resize invalidation and both delivery orders of Claude Stop and ready output. A visible completion observation survives hiding and a queued work redraw, while genuine continued work can earn a later unseen completion. Turn-bound tool evidence can bind a local submission before its submitted hook arrives; a late submitted hook for that same turn preserves completion and viewed readiness. A successful Stop without its own turn ID retires the known active turn, and late tool callbacks cannot revive cancelled work.

## Visual evidence

The lead inspected all seven retained app screenshots. Needs you and Working keep the project on the right, including selected rows. Just finished uses the existing thread ring with a filled centre and bold title. The 820px layout shows one pane with tabs; hidden panes withdraw visibility. The narrow sidebar rule was corrected after inspection found project and completion text squeezed into a second-row cell. The journey now asserts those labels fit, as well as viewport bounds and no document overflow.

| Content size | Dark | Light |
| --- | --- | --- |
| 1600x1000 | [Sidebar and two panes](../../artifacts/terminal-agent-states/states-1600x1000-dark.png) | [Sidebar and two panes](../../artifacts/terminal-agent-states/states-1600x1000-light.png) |
| 1280x800 | [Sidebar and two panes](../../artifacts/terminal-agent-states/states-1280x800-dark.png) | [Sidebar and two panes](../../artifacts/terminal-agent-states/states-1280x800-light.png) |
| 820x560 | [Sidebar and approval pane](../../artifacts/terminal-agent-states/states-820x560-dark.png) | [Sidebar and approval pane](../../artifacts/terminal-agent-states/states-820x560-light.png) |

A design pass then inspected the same captures against variant B and fixed three things, and the captures above are from its rerun. The attention edge sat on the pane header, which a split narrows for the layout controls, so it stopped short of the pane's corner; it now runs the whole pane top and replaces the focus edge on a focused pane, and the pane region and its compact tab are named "<title>, needs you". An empty project folder said "No other open terminals." even when it never had one; only a folder that lent a row to Needs you or Working says "other" now. The unknown-version note followed the per-frame screen match, so it would come and go while typing and resize the terminal each time; main now publishes compatibility per CLI version and the note sits in the status line.

[Viewed terminals at Idle](../../artifacts/terminal-agent-states/viewed-idle.png) shows both completion marks cleared. [Geometry and contrast measurements](../../artifacts/terminal-agent-states/geometry.json) record all six size/theme combinations. The lowest measured sidebar text ratio was 5.06:1 dark and 5.28:1 light, above 4.5:1. The working ring animates under system/no-preference and has no animation with reduced motion on; retained captures use reduced motion.

`npm run design:capture` was run deliberately: 10 tests passed and 152 exact design-review tuples verified. Its existing matrix has no Terminal-mode agent-state view; this branch's six new views are retained above. Recapture changed only an unrelated onboarding loading phase and 5–20 raster pixels on six existing screens. Those incidental changes were inspected and restored to their approved baselines. The final baseline manifest still verifies all 152 tuples.

## Compatibility and limits

Bundled rules admit Claude Code **2.1.295**, Codex **0.162.0** and Grok Build **1.0.50** only. Claude's question component was inspected in the locally installed previous 2.1.295 binary. Codex's controls follow its [versioned request-user-input implementation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs) and [timed status widget](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/status_indicator_widget.rs), including its reduced-motion form. Grok's installed binary and bundled keyboard guide corroborate its [permission view](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/views/permission_view.rs), [question view](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/views/question_view.rs), [focused control hints](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/app/agent_view/render.rs) and [turn-status widget](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/views/turn_status.rs). Grok rules require the card's rail, radio or checkbox rows and a complete current footer, whether focused or parked. Upstream Grok source is not a versioned 1.0.50 tag; the installed binary supplies that release's Other-input label. A native Grok startup-only probe confirmed its bordered ready prompt and footer without sending a model turn. Unversioned/unmatched screens and changed versions report unavailable detection and use conservative activity; they cannot invent a request or unread completion.

These are source inspection, synthetic provider-boundary tests and built-app desktop evidence. No paid native turn, installed package, macOS or Linux desktop was exercised. The iPhone Host feature and approval preview remain proposed in ADR-0066 and outside #883. ADR-0066 now explicitly admits a closed, normalised hook work-phase enum to distinguish fresh or continuing work from late tool callbacks, and records the implemented desktop scope. That metadata refinement changes no content, authority or approved state/visibility rule.

## Earlier implementation gates and review

The earlier lane recorded source and tests at `6ad14d666`, with the terminal implementation unchanged from `a4d837045`. These results are historical; the final remediation below supersedes that handoff:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0; all three TypeScript projects |
| `npm run lint` | PASS, exit 0; no errors or warnings |
| `npm test -- --maxWorkers=2` | FAIL, exit 1 on `a4d837045`; 627 passed, 51 skipped and one failed file (679); 9,360 passed, 222 skipped and one failed test (9,583); 1,471.12 seconds |
| `npm run notices:verify` | PASS, exit 0; 174 components |
| Build and affected Playwright specs below | PASS, exit 0; all four build targets and six tests in five specs, one worker, 1.1 minutes |
| `npm run design:capture` | PASS; 10 capture tests, followed by 152 verified tuples |
| `node scripts/verify-design-captures.mjs` after final app captures | PASS, exit 0; 152 exact tuples |

The final build and app command was:

```sh
npm run build && npx playwright test tests/e2e/terminal-agent-states.spec.ts tests/e2e/terminal-loading.spec.ts tests/e2e/terminal-closed-output.spec.ts tests/e2e/pane-layouts.spec.ts tests/e2e/split-workspace.spec.ts
```

The new terminal-state journey passed in 24.5 seconds. `terminal-loading.spec.ts` supplies two cases; each other spec supplies one. All seven retained images above were inspected from this final run. Adjacent specs also regenerated their own existing evidence; those unrelated captures were restored, and the approved design manifest verifies.

The full suite's sole failure was `threadTitles.test.ts`, "names a thread whose reply streamed in while the turn was still running, once the turn ends": its fixture published the reply as Idle before immediately switching to Running. The coordinator could legitimately request a title from the first frame before the test asserted no request. The unchanged file passed once here and 21 times in a freshly installed, clean `origin/main` checkout at `cc732e398`; those ordinary runs did not reproduce the intermittent failure. A temporary controlled refresh between the fixture's Idle and Running frames forced the same premature call on main. The single-case reproduction failed one test with 17 skipped; the whole file failed that one test with 17 passed. This is scheduling evidence, not a claim that an unmodified main run failed.

Commit `6ad14d666` publishes reply and Running together, preserving the later Idle transition and exact single-title assertion. The isolated regression passed (one passed, 17 skipped), and the full title file passed all 18 tests. No production title code changed. The diagnostic refresh was removed and its owned baseline worktree deleted. The original full-suite failure is retained above. That earlier handoff ended without a fresh full-suite pass; the final remediation below records the newly authorized run.

Independent read-only `gpt-6.1-sol` reviews at maximum reasoning checked Standards and Spec separately over the feature and follow-up diffs through `207377665`.

**Standards.** Findings about current native controls, resize invalidation, competing permissions, conflicting IDs, visibility and cleanup have fixes and regressions. No accepted Standards finding remains unresolved.

**Spec.** Findings about completion delivery order and current-turn binding have fixes and regressions. Both axes confirmed rejection of one interpretation that viewing known ongoing continuation should suppress its later hidden finish: it remains Working, and paired tests distinguish that from viewing after an admitted successful Stop. No accepted Spec finding remains unresolved.

The last reported mixed-ID and late-submission findings were fixed in `71d18425e` and `a4d837045`; the final state file passes all 84 regressions. The lead inspected those final fixes and the title-fixture correction; the independent reviews do not claim a new review of the final evidence commit.

## Final review remediation and gates

The owner authorized the final fresh full run, push and pull request on October 9. Dependencies were installed with `npm ci` in this worktree; no dependency junction was used. Final source is `2fe9391cf`. Every one of the eight supplied Standards/Spec findings was reproduced and fixed in its own commit. No supplied finding was rejected.

- Historical approval/question examples require current footer controls, including while typing beneath them.
- Native Codex empty composers use their versioned placeholder. Claude and Codex approvals remain Needs you at every selection position.
- Cancellation and permission hooks reject older turns. Cancellation closes only that turn's permission sockets; an unbound session end closes the run.
- Earlier Codex notify callbacks cannot settle a new reservation or consume visibility during newer native work. Consistent session candidates still bind only on readiness.
- Successful Stop with unavailable screen rules settles conservatively to Idle, without an unread mark. Silence alone keeps known work Working.
- Fenced work examples are excluded. Current failures are read at the result row, so historical interruption text cannot cancel a later successful turn.
- Keyboard focus follows the terminal and row action across groups, including returning to a collapsed project, and respects focus moved elsewhere. A throwaway copy of the approved B prototype verified the focused row through Working, Needs you and Idle; the historical prototype stayed unchanged.
- The app run found Grok stuck Working when ConPTY coalesced work and ready screens. Full clears and home/erase redraws now observe intermediate frames written in that event, without resurrecting a previous frame invalidated by input. Claude, Codex and Grok regressions cover this boundary.
- The affected pane-layout run exposed a saved draft being cleared by a queued older empty publication. A save reply confirms durability without marking the revision observed; publication supplies that separately. The draft/reload checks pass 60 tests and the Electron journey checks all three drafts after setup.
- The recurring Claude finish failure was reproduced as a delayed submitted hook arriving after native work and readiness. The awaited hook now binds its turn without restarting work or losing viewed readiness. The fixture scripts that ordering for the minimized-window journey; no timeout was increased.
- The final Spec follow-up found the neighboring order where successful Stop precedes that submitted hook. Completion is now retained as bounded opaque turn candidates until a matching submitted/tool hook corroborates it. New submission, request, failure, cancellation and continuation revoke those candidates; stale/unbound Stop still cannot settle work.

The fresh independent Sol (`gpt-6.1-sol`, maximum reasoning) reviews returned two Standards and two Spec findings: stale permission, historical failure, partial redraw and late-notify visibility. All were accepted, reproduced and fixed. The follow-up Standards review identified the invalidated pre-clear frame; that was also reproduced for all three providers and fixed. The follow-up Spec attempt initially failed because its shell helper could not refresh setup, then succeeded on its one retry with no unresolved Spec finding. Final bounded follow-ups found no Standards or draft-correction defect; the Spec reviewer found early Stop before late submitted evidence. That final finding was accepted, reproduced and fixed with both delivery orders and revocation regressions. The state file passes 116 regressions. No current review finding was rejected. The final corroboration fix was checked by the lead and the final gates, not a further independent review.

| Final gate | Result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0; all three TypeScript projects |
| `npm run lint` | PASS, exit 0; no errors or warnings |
| `npm test -- --maxWorkers=2` | PASS, exit 0; 9,399 tests passed, 222 skipped (9,621); 628 files passed, 51 skipped (679) |
| `npm run notices:verify` | PASS, exit 0; 174 components |
| `npm run build` | PASS, exit 0; main, host, preload and renderer |
| Five affected Playwright specs with `--workers=1` | PASS, exit 0; six cases |

Full-suite duration: 1283.34s (transform 24.15s, setup 94.20s, import 171.82s, tests 2007.50s, environment 158.87s). It ran once in this finishing pass, after the corrections and app verification. Earlier affected app runs returned 5 passed/1 failed (Grok completion), 5 passed/1 failed (pane draft), and 4 passed/2 failed (pane draft and Claude completion). The pane spec passed in isolation between the latter runs, which did not resolve its cause. Each failure was reproduced and fixed at its cause before the final combined run. The final native journey scripts delayed Claude submission admission rather than relying on machine load. No deadline was changed.

The five specs are `terminal-agent-states.spec.ts`, `terminal-loading.spec.ts`, `terminal-closed-output.spec.ts`, `pane-layouts.spec.ts` and `split-workspace.spec.ts`. The final built Electron journey covers first use, native requests/questions, cancellation, keyboard regrouping and Enter, hidden finishes, visible unfocused splits, minimising/restoring, light/dark, reduced motion, contrast and bounds at all three specified sizes. All seven retained final images were opened and inspected. The six geometry/contrast combinations passed with no clipping or overflow. Terminal captures were regenerated for the final journey; adjacent capture changes were restored to their approved baselines. The approved design manifest still verifies all 152 tuples.

VERIFIED: the final built Windows Electron app over native ConPTY and synthetic provider CLIs. Installed packaging, paid native provider turns, macOS and Linux remain NOT VERIFIED in this pass. The existing xterm scrollbar appearance is outside #883. Compact tabs retain their accessible Needs you name; the sidebar supplies visible state, preserving the issue's quiet pane chrome. No phone feature or Sotto approval controls were added.

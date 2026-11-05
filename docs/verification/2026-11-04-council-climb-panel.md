# Council Climb panel and loop

November 4, 2026. Slice 1b follows the evidence foundation merged in
[#2195](https://github.com/millZach/Sotto/pull/2195), from main at `6391e061a`.
The independent SSH fixture repair in
[#2197](https://github.com/millZach/Sotto/pull/2197) is already in that base.

## Windowless checks

- `npm run typecheck` and `npm run lint`: clean.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/main/council/climb.test.ts`:
  9 passed. Covers setup approval, baseline, fresh matched assessments, selected
  text without Git, all-seat targets, lower-is-better guardrails, two unsuccessful
  attempts with no caps, one format repair, user activity, exact-turn Stop,
  uncertain recovery, history-off records, frozen citations and export refusal
  for an existing folder. A scripted Claude subprocess proves empty tools and
  configuration, denied tool requests, and process release through the Sotto
  thread identity. A workspace fixture proves judges skip Git, checkpoints and
  side writing. Judge choices reject Ultracode's multi-agent workflow.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/main/council/councilEvidence.test.ts`:
  22 passed, including capture, comparison, export and history migration.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/main/codeSizeBudget.test.ts`:
  3 passed. No allowance was raised.
- `npm run i18n:extract` completed; generated catalogs are included.
  `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/shared/interfaceCatalogs.test.ts`:
  4 passed.

These targeted checks do not establish a full CI or desktop pass. No app,
Playwright journey, full suite or design capture was run on the owner's Mac.

## Desktop evidence pending in CI

`tests/e2e/council-climb.spec.ts` is included in the selected desktop smoke
journeys. It uses the scripted provider with a real plain folder and the real
main-process Climb service. It checks focus/Escape tooltips, both No limit slider
endpoints, retained form state, preview, explicit setup approval, Stop and that
opening the Council starts no shell.

Inspect the desktop run's `council-climb/` images before claiming visual
verification: `setup-<width>-<theme>.png`, `limits-<width>-<theme>.png` at
1600×1000, 1280×800 and 820×560 for light and dark with reduced motion;
`proposal-820-light.png`; and `geometry.json`. No screenshot or geometry result
is claimed here before that run completes. These are CI artifacts, not new
committed design baselines.

## Review and scope

The standards review checked the Council Owl boundary, main-only dispatch,
existing Builder permission path, cancellation during provider preparation,
history-off cleanup, Sotto/native thread identity, and no Git or side calls for
judges. The spec review checked the approved mockup's domain-general setup,
optional caps, no cost controls, fresh judges, all-required targets, no-improvement
rule and export to a new folder.

Claude and Codex judges are available together on Mac/Linux when their isolated
read-only launch can be confirmed; Windows currently admits Claude only; other providers remain available for the Builder. The setup chair proposes the
rubric and constraints; the user supplies and approves the remaining fields.
Selected artifacts use explicit paths and supplied text. Unsupported media or
oversized evidence requires a narrower new Climb. These first-slice limits are
recorded in ADR-0177 and the plan. Commands and recipe grants, forks, rollback,
remote origins and the rest of slice 1c remain out of scope.

## Codex judge boundary

The follow-up admits Claude and Codex in the same panel. Codex uses a separate
app-server and private home for each ephemeral judge, with only its file-backed
login copied in. Its named permissions profile grants reads only below the
frozen judge directory, denies writes and network access, and never requests
approval escalation. Sotto sends frozen text and image bytes inline; it installs
no dynamic tools or MCP servers, and disables inherited instructions, hooks,
skills, plugins, apps, web, shell, memory and delegation tools.

Before startup and every send, Sotto verifies effective configuration, empty
hook and enabled-skill inventories, and empty MCP inventory. The started thread
must confirm the exact directory, named profile, read-only sandbox without
network, `never` approval policy and no instruction sources. Missing confirmation
is a refusal. A changed profile or any tool/approval request stops the judge.
Its private home is removed only after its process closes.

Published sources checked on November 4, 2026:

- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
  and [configuration reference](https://developers.openai.com/codex/config-reference).
- [Codex 0.166.0 thread protocol](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs):
  named `permissions`, `activePermissionProfile`, `instructionSources` and
  approval policy. Installed CLI-generated experimental schemas were also read.
- [Permissions compilation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/config/permissions.rs):
  an explicit profile starts with restricted filesystem access. The ordinary
  `read-only` profile grants wider reads and is not used here.
- [Windows sandbox implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/windows-sandbox-rs/src/lib.rs)
  and [readiness](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs):
  restricted reads require the elevated backend. Readiness is scoped to the
  Codex home, so an ordinary home's setup does not establish the isolated home's
  readiness. A fresh isolated home is unready, so Windows Codex judging cannot
  start in this implementation. It never reuses the ordinary home, substitutes
  the weaker restricted-token mode or approves setup. Drake chose to ship verified
  Mac/Linux judges and defer Windows support; the picker and main both exclude
  Windows Codex judges.

A windowless probe of installed `codex-cli 0.166.0` initialized an app-server in
an empty private home and started an ephemeral thread without sending a model
turn. It confirmed the exact custom read profile, read-only/no-network sandbox,
`never` approval policy, empty instruction sources, hooks, skills and MCP list.
The probe exposed CLI key quoting and nullable profile metadata; the final
serializer uses TOML inline objects and the verifier tolerates only unset null
metadata. No Sotto process or desktop window was launched. This checks startup
reporting on macOS, not model quality or Windows sandbox provisioning.

Focused follow-up checks:

- `tests/unit/main/council/codexJudge.test.ts`: 15 passed. Covers private login-only home and scrubbed
  environment, exact configuration serialization, missing/widened startup
  settings, wrong workspace, inherited instructions, extra read roots, writes,
  hooks, skills, MCP, unready Windows sandbox, native approval refusal, process
  cleanup and no resume after stop.
- `tests/unit/main/council/climb.test.ts`: 9 passed. The successful complete loop now seats
  Claude and Codex judges together, including a Codex chair, baseline and fresh
  candidate assessment, then exports the kept round. Windows refuses a Codex
  roster before dispatch; the shared eligibility rule also excludes other providers.
- `tests/unit/renderer/pointerCursor.test.ts`: 3 passed after removing the two conflicting cursor rules.
- `tests/unit/shared/interfaceCatalogs.test.ts`: 4 passed after extraction.
- `tests/unit/scripts/desktopSmoke.test.ts`: 13 passed after merging main; the
  selected journeys retain main's host-client and Update all checks alongside Climb.
- `tests/unit/main/codexConfirmation.test.ts`: 8 passed; existing permission
  confirmations still require an explicit answer.
- The setup shows both providers and resets effort when switching models.
  Ordinary Councils and the Council Owl gate are unchanged.

Grok's Sotto adapter was checked for its existing session and permission-mode
confirmation. It has no equivalent Climb launch profile proving frozen-only
reads, empty tools and no inherited instructions. Grok and the remaining
providers stay outside the change; they need provider enforcement plus the
same startup/readback and refusal tests before admission. No claim is made that
all other providers' current upstream clients were audited.

## Failed-run receipt for 27ff139

[Run 41954875966, attempt 1](https://github.com/millZach/Sotto/actions/runs/41954875966)
ran head `27ff139ee8eb1c32683cdfabfdf5766e9ca9f71f` through PR merge
`c326ff7df4df7b17d5c5946ce3de25a3c498a487`, with base
`db07bf42b55fe2f00a29904835fdf1cf2719e768`. Both underlying failures are
**own-diff**, not confirmed flakes, pre-existing failures or unknowns.

| Job | Assertion | Classification and evidence | Repair |
| --- | --- | --- | --- |
| [Tests (Windows, 1/6), 127007454414](https://github.com/millZach/Sotto/actions/runs/41954875966/job/127007454414) | `pointerCursor.test.ts`: “is the hand in one rule only, for links, in global.css” | Own-diff. The assertion's received array adds `.climb-panel button` and `.climb-panel summary` from this PR's `council.css`. | Remove those two `cursor: pointer` declarations; keep the global pointer rule and assertion. |
| [Checks and desktop (Windows), 127007454270](https://github.com/millZach/Sotto/actions/runs/41954875966/job/127007454270) | `council-climb.spec.ts:29`: click Council | Own-diff. The log times out after 30,000 ms waiting for `getByRole('button', { name: 'Council', exact: true })`. This new test did not enable `council=1`; source builds are stable, so the Owl gate correctly omitted the button. | Enable the Council Owl override only for this test's launch, then restore the environment. Do not weaken the production gate. |

Gates (Windows) and Desktop result are downstream failure summaries, not extra
failing assertions. Package result passed. The desktop artifact's error context
was read; this failure precedes opening Climb, so it supplies no Climb screenshots.
Neither repair was already on main. Main `45c799471f460bc1da1f7a609783aaf33cafdd35`
was merged to resolve the reported base conflicts in the same push as the repairs
and Codex judging. The resolution retains main's desktop journeys and Dynamic
thread notes while excluding those notes from Climb judges, preserves the Council
runtime gate, and regenerates the combined interface catalogs. Typecheck, lint,
the 15 Codex judge cases, the 9 Climb loop cases, the 13 desktop-selector cases and
the 4 catalog cases passed on the merged tree. No failed job was rerun. CI must
run the desktop journey and provide the pending screenshots before a
Watcher-directed merge.

## Failed-run receipt for f203eec

[Run 42041544734, attempt 1](https://github.com/millZach/Sotto/actions/runs/42041544734)
completed at head `f203eec7e60c28e2dc5be7b8c09d72554a342be2`, testing merge
`608c3aaea334bff1423a6a9b984c7d8c492e48dc` with base
`45c799471f460bc1da1f7a609783aaf33cafdd35`. It has one underlying failing assertion.

| Job | Assertion | Classification and evidence | Repair |
| --- | --- | --- | --- |
| [Checks and desktop (Windows), 127293668928](https://github.com/millZach/Sotto/actions/runs/42041544734/job/127293668928) | `council-climb.spec.ts:76`, “Climb keeps its setup in the Council drawer, previews a non-Git folder and requires approval”: `Preparing proposal` must be visible after asking the chair. | Own-diff. The new journey uses `composer-speed`. Its model has `providerId: 'claude'`, but the pre-existing Workshop thread has no provider ID. The artifact's error context reports “Choose an open local project thread as the builder.” This matches Climb's required local-provider guard, before any chair dispatch. | Give the fixture's existing threads their Claude provider identity. Keep the production guard and the desktop assertion. |
| [Desktop result, 127299131148](https://github.com/millZach/Sotto/actions/runs/42041544734/job/127299131148) | The required desktop journeys must pass. | Downstream of the same own-diff failure, not a separate defect. Its log says “The desktop journeys were needed and ended failure.” | Cleared only by a passing desktop run after the fixture repair. |

Gates (Windows), all six Windows test shards and Package result passed. The
current base still has the same incomplete fixture metadata; it has no repair
to merge. No assertion is classified as a flake, unknown or pre-existing on main,
and no failed job was rerun.

The [desktop artifact, 13424266316](https://github.com/millZach/Sotto/actions/runs/42041544734/artifacts/13424266316)
contains all twelve setup and limits screenshots. They were inspected at all
three sizes in both themes: the panel remains within its scroll area, the
controls fit, and the limits show No limit without cost controls. The minimum
window needs scrolling to reach the form and its final action. The test passed
its focus/Escape, form-retention and geometry assertions before failing at
proposal dispatch. It did not reach setup approval or write `geometry.json`;
those screenshots and the complete journey remain pending in the next CI run.

Only the fixture and this evidence note change in this repair. No desktop app,
Playwright test or full suite was run locally. The existing desktop journey is
the regression check on GitHub; no production behavior or allowance is changed.
`npm run typecheck` and `npm run lint` passed on the repaired tree.

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

Only Claude judges are available because its tool-free launch mode is enforced;
other providers remain available for the Builder. The setup chair proposes the
rubric and constraints; the user supplies and approves the remaining fields.
Selected artifacts use explicit paths and supplied text. Unsupported media or
oversized evidence requires a narrower new Climb. These first-slice limits are
recorded in ADR-0177 and the plan. Commands and recipe grants, forks, rollback,
remote origins and the rest of slice 1c remain out of scope.

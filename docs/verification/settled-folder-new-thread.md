# New work in a settled folder

Verified on Windows, September 20, 2026, on an isolated branch from main at `80b2207ec46c2e66d008ddc0f9de69a1b6646e2b`. Tracks [issue #171](https://github.com/millZach/Sotto/issues/171).

Creating a new thread in a settled project now returns the folder to the active sidebar with only that new thread. Older threads stay under that folder in Settled. The sidebar already supports both groups, so no renderer markup, style, copy or motion changed.

The project-wide settlement flag previously applied to new threads as well as existing ones. Creation now preserves its timestamp on older threads without individual settlement, clears the project flag, and saves the transition with the new thread. Existing individual timestamps and other projects are unchanged. Failed creation restores the prior grouping.

## Verification

- The original regression failed before the fix: a new thread was settled (expected false, received true).
- `npm run typecheck`, `npm run lint`, `npm run notices:verify`, and `npm run build`: passed on the isolated branch.
- `npm test -- --maxWorkers=2`: 4,119 passed, 34 skipped (312 files passed, 17 skipped).
- Workspace and controller suites after the review fix: 32 tests passed.
- `npx playwright test tests/e2e/settled-folder-new-thread.spec.ts --reporter=list --output=artifacts/settled-folder-new-thread/playwright`: 1 passed on the final build. The separate output directory avoids unrelated preview logs held open in the primary checkout.

The Electron journey settles a project, opens New thread with keyboard Enter, chooses the same project, creates a thread and checks the disjoint groups. It reloads the renderer and restores an older thread through its hover action. Main-process restart persistence, provider refresh, other-project isolation and failed saves are covered by workspace regressions.

## Review

Standards: no findings. Spec: one confirmed failure-race finding, fixed before opening the PR. Creation and settlement edits now share a per-project organization lane, so one failed operation cannot restore another operation's temporary timestamp. Provider work retains its existing independent lanes. The parameterized regression passed for both individually settled and unsettled old threads. The independent re-review reported no remaining findings.

The code-review skill's configured Claude reviewer model was unavailable in this session; two available read-only agents ran its separate Standards and Spec briefs.

## Rendered evidence

Inspected dark and light at 1600x1000, 1280x800 and 820x560, plus reduced motion. New work appears alone in the active folder; Docs and Workshop remain under Settled. There is no sidebar horizontal overflow at any checked size. Existing Figtree hierarchy, theme roles, text and motion are preserved. No production text elements were added; repeating the project name identifies two distinct thread groups. Existing typography and contrast tokens are unchanged.

Captures in `artifacts/settled-folder-new-thread/`: `dark-1600.png`, `dark-1280.png`, `dark-820.png`, `light-1600.png`, `light-1280.png`, `light-820.png`, `reduced-motion.png`, and `contact-sheet.png`.

The throwaway behavior prototype was rendered and exercised, then preserved locally on `prototype/settled-folder-new-thread` at `36b6f459aca1ee01195acad3e944d76bde371221`, file `docs/prototypes/settled-folder-new-thread.html`. Its screenshot is `artifacts/settled-folder-new-thread/prototype.png`; the HTML is absent from the implementation branch.

No installer was produced or installed. macOS was not exercised; no platform-specific production code changed. Existing hidden threads are not migrated: the corrected behavior applies when creating a new thread.

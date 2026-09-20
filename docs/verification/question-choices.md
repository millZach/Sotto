# Questions above the composer

September 20, 2026. Approved reference: question-choice prototype A, as shown in the current conversation and then approved with "Awesome lets go with that."

## Result

Pending thread questions now appear directly above the message bar. The existing request component and answer store provide stacked native choices, a recommendation marker only when the provider supplies one, a visible custom-answer box, and explicit Send answer. A custom answer is independent of the general message draft. Typing or choosing does not submit; Enter inserts a line in the answer, and native arrow keys keep traversing the radio group. Escape collapses the panel with focus on Show question, and reopening retains the answer.

Native option and question IDs are preserved. Multi-select and optional fields, provider-only fields, draft saves, save failures, refused answers and uncertain-delivery holds retain their existing behavior. Legacy option questions also require selection followed by Send answer. Free-text-only unstructured requests still use their existing text-answer path. Permission requests retain their native choices in the transcript.

The panel scrolls independently with a visible Send answer footer and rounded outer boundary. In a split pane shorter than 420 CSS pixels, an expanded question temporarily uses the history area and the general draft becomes one scrollable line. Collapsing restores the history without remounting it. If pending permissions or saved-answer recovery share that short pane, history stays visible and the pane scrolls between bounded history and question regions. This adjustment follows the minimum-pane failure found during verification; it does not affect the normal full-height layout.

## Evidence

- Renderer checks cover the dedicated answer box, no preselection, whitespace rejection, custom-text retention after another choice, Enter not submitting, native radio arrow wrap, Escape focus restoration, exact recommendation option IDs, and explicit legacy-choice sending.
- Theme checks cover the request stylesheet and recommendation contrast on field/selected surfaces for every built-in light/dark theme, at least 4.5:1.
- Electron journeys cover actual IPC submission, simultaneous forms in different threads, native approval choices, disconnect/refusal/held delivery, full restarts, failed saves, recovery, and personal questions.
- Captures live in `artifacts/question-choices/choices-<width>x<height>-<appearance>-<motion>.png`, with widths/heights 1600x1000, 1280x800 and 820x560. `choices-820x560-light-send-focused.png` checks the visible final action; `choices-short-stacked-pane-dark.png` checks a short row in a three-pane workspace.
- Three representative captures are committed: desktop dark, minimum-size light with Send focused, and a short mixed-request pane with permission focused. Other captures remain local and reproducible from the Playwright spec.
- Main-agent rendered review inspected the desktop stacked choices, recommendation and dedicated custom box, plus minimum-size light mode and the short-pane layout. Initial clipping was repaired by allowing the composer region to shrink. The footer remains available while choices scroll. Final minimum-window light and short-pane dark captures were inspected after the spacing fix: the question boundary, Send action, composer and metadata are contained. The short-pane test also clicked a lower choice and custom field, collapsed and reopened, and sent once.

Tastify checks: existing Figtree and theme roles preserve Sotto's identity. The question and native answers lead; accent marks the recommendation and selection. The custom box belongs to the question and the general draft stays below it. No new imagery or display typography is appropriate for this scoped control. The reference's brief upward arrival is retained; OS and Sotto's reduced-motion setting remove it. Copy is the question, supplied choices/descriptions, recommendation qualifier, custom-answer label, send action and required draft/delivery state. The provider's descriptions are retained as decision information; controls and state feedback are necessary exceptions to the five-element budget. No duplicated question heading is visible for a single-field form.

## Checks

The PR is validated in `.worktrees/question-choices`, based on main at `e29cd544`. Concurrent Agents, queue, monitoring and theme changes in the shared checkout are excluded.

- Typecheck and lint: passed.
- Third-party notices: passed, 174 components.
- `npm test -- --maxWorkers=2`: 305 files passed, 17 skipped; 3,972 tests passed, 34 skipped. No failures.
- `npm run build` and the four affected Playwright specs: 15 passed (five question/permission/layout journeys, ten draft restart/recovery/personal journeys).
- Build: passed.
- Scoped git diff whitespace check: passed.

Separate reviews covered standards and requested behavior. Findings addressed: preserve native radio navigation, share the composer-focus callback, verify/fix short split-pane geometry, and repair the isolated theme-test insertion. The mixed question/permission short-pane regression passes, including keyboard hit-testing, exact submissions, and retention of both selections and the independent message draft. Final spec review confirmed both findings resolved; standards review has no outstanding findings.

## Delivery state

The user authorized a PR, monitoring through green checks, and merge when green. The implementation branch is `feat/question-choices`. Local gates and both review axes are complete; hosted checks and merge state are recorded by the pull request. No package was installed or released. Electron verification uses deterministic local provider fixtures, not a paid live-provider session. No new host, dependency, setting, logging or permission grant was introduced. macOS was not available for native validation.

Prototype source is preserved on local branch `prototype/question-choices-a`, commit `f87b6ba83b79865834d55a8a5ae6d41ecaebbdd6`, based on main. The archive includes only the three-layout HTML, its local runner and the implementation decision/checklist. The shared checkout and its unrelated staged work remain untouched.

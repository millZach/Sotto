# New thread setup A

Zach chose the Direct choices prototype. Implemented one Project folder / New worktree / Existing worktree group, a combined local/origin Start from picker, collapsed thread options, and a separate creation footer. Project defaults now live in Settings > Application. The local comparison is archived on `prototype/new-thread-setup` at `9cee35a9477694ae159aaf6607ac951a96a7e50f`.

## Verified on Windows

- `npm run typecheck` and `npm run lint`: passed.
- `npm test -- --maxWorkers=2`: 324 files passed, 17 skipped; 4,213 tests passed, 34 skipped.
- `npm run notices:verify`: passed, 174 components.
- `npm run build` then `npx playwright test tests/e2e/thread-worktrees.spec.ts tests/e2e/thread-creation.spec.ts tests/e2e/new-thread-settings.spec.ts tests/e2e/thread-agent-inheritance.spec.ts tests/e2e/devin-provider.spec.ts --workers=1`: all eight journeys passed on the final build.
- Follow-up focused checks after terminal and folder-registration fixes: 18 tests passed; the updated legacy dialog, new-thread, Providers and shared-default checks passed 76 tests. The full-suite run began before the eight new terminal/folder regressions were added.
- `npx vitest run tests/unit/renderer/themeTokens.test.ts --maxWorkers=2`: 43 checks passed, including 4.5:1 text contrast against theme surfaces and stylesheet token ownership.

The Electron journeys cover shared checkout creation, lazy independent setup, local branch selection, existing worktree reuse, changes before first send, failed setup/draft recovery, branch notices and restore, model/effort/permission selection, attachments, settings save/inheritance, keyboard creation, Escape and focus restoration. A deferred-settings regression also verifies that loading defaults does not steal focus from the name field. New terminal retains its original scrollable form layout.

## Rendered evidence

Captured dark/light and reduced/no-preference motion at 1600x1000, 1280x800 and 820x560. Both the optional-model summary and Create thread are asserted in the viewport. Inspected the final minimum-size dark dialog, typical light dialog, minimum-size project-defaults settings and terminal dialog; controls do not clip horizontally. Long project paths truncate with their full path available as a title. Expanded thread options scroll inside the body while Create thread remains outside the scroller.

Selected evidence in `artifacts/new-thread-setup/`:

- `new-worktree-820x560-dark-no-preference.png`: the minimum window with the working-copy choice, source, model summary and action visible together.
- `new-worktree-1280x800-light-no-preference.png`: the light theme and dialog hierarchy.
- `new-worktree-1600x1000-dark-reduce.png`: large desktop and reduced-motion state.
- `project-defaults-820-dark.png`: project selection and per-project override in Application settings.
- `terminal-820-light.png`: neighboring terminal form retains its spacing and scrolling.
- `new-thread-options.png`: expanded options and optional name.
- `providers-inherit-agent.png`: Providers explains the single Agents default with no competing selector.
- `inherited-agent-unavailable.png`: the inherited model stays selected and creation waits when its provider disconnects.

The original repeated Worktree selector and origin checkbox were removed. The first collapsed screen has title, project identity, Working copy label/options, a sharing/isolation explanation, Start from/source, fetch feedback, optional-settings summary and first-send footer/action. Beyond the title/project identity, these text elements are operating labels or state feedback. There is no decorative copy or new animation. Colors come from existing theme tokens, and minimum-size spacing was tightened after the first real capture put the summary below the fold.

Review found and corrected shared terminal CSS scope, the obsolete fetch-error instruction, and focus stealing after a delayed defaults read. Baseline screenshots elsewhere in the repository were restored after an older test wrote them; this change's captures use its own ignored folder. No design baselines were regenerated.

## Agent default diagnosis and resolution

Read only the relevant preference fields: the saved Agents choice is Claude Opus (reasoning=claude, reasoningModel=opus[1m]); a separate new-thread default was Grok 4.6 (defaultModelId=native:grok:model:grok-4.6). The previous helper preferred that separate thread default. The shared regression failed with Grok selected before the fix and passed with Claude afterward.

On September 21, Zach explicitly chose: new threads always inherit the agent setting. New-thread creation now uses the native agent and model in Settings > Agents, or that account's reported default model. Missing and unavailable models stay selected. The Electron regression saves a conflicting Grok override, verifies Claude thread creation, disconnects Claude while Grok remains available, then verifies creation waits and recovers after reconnect. Explicit per-thread and retry selections are retained. Providers and the legacy agent configuration no longer expose a competing default. Terminals and folder registration follow the same native agent even before its catalog arrives; terminal launches retain explicit CLI model choices through catalog changes.

ADR-0008 records the changed policy, compatibility with old serialized settings, and the existing native-provider fallback when Agents has no native account. No live preferences were edited. Standards and behavior review corrected terminal and folder-registration fallbacks that could still select another provider; four of eight new regressions failed before those corrections and all eight passed afterward.

The existing current-branch starting policy is preserved. This work is saved and built locally, not installed, pushed, or released. Windows fixture verification does not establish live native-provider or macOS behavior.

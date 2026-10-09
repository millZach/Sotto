# Tiptap skill composer

October 9, 2026. Branch `feat/skill-pill-composer`, local edits only.

Verified in the built Windows Electron app with an isolated profile and synthetic Claude, Codex and Grok providers. The source package is 0.1.34; the unpackaged launch reports Electron 43.1.0 through `app.getVersion()` (the proof's `version` field). `out/main/index.js` was built at 15:10:22 PDT; the final passing journey wrote its proof at 15:11:22 PDT. The installed release, macOS, Linux and live providers were not verified in this core build. The separate browser-test migration is owned by the lead's other agent.

## Journey and evidence

Run `npm run build`, then `node scripts/verify-skill-composer.mjs`. The tool starts a separate Electron process, drives the Threads page, records captures under the ignored `artifacts/e2e-runs/skill-pill-core/`, then closes the app and removes its owned profile. Only the cited captures are retained below.

For each provider, typing `$rev` opened Skills, Tab chose review, and the field held the native token (`/review` for Claude and Grok, `$review` for Codex). Hovering showed the catalog description. Backspace immediately after the pill removed the whole pill and its saved reference. Two Shift+Enter presses preserved two trailing newlines. Enter sent the prompt and cleared the field; another prompt queued while the fixture was working. Editing that queued message showed the pill and description, and Enter saved `/review queue edit\n\n` as native text. The journey reported no page errors.

[Proof and field geometry](../../artifacts/skill-pill-composer/proof.json) record the three providers and six window/theme combinations. The field kept 15px text, vertical resizing and scrolling, a 74px minimum and 220px maximum at larger sizes, and the existing compact-pane 50px/120px limits at the minimum window.

Every capture below was opened and inspected against the selected A and D prototypes. The wand pill sits within the text, without a sigil, and its description stays within the window. The prompt and its controls fit at the minimum size.

| Window | Dark | Light |
| --- | --- | --- |
| 1600 × 1000 | [Capture](../../artifacts/skill-pill-composer/dark-1600x1000.png) | [Capture](../../artifacts/skill-pill-composer/light-1600x1000.png) |
| 1280 × 800 | [Capture](../../artifacts/skill-pill-composer/dark-1280x800.png) | [Capture](../../artifacts/skill-pill-composer/light-1280x800.png) |
| 820 × 560 | [Capture](../../artifacts/skill-pill-composer/dark-820x560.png) | [Capture](../../artifacts/skill-pill-composer/light-820x560.png) |

[Reduced motion](../../artifacts/skill-pill-composer/reduced-motion.png) and the [queued message editor](../../artifacts/skill-pill-composer/queued-editor.png) were also inspected at 820 × 560. The queued editor's card clears the dialog's top layer.

The [compact grid](../../artifacts/skill-pill-composer/compact-grid.png) and [question panel](../../artifacts/skill-pill-composer/compact-question.png) were driven through Ctrl+click in the sidebar and inspected at 1600 × 800. Focused panes kept their 50px/120px limits, neighboring panes kept 25px/50px, and the prompt beside a question kept 32px/32px. These selectors now include the new editable element and the existing managed textarea.

## Unit coverage and gates

The focused run passed 22 files: 288 tests passed and 7 skipped. The final full run also includes the added repeated-pill undo regression. Coverage includes exact text/document round trips, serialized caret offsets, picked and unpicked tokens, whole-node deletion, undo/redo, external changes, plain-text and image paste, picker and file insertion, queue saves, focus handoffs, disabled fields and the migrated composer journeys.

`npm test -- --maxWorkers=2` exited 0:

```text
 Test Files  729 passed | 52 skipped (781)
      Tests  9283 passed | 231 skipped (9514)
   Start at  14:40:48
   Duration  1569.45s (transform 40.57s, setup 153.39s, import 304.54s, tests 2273.60s, environment 258.50s)
```

`npm run typecheck` and `npm run lint` both exited 0 on the final code. `npm run notices:verify` exited 0 after the final build:

```text
Verified 201 third-party notice components.
```

`npm run build` and the Electron journey both exited 0. The release external-inventory verifier accepted the built main/preload inventories with exactly `node-pty` and `zod` as production dependencies.

Windows tests use `C:\Windows\System32` first on the process PATH so archive tests invoke Windows tar; Git's GNU tar otherwise interprets `C:` as a remote archive host. No system PATH was changed. The earlier full run's failures were resolved in this passing run; the thread-title test passed without a source or fixture change.

## Browser-test interface

Use `getByRole('textbox', { name: 'Prompt', exact: true }).fill(text)` on the contenteditable. Its `data-prompt-text` attribute contains serialized native tokens and exact newlines. Use `[data-skill-token]` to assert a pill. Visible text omits a pill's sigil, so `toHaveText` is not a native-text assertion. The queued field's accessible name is `Edit queued message`; a legacy question changes the thread field's name to `Your answer`. No file under `tests/e2e/` was edited for this core build.

## Core files changed

- `PromptEditor.tsx`, `promptDocument.ts`, `promptSelection.ts`: the minimal editor, skill node view, exact text mapping and serialized selection offsets.
- `ThreadComposer.tsx`, `ThreadFollowups.tsx`: render the field, reconcile store changes, keep native tokens, preserve focus and restore references on undo. `SkillPicker.tsx`, `FilePicker.tsx` and `composerKeys.ts` accept serialized selections and the editable element; only the skill option's name cell changes its appearance.
- `threads.css`, `splitWorkspace.css`, `requests/requests.css`: retain field sizing, resizing, scrolling, placeholder and compact-pane rules. The follow-up field's styles live in `threads.css` because another agent owns `composer.css`.
- `ThreadPane.tsx`, `ThreadPanes.tsx`, `ThreadsView.tsx`, `HostUpdates.tsx`, `tools/BrowserPlayer.tsx`, `tools/PhonePlayer.tsx`: focus selectors reach the new field and retain the managed textarea fallback.
- `tests/unit/renderer/helpers/promptEditor.ts`, `promptDocument.test.ts`, `promptEditor.test.tsx`, `tests/setup.ts`: readable editor helpers, mapping/editing coverage and minimal jsdom measurement polyfills. The 18 migrated files are `composerReviewComments`, `composerFileMentions`, `earlyStart`, `emptyWorkspaceDraft`, `nativeSkills`, `splitWorkspace`, `threadBranchNotice`, `threadComposerRecovery`, `threadHandoffFocus`, `threadNavigationConnection`, `threadLaneBusy`, `threadQueueSkills`, `threadQueuePolish`, `threadTyping`, `threadWorkspace`, `threadRequestSurroundings`, `agents/threadsView` and `agents/threadCreationRecovery` (all `.test.tsx`).
- `package.json`, `package-lock.json`, `scripts/generate-notices.mjs`, `scripts/verify-notices.mjs`, `THIRD_PARTY_NOTICES.md`: exact Tiptap development dependencies and licenses for the bundled dependency closure. `electron.vite.config.ts` and `vitest.config.ts` use the automatic JSX transform already specified by `tsconfig.web.json`; the classic build otherwise threw when rendering the separately owned pill.
- ADR 0065, `CONTEXT.md`, `docs/guide.md`, this note, `scripts/verify-skill-composer.mjs`, the cited captures, `.gitignore` and `eslint.config.mjs`: record the decision, explain chosen skills, retain reproducible evidence and exclude generated intermediate captures.

`SkillPill.tsx`, `skillPill.css`, `composer.css`, the prototype files and the theme-token ownership update belong to the parallel design work. This core build did not edit them. `README.md` has no composer-skill description to update. No commit, push, branch switch or worktree operation was performed.

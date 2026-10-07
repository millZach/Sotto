# Thread composer recovery

Verified on Windows in the built Electron app with synthetic provider events.

The permission regression failed before the change because the focused textarea was disabled. It now keeps focus and text, becomes read-only, blocks edits and sends, and resumes editing when the permission clears. Tab leaves the composer normally. Archived threads keep their disabled editor.

The answer regressions failed before the change because closing the composer discarded its error. Answer status now lives in the window's thread draft store. A refusal that arrives before leaving or while away restores the answer and remains visible on return, without showing on another thread. Editing or retrying clears it. This does not save errors across a window restart.

`npx vitest run tests/unit/renderer/threadComposerRecovery.test.tsx tests/unit/renderer/threadDraftStore.test.ts tests/unit/renderer/threadWorkspace.test.tsx --maxWorkers=2` passed all 70 tests. Both defects were reproduced by the new tests before their fixes. A neighboring case also checks that another thread can send while the answer is pending and that a late failure preserves newer typing.

`npm run build` and `npx playwright test tests/e2e/thread-composer-recovery.spec.ts tests/e2e/thread-workspace.spec.ts tests/e2e/composer-typing-styles.spec.ts` passed all six tests. The recovery journey checks permission focus, blocked typing and Enter, Tab, editing after approval, an answer refusal, switching away and back, then editing and retrying the answer successfully.

Inspected captures at 1600×1000, 1280×800 and 820×560 in dark and light appearance with reduced motion. The question, restored answer and error stay visible. No layout, palette or baseline changes were intended. Retained evidence:

- [Dark at the minimum size](../../artifacts/crossing/pkg-43-dark-820.png).
- [Light at the minimum size](../../artifacts/crossing/pkg-43-light-820.png).

After merging current main, all 127 tests in the eight affected renderer files passed, along with typecheck, lint, notices and the build. The same six Electron tests passed again. The retained minimum-size captures were unchanged.

The throwaway focus/error walkthrough is captured locally on `prototype/bh-43-composer-recovery` at `eff650147053340bb27a699fefd6c967954a693c`, in `docs/prototypes/thread-composer-recovery-prototype.html`. Its assumption was to keep the editor focused and read-only rather than move focus when a request arrives; issue #569 permits either fix. Its HTML does not ship with the fix branch.

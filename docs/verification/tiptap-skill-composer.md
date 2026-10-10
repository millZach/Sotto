# Tiptap skill composer

October 9, 2026. Branch `feat/skill-pill-composer`: four commits after `2342e7d28`, through `424804c01`, plus uncommitted review fixes. The earlier core-build and migration evidence below records those stages; the review-fix results follow at the end.

Verified in the built Windows Electron app with an isolated profile and synthetic Claude, Codex and Grok providers. The source package is 0.1.34; the unpackaged launch reports Electron 43.1.0 through `app.getVersion()` (the proof's `version` field). `out/main/index.js` was built at 15:10:22 PDT; the final passing journey wrote its proof at 15:11:22 PDT. The installed release, macOS, Linux and live providers were not verified.

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
- `threads.css`, `splitWorkspace.css`, `requests/requests.css`: retain field sizing, resizing, scrolling, placeholder and compact-pane rules.
- `ThreadPane.tsx`, `ThreadPanes.tsx`, `ThreadsView.tsx`, `HostUpdates.tsx`, `tools/BrowserPlayer.tsx`, `tools/PhonePlayer.tsx`: focus selectors reach the new field and retain the managed textarea fallback.
- `tests/unit/renderer/helpers/promptEditor.ts`, `promptDocument.test.ts`, `promptEditor.test.tsx`, `tests/setup.ts`: readable editor helpers, mapping/editing coverage and minimal jsdom measurement polyfills. The 18 migrated files are `composerReviewComments`, `composerFileMentions`, `earlyStart`, `emptyWorkspaceDraft`, `nativeSkills`, `splitWorkspace`, `threadBranchNotice`, `threadComposerRecovery`, `threadHandoffFocus`, `threadNavigationConnection`, `threadLaneBusy`, `threadQueueSkills`, `threadQueuePolish`, `threadTyping`, `threadWorkspace`, `threadRequestSurroundings`, `agents/threadsView` and `agents/threadCreationRecovery` (all `.test.tsx`).
- `package.json`, `package-lock.json`, `scripts/generate-notices.mjs`, `scripts/verify-notices.mjs`, `THIRD_PARTY_NOTICES.md`: exact Tiptap development dependencies and licenses for the bundled dependency closure. The branch does not change `electron.vite.config.ts` or `vitest.config.ts`; `tsconfig.web.json` already specifies the automatic JSX transform.
- ADR 0065, `CONTEXT.md`, `docs/guide.md`, this note, `scripts/verify-skill-composer.mjs`, the cited captures, `.gitignore` and `eslint.config.mjs`: record the decision, explain chosen skills, retain reproducible evidence and exclude generated intermediate captures.

`README.md` has no composer-skill description to update.

## E2e migration follow-up

The browser specs now share `tests/e2e/support/prompt.ts`. `promptField` selects a thread textbox by its accessible name; `fillPrompt` waits for the serialized draft after Chromium inserts text; `expectPromptText` checks `data-prompt-text`, including native skill tokens and exact newlines. Picked skills are also checked as `[data-skill-token]` pills. Geometry, placeholders and performance instrumentation reach the editable element. Managed voice drafts, personal chats and the floating widget keep their textarea checks.

The permission-focus journey exposed a field regression: turning off editing removed the div's tab stop and Chromium dropped focus. `PromptEditor` now supplies an explicit `tabindex="0"` through its editor attributes. The new `promptEditorFocus.test.tsx` fails without that tab stop, and its final run with `promptEditor.test.tsx` passed both files and all seven tests. The built Electron journey then retained focus, refused edits while the permission was pending, advanced with Tab, resumed editing after Allow, and recovered a refused answer on its own thread. It checked dark and light with reduced motion at 1600 × 1000, 1280 × 800 and 820 × 560.

The minimum-window [dark recovery](../../artifacts/skill-pill-composer/permission-recovery-dark-820.png) and [light recovery](../../artifacts/skill-pill-composer/permission-recovery-light-820.png) captures were opened and inspected. The question, recovered answer, failure line and send action fit inside the window. The full build completed once; only the renderer was rebuilt after the focus fix. Sequential batch logs and diagnostics are kept locally under the ignored `artifacts/e2e-runs/tiptap-spec-migration/` folder. These runs do not claim the live-provider journeys, or that every migrated spec passed: remaining failures and their parent-commit comparisons are listed in the migration handoff.

`npm run typecheck` and `npm run lint` passed during the migration. All 49 changed specs were either run locally or, for the four live-provider files, migrated by reading without enabling their live flags. Managed remote question checks were restored to their original textarea path and all 18 passed. The final empty-page and split-workspace cases passed, but earlier attempts exposed an intermittent renderer draft problem: main retained the saved text while `ThreadDraftStore` supplied an empty draft to `PromptEditor`. The editor's props, document and DOM agreed. Commit `424804c01` subsequently fixed the store race: a successful save reply confirms persistence but no longer marks the revision as observed in the published snapshot stream. Only `receive()` marks it observed, so a delayed creation snapshot cannot supersede a placed draft before its saved revision arrives. `threadDraftStore.test.ts` covers both snapshot/save-reply orders. The store's draft shape remains unchanged; its behavior changed in that commit, and these review fixes make no further store changes.

Other retained migration failures involved sidebar names changed by automatic titles, bare IDs in host-scoped state, older new-thread controls, transcript keyboard focus, and native usage fixture startup (`bootstrap-startup-failed`, before a window opened). The theme spotlight's idle assertion was woken by sidebar time labels, and the minimized theme editor overlapped Send at 820 × 560. The relevant assertions and upstream paths were compared with `88ebb88ec^`; that parent was not built or run during the migration. The theme overlap was outside that work; the placed-draft race was later fixed by `424804c01` as described above. No full unit suite was run during that migration stage.

## Review fixes

The editor now keeps its document as the authority for pills during local edits. The sync effect rebuilds only for external text changes or an explicit picker/option insertion. External text converts at most the first boundary-matched occurrence per selected reference, across both sigils. A shared `promptDocSkills()` reads and deduplicates the atoms for the editor and unit-test helper; the composer and queued-message editor save those references rather than re-scanning text. Removing a pill therefore drops its reference even when a hand-typed copy of its token remains. Reference-only changes are reported even if the serialized text is identical.

A ProseMirror append transaction adds a space wherever adjacent text would break a pill's mention boundary. The caret maps through the inserted space, and undo removes that space with the typed or pasted text. This preserves the user's input and the whole pill. Existing whitespace, hard breaks, paragraph edges and valid closing punctuation need no extra space.

The initial regression command was `npx vitest run tests/unit/renderer/promptDocument.test.ts tests/unit/renderer/nativeSkills.test.tsx tests/unit/renderer/promptEditor.test.tsx --maxWorkers=2`:

```text
RED:   Test Files  2 failed | 1 passed (3)
       Tests       3 failed | 24 passed (27)
GREEN: Test Files  3 passed (3)
       Tests       27 passed (27)
```

The red failures showed a second unwanted `$review` pill, `$reviewing` with no boundary, and three pills from repeated external occurrences. The green run checks a picker-selected pill followed by a hand-typed `$review`, deleting the chosen pill while retaining the plain token, typing `ing` directly after the pill, retained references, mapped caret, undo, first-occurrence conversion and the existing round trips. Four neighboring editor cases then passed with `3 passed (3)` files and `31 passed (31)` tests: typing and pasting on both sides, punctuation, and replacing a pill with identical plain text. Two additional queue cases check the saved command's text and references after suffix typing and pill deletion.

The shared `focusedComposerField()` replaces the selector repeated by Browser Player, Phone Player, Threads and Host Updates. Its focused manual-composer selector drops `textarea`: those fields now use Tiptap, while managed drafts use the separate `agent-composer` surface. Host Updates retains its broader textarea fallback because the empty page's saved draft still uses one. The verification script no longer opens the prototypes or launches an extra browser to capture them; it depends only on tracked code and the build.

Final review-fix checks ran sequentially, with at most two Vitest workers and one Playwright worker:

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/renderer --maxWorkers=2` | `Test Files 213 passed (213)`; `Tests 2684 passed (2684)`; 212.56s; exit 0 |
| `npm run typecheck` | All three TypeScript projects passed; exit 0 |
| `npm run lint` | No findings; exit 0 |
| `npm run build` | Final renderer summary: `built in 14.68s`; exit 0 |
| `npx playwright test tests/e2e/provider-native-skills.spec.ts tests/e2e/thread-workspace.spec.ts tests/e2e/empty-page-saved-draft.spec.ts tests/e2e/queued-steering.spec.ts tests/e2e/thread-composer-recovery.spec.ts` | `3 failed`, `6 passed (1.9m)`; exit 1; only the three known workspace failures below |
| `node scripts/verify-skill-composer.mjs` | `Verified built Electron skill composer`; exit 0; no page errors |

The initial full renderer run reported `1 failed | 212 passed (213)` files and `1 failed | 2683 passed (2684)` tests. Its queue fixture began with a selected reference but no token, then expected a typed token to become a pill. The corrected fixture begins with the chosen pill the test intends to keep. The final run above includes this fixture and the browser/phone focus fixtures updated to the actual Tiptap field. The native-skills Playwright test now appends `$plan` with keyboard input; replacing the whole field would correctly remove its previously chosen skill.

The three workspace failures also fail on `main` at `2342e7d28`, run from a separate build of that commit: “a saved draft elsewhere does not close the manual composer, including while the thread runs”, “a queued follow-up keeps its skill reference and order through a reload, sends once, and a refused skill stays reviewable”, and “workspace sends a manual prompt to the selected thread without granting management”. All three timed out at 30 seconds. No other requested browser test failed.

The added Electron journey initially used Home → Right to approach the pill. In Codex that selected the atom (`from: 1, to: 2`), so typing correctly replaced that whole selection. A diagnostic assertion confirmed this. The final journey approaches through the following text and asserts a collapsed caret (`from: 2, to: 2`) before typing or deleting. It passes the actual adjacent-typing scenario, rather than a selected-node replacement scenario.

The [review proof](../../artifacts/skill-pill-composer/review-proof.json) records the Windows build at 17:24:22 PDT and verification at 17:28:43 PDT. Real keyboard input left one pill followed by `ing` and a plain repeated native token for [Claude](../../artifacts/skill-pill-composer/review-claude-boundary.png), [Codex](../../artifacts/skill-pill-composer/review-codex-boundary.png) and [Grok](../../artifacts/skill-pill-composer/review-grok-boundary.png). All three retained exactly one selected reference; deleting the pill dropped it while the typed duplicate stayed plain. These captures were opened and inspected. The [dark](../../artifacts/skill-pill-composer/review-dark-820x560.png) and [light](../../artifacts/skill-pill-composer/review-light-820x560.png) minimum-window captures were also inspected: the pill, description and composer controls fit. Geometry checks passed in both themes at 1600 × 1000, 1280 × 800 and 820 × 560; reduced motion, sending, clearing, queue editing and compact panes passed in the same journey. This verifies the built Windows app with synthetic providers; installed releases, live providers, macOS and Linux were not exercised by this fix pass.

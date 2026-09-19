# Composer option chips

Date: 2026-09-18
Plan: `docs/plans/composer-selectors.md` (prototype A, Chips, chosen by Zach).

The composer's one option pill ("Fable · High · Auto") is now three chips: the model with its provider's mark, the reasoning effort and the permissions. Each opens its own list above the composer. The model list is a compact menu anchored over the chip with provider tabs, a search line and, on a thread before its first message, the reminder that any provider is still a choice. The New thread and New terminal dialogs keep the three controls laid out in full; their model field carries the provider mark now and opens the same menu.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Clean. |
| `npm run lint` | Clean. |
| `npm test -- --maxWorkers=2` | 3648 passed, 22 skipped, 1 failed: `personalChatsView.test.tsx` "dictation stays in its captured claude draft", which touches no file on this branch and passes when its file runs alone. |
| `npm run notices:verify` | 174 components verified. |
| `npm run build && npx playwright test tests/e2e/thread-creation.spec.ts tests/e2e/workspace-projects.spec.ts tests/e2e/phase-one-integrated.spec.ts --workers=1` | 11 passed, 1 failed. The failure is `workspace-projects.spec.ts` line 228 expecting the prompt at 16px at the 760px minimum; `threads.css` sets the prompt at 15px since the quiet-scale commit on `main` (f98b5e7), which this branch did not touch. |
| `npm run design:capture` | Did not reach the Threads room. `design-capture.spec.ts` fails in its first matrix with `ReferenceError: content is not defined`: `pageBoundProblems` declares `content` inside a loop and reads it after (spec lines 265 and 326), unchanged on this branch since 2ee9d97 on `main`. The Threads baselines therefore still show the pill and need regenerating once the spec is fixed. |

## Evidence

- `artifacts/crossing/composer-provider-models.png`: the three chips in the composer footer of a new thread, dark, with the model menu open over the model chip.
- `artifacts/crossing/phase-one-model-picker-light.png`: the same menu, light, on a thread whose provider has not set permissions, so the third chip reads "Permissions" and its list offers "Provider default" as unchoosable.
- `artifacts/crossing/new-thread-options.png`: the New thread dialog's model field with the provider mark beside the name.
- `artifacts/composer-selectors-prototypes/`: the three prototype variants the pick was made from.

## Checked in the running app through the specs

- Opening the model menu from the chip, choosing a model, and the thread's options changing (`thread-creation.spec.ts`).
- Choosing an effort and a permission from their chips, and each chip reading the choice (`thread-creation.spec.ts`).
- Escape closing the model menu and returning focus to the model chip (`phase-one-integrated.spec.ts`).
- An unstarted thread's model chip enabled from the composer (`workspace-projects.spec.ts`).
- Unit: the chips' names, the provider mark on the model chip, arrow keys and Escape in a list, the unset case, and provider tabs shown only before the first message (`tests/unit/renderer/threadOptions.test.tsx`).

## Not covered here

- The effort control's own design, which Zach has a further idea for.
- The New thread dialog beyond the model field, which is the next piece of work.

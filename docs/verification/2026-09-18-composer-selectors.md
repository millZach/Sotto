# Composer option chips

Date: 2026-09-18
Plan: `docs/plans/composer-selectors.md` (prototype A, Chips, chosen by Zach).

The composer's one option pill ("Fable · High · Auto") is now three chips: the model with its provider's mark, the reasoning effort and the permissions. Each opens its own list above the composer. The model list is a compact menu anchored over the chip with provider tabs, a search line and, on a thread before its first message, the reminder that any provider is still a choice. The New thread and New terminal dialogs keep the three controls laid out in full; their model field carries the provider mark now and opens the same menu.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Clean. |
| `npm run lint` | Clean. |
| `npm test -- --maxWorkers=2` | 3651 passed, 22 skipped, 0 failed after the review fixes. An earlier run of the same command had one failure in `personalChatsView.test.tsx`, which touches no file on this branch and passed alone and on the rerun. |
| `npm run notices:verify` | 174 components verified. |
| `npm run build && npx playwright test tests/e2e/thread-creation.spec.ts tests/e2e/workspace-projects.spec.ts tests/e2e/phase-one-integrated.spec.ts --workers=1` | 11 passed, 1 failed, run before and again after the review fixes (the creation spec once hit its 30s budget while the build was still settling, and passes alone in 15s). The failure is `workspace-projects.spec.ts` line 228 expecting the prompt at 16px at the 760px minimum; `threads.css` sets the prompt at 15px since the quiet-scale commit on `main` (f98b5e7), which this branch did not touch. |
| `npm run design:capture` | Did not reach the Threads room. `design-capture.spec.ts` fails in its first matrix with `ReferenceError: content is not defined`: `pageBoundProblems` declares `content` inside a loop and reads it after (spec lines 265 and 326), unchanged on this branch since 2ee9d97 on `main`. The Threads baselines therefore still show the pill and need regenerating once the spec is fixed. |

## Evidence

- `artifacts/crossing/composer-provider-models.png`: the three chips in the composer footer of a new thread, dark, with the model menu open over the model chip.
- `artifacts/crossing/phase-one-model-picker-light.png`: the same menu, light, on a thread whose provider has not set permissions, so the third chip reads "Permissions" and its list offers "Provider default" as unchoosable.
- `artifacts/crossing/new-thread-options.png`: the New thread dialog's model field with the provider mark beside the name.
- `artifacts/crossing/composer-chips-820.png`: the chips and the open model menu at the 820x560 minimum window, nothing overflowing (`thread-creation.spec.ts` also asserts no horizontal overflow there).
- `artifacts/composer-selectors-prototypes/`: the three prototype variants the pick was made from.

## Checked in the running app through the specs

- Opening the model menu from the chip, choosing a model, and the thread's options changing (`thread-creation.spec.ts`).
- Choosing an effort and a permission from their chips, and each chip reading the choice (`thread-creation.spec.ts`).
- Escape closing the model menu and returning focus to the model chip (`phase-one-integrated.spec.ts`).
- An unstarted thread's model chip enabled from the composer (`workspace-projects.spec.ts`).
- Unit: the chips' names, the provider mark on the model chip, arrow keys and Escape in a list, Tab closing a list, focus returning to the chip once a change is confirmed, the unset case, and provider tabs with the reminder before the first message against the "stays with" note after (`tests/unit/renderer/threadOptions.test.tsx`).
- Reduced motion: the one rise animation is behind `prefers-reduced-motion` and the `data-reduced-motion` root attribute (`threadChips.css`), the same gate the follow-up ledger uses.

## After the two-axis review

- The provider-mark tint is scoped to the model chip and the menu's tabs; every other mark in the app keeps its inherited colour.
- The list keyboard handler is one helper (`listboxKeys.ts`) shared by the chips and the model menu, and one pair of option builders feeds both the chips and the New thread selects.
- Chip styles live in `threadChips.css`, on the token-owned list.
- A list closes when focus leaves it by Tab. After a choice the chip is fixed while the change is confirmed, which drops focus; it is put back once confirmed unless the user has moved on.
- A started thread's model menu says which provider it stays with, as prototype A did.
- Not changed: effort levels read as the provider names them ("Xhigh"), since inventing "Extra high" would name something Claude Code does not; the New thread dialog's Reasoning and Permissions stay native selects until that dialog's own work.

## Not covered here

- The effort control's own design, which Zach has a further idea for.
- The New thread dialog beyond the model field, which is the next piece of work.

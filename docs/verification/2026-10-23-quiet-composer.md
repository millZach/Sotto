# The quiet composer

Checked on Windows on October 22 and 23, 2026, in the built app on branch `feat/quiet-composer-line`. The thread composer, its
queued messages, its branch toolbar and Watcher's composer lose their boxes: their controls are text buttons. Zach picked
direction A, the quiet line, from `docs/prototypes/quiet-composer-prototype.html`. ADR-0113 records the decision.

## What was done

A temporary capture spec, deleted before committing, launched the `queued-steering` fake provider, made the project a Git
repository so the branch toolbar showed, and opened the Docs thread. It sent a message, queued two more while the turn ran,
and typed a third into the composer, then captured the pane at 1280x800 and the 820x560 minimum, in dark and light. It
then removed the queued messages, stopped the turn and captured the idle composer at the same sizes.

At rest, the model, reasoning and permissions read as words with a small chevron and no fill or edge, the model in the
secondary text beside its mark and the other two in the muted text. Under the card, Run on, Workspace and the branch read as
one muted line with a faint dot between them. Opening permissions showed its list above it and the hover wash behind the
button. Tab reached the model and the branch picker with the full-strength focus ring. At 820x560 the thread pane is
560 pixels wide, and permissions showed its shield alone; its tooltip read "Thread permissions: Provider default", and the
spec found no control in the composer, its queue or the branch line outside the pane and no overflow in the footer at any
of the eight captures. With the reasoning at its highest level, the word took the effort colourway and the composer its
outline, as before.

While the turn ran, the queue hung off a thin accent rule over the composer, under "Queued 2 · sends when Claude Code
finishes". Each message was one line, cut with an ellipsis at 820x560, followed by Steer now in the accent with its arrow and
the move, edit and remove icons. Pointing at Steer now washed it without changing its colour. Steer now beside Stop was an
accent text button, dimmed while the composer was empty. With motion reduced, the same.

`tests/e2e/watcher.spec.ts` (the New Watcher test) captured Watcher's composer. New Watcher read as a text button with its
icon, then a faint dot, the model and the permissions. While Watcher worked, New Watcher kept its muted words with a dotted
underline and its reason as its description, and its contrast check passed. At 820x560 Watcher's pane is wide enough that
its permissions keep their words. For the light 820x560 capture, the spec's capture filter was widened for one run and put
back.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/quiet-composer/thread-idle-dark-1280x800.png` | The composer and its branch line at rest, dark |
| `artifacts/quiet-composer/thread-idle-light-820x560.png` | At the minimum, light: permissions as its shield |
| `artifacts/quiet-composer/thread-busy-dark-1280x800.png` | A running turn with two queued messages and a draft, dark |
| `artifacts/quiet-composer/thread-busy-light-1280x800.png` | The same, light |
| `artifacts/quiet-composer/thread-busy-dark-820x560.png` | The same at the minimum, dark |
| `artifacts/quiet-composer/thread-permissions-open-dark-1280x800.png` | Permissions open, with the wash behind its button |
| `artifacts/quiet-composer/thread-effort-top-dark-1280x800.png` | The highest effort: the word's colourway and the outline, with the focus ring |
| `artifacts/quiet-composer/watcher-idle-dark-1280x800.png` | Watcher's composer, dark |
| `artifacts/quiet-composer/watcher-idle-light-820x560.png` | Watcher's composer at the minimum, light |
| `artifacts/quiet-composer/watcher-unavailable-dark-1280x800.png` | New Watcher unavailable while Watcher works, focused |

`themeTokens.test.ts` now checks secondary, muted and accent text on the card and the room under the hover wash, and the
effort word on the composer's card, in every built-in theme in both modes.

## Specs run

One at a time, after `npm run build`: `claude-steer`, `queued-steering`, `queue-remove-correction`, `composer-short-window`,
`babysitting`, `continue-thread`, `daily-workspace`, `muse-provider`, `opencode-model-menu`, `pending-settings`,
`screenshot-paste`, `thread-workspace`, `workspace-picker`, `worker-roles` and `watcher` passed, except as below.
`thread-worktrees` failed all seven tests, each hovering the New thread row in the Projects sidebar, and `watcher` failed one
test of 26, which could not find the Weekly worker row in the Thread sidebar. Both fail the same way on `1588db304`, the
commit this branch starts from, so neither comes from this change.

That first pass ran on an installed Electron 43.1.0 while `package.json` pins 43.8.3, which `npm run notices:verify`
caught. After `npm ci`, `claude-steer`, `queued-steering`, `queue-remove-correction`, `composer-short-window`,
`pending-settings`, `workspace-picker`, `continue-thread` and `thread-workspace` passed again, and the two failures above
failed the same way on both this branch and `1588db304`. The captures were taken on 43.1.0.

## Not checked here

The branch toolbar with a pull request badge and a pressable Workspace on a draft, a pending permission's dashed edge, Watch
on a new thread's composer (Owl only) and the continue strip's composer were not captured. Screen readers were not run: that
each option chip's value is read after its name rests on Chromium's combobox role, not on a listening check. Contrast was
checked by the token tests, not measured in the captures. macOS and Linux were not checked. The design capture baselines
were not regenerated.

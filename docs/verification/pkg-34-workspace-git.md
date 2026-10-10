# Shared-checkout Git protection and merged-work cleanup

October 9, 2026: Voice control and thread management described below are historical under [ADR-0068](../adr/0068-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Verified on Windows on 1 October 2026 in the pkg-34 worktree.

## Regression checks

Real Git tests hold a Git action while a sibling send and branch restore are refused, hold a send acknowledgement while Git is refused, and exercise pending work, subdirectories and separate worktrees. A deleted owned worktree restores on send and reserves its recorded root, including when the project lives in a subdirectory. These checks run through WorkspaceHost without desktop checkpoint wiring, as the headless runtime does.

Checkpoint tests reserve the checkout before file validation and keep it through rollback and recovery. An uncertain checkpoint blocks another thread in a subdirectory of that checkout. An inaccessible legacy recovery record leaves unrelated projects usable.

Merged-PR tests reject reused branch names and fork PRs with another tip, accept the exact current commit, and reject a tip that advances during the lookup or between cached cleanup decisions.

## Running app

`npm run build` and the Git actions, phase-four checkpoints and thread-workspace Playwright specs passed all six tests. The journeys cover commit, push, PR creation, pull, Git initialization, checkpoint file/conversation revert, manual sends, queued follow-ups and settled threads. Git dialogs also exercise keyboard opening, Escape, focus return, light and dark themes, reduced motion and the 1600x1000, 1280x800 and 820x560 sizes.

Inspected the minimum-size Git action capture and checkpoint captures at minimum size in light mode and full size in dark mode. The checkpoint review scrolls within its pane at minimum size. No layout or baseline changes were intended.

- [Git action at minimum size, dark](../../artifacts/pkg-34-workspace-git/git-820-dark.png)
- [Checkpoint review at minimum size, light](../../artifacts/pkg-34-workspace-git/checkpoint-820-light.png)
- [Checkpoint review at full size, dark](../../artifacts/pkg-34-workspace-git/checkpoint-1600-dark.png)

## Review

Separate Standards and Spec reviewers found and prompted fixes for early reservation, missing-worktree identity, shared checkpoint exclusions and current-tip cache invalidation. The PR review then reproduced a stale merged-tip decision queued behind a commit action. A real GitActions regression holds commit drafting, queues reclaim or auto-settle, advances the branch and verifies that the folder and unsettled thread remain. The validated tip now crosses that queue boundary and is checked under the checkout guard. Live providers were not used; fixtures and real Git repositories supplied the concurrency scenarios.

The resumed Spec review found that a draft choosing Previous worktree skipped pending-work checks until allocation. Its regression allowed a pull before the correction; it now refuses the pull and refuses the draft's first send before allocation while a mutation holds that checkout.


## October 1 review rework

All eight requested changes have individual commits. Sends now identify the checkout holder and state that the message was not sent. The controller keeps a refused manual prompt in recovery and restores it to an empty composer; a newer composer draft remains intact. A refused follow-up remains failed in its queue until the user resumes it. Automatic pull retains its original refusal on the thread's Git action record.

Manual and automatic folder removal succeed with failed history and retained follow-ups, while retaining the existing ownership, live-work and terminal checks. Checkout identity has one implementation, with nearest-.git fallback when Git refuses discovery. Candidate filtering skips unrelated and archived threads before Git discovery and caches identities within an operation. Automatic settling takes a read reservation so sibling sends proceed.

Local PR checkout reserves its destination and checks pending work and checkpoint recovery before changing the draft binding. An independent Spec review found that a temporary binding could leak through an unrelated save during asynchronous preflight. The added barrier regression reproduced that saved-state race before the correction. It now checks both saved and live state while preflight is held. The 56 focused workspace-mutation, checkpoint and checkpoint-integration tests pass.

The standalone recovery-copy prototype is retained on the local `prototype/bh-34-checkout-refusals` branch at `5b35ac0e`, outside the product branch. The actual app regression holds a real commit in an owned Git hook, sends from a sibling, checks that the provider received nothing, and verifies one successful retry after the action finishes. Captures cover light and dark at 1600x1000, 1280x800 and 820x560; the retry also runs with reduced motion. Inspected the minimum-size dark capture and medium-size light capture below, as well as the minimum-size light and full-size dark captures during the preceding run. No layout changes or design-baseline regeneration were needed.

- [Refused send at minimum size, dark](../../artifacts/pkg-34-workspace-git/refused-send-820-dark.png)
- [Refused send at medium size, light](../../artifacts/pkg-34-workspace-git/refused-send-1280-light.png)

Separate final Standards and Spec reviews found no remaining actionable findings. All GitHub issue comments, reviews and inline comments were read; the queued-tip finding is fixed in `479223bb` and already answered. Automated usage/credit-limit notices did not provide review findings.

Known limitations: the status refresh within a held Git-action guard can defer automatic pull until the next poll. Merged cleanup still requires the exact PR head to match the local tip, so a GitHub-updated merged PR may retain its folder until the user pulls. Both remain conservative and are disclosed in the PR.

The final build and all 13 Git-action, checkpoint, workspace and worktree Playwright journeys passed together with one Electron worker. Typecheck, lint and notices passed; notices cover 174 components. Generated overwrites of earlier captures were restored. Only the two refused-send images cited above are added.


A later GitHub review found that the headless host's local PR preflight omitted the requesting unallocated draft from pending-work checks. The regression pauses PR lookup, queues the first real host send without desktop checkpoint wiring, and checks that checkout never reaches Git and the queued prompt starts in its independent folder. It reproduced the shared-folder checkout before the correction. The mutation reservation now always checks its requesting thread as well as discovered siblings. All 64 tests in workspace mutations, workspace behavior and checkpoint integration pass; both review axes found no remaining issue in this correction.


Merged main at `58714228` without conflicts, retaining the renderer thread fixes. The rebuilt integrated revision passed typecheck, lint and notices, then all 14 Git-action, checkpoint, workspace, worktree and rename-focus Playwright journeys together without overlapping the full suite. The earlier origin-fallback send poll had crossed its five-second deadline under load; it passed alone on unchanged code and again in this complete post-merge run. The pre-merge full rerun reported deadline failures in recursive-submodule reclaim and headless idle-session resume before being superseded by the main merge. Final full-suite and CI results are recorded in PR #672. Assertions were kept intact.


The earlier recursive-submodule deadline increase was reverted during the second review because it was unrelated to this PR. The fixture uses its original test deadline and unchanged assertions.

## October 1 second review

Each blocking state now has truthful recovery copy: waiting for an answer, loading or failed history, failed or paused follow-ups, managed work, paused management with queued work, and unconfirmed delivery. The coordinator supplies the reason without changing which work blocks Git. An empty paused assignment still does not block. Eight workspace regressions reproduced the old generic refusal before the fix; coordinator tests verify real queue and assignment states.

Checkpoint reads say Sotto is saving a checkpoint. Their regression reproduced the false send message before the correction. Refused Git presses now leave the previous result and View PR link available; tests cover checkout and desktop-guard refusals. Auto-settle ignores history failure while retaining the guarded branch-tip check; its regression verifies unchanged files and HEAD.

The updated copy prototype is retained outside the product branch on local `prototype/bh-34-checkout-refusals` at `bfd4553a`. The Electron refusal journey now retains a failed follow-up during a held real commit, finishes the commit, refuses the next Git press with the named queue and correct recovery, and checks that the earlier Git result survives. Removing the failed follow-up then permits the retained manual prompt to be sent once. Captures cover both themes at all three supported sizes with reduced motion. Inspected the minimum dark and medium light captures below; the refusal wraps within its notice and the queue recovery controls remain usable. No design baselines were regenerated.

- [Failed queue refusal at minimum size, dark](../../artifacts/pkg-34-workspace-git/failed-queue-820-dark.png)
- [Failed queue refusal at medium size, light](../../artifacts/pkg-34-workspace-git/failed-queue-1280-light.png)

Separate Standards and Spec reviews by gpt-6.1-sol at high reasoning found no actionable issue in the second-review code changes. The initial CLI review attempts could not create read-only Windows processes because of a sandbox ACL error; independent agents completed both axes using the available tools. The final build and all 14 affected Electron journeys passed serially with one worker (3.7 minutes). Typecheck, lint and notices passed; notices cover 174 components. The full two-worker suite reported 513 passing files, 7,077 passing tests and one recursive-submodule setup deadline failure, with 39 files and 154 tests skipped (23 minutes 34 seconds). That case and its 15-second deadline match origin/main exactly. Its isolated rerun and latest CI results are recorded in PR #672. Live providers and macOS were not used locally.

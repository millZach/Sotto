# Windows desktop CI trial

The trial for #899 is [PR #900](https://github.com/millZach/Sotto/pull/900). Desktop check (Windows) is optional. Desktop result is the always-running guard the owner can require after accepting the trial. No ruleset, release target, publishing action or secret changed. The PR records the full trial's runs, individual step durations and journey results; this note keeps the inspected first-run evidence and the first three samples' timing records.

**VERIFIED on the hosted Windows desktop.** [Run 38015934326](https://github.com/millZach/Sotto/actions/runs/38015934326), job 114106106377, built source `6e3fedee02b56dbfb93374969fcaa1493f11538c`. The runner was Windows Server 2025, image `windows-2025-vs2026` version `20260925.250.1`, with Node 24.21.0 and npm 11.19.0. The job took 235 seconds; its desktop smoke step took 155 seconds. All 278 focused recovery cases and all seven Electron journeys passed with no retries.

The first three samples took 235, 183 and 230 seconds and all passed. [`timings.json`](../../artifacts/review-899/evidence/timings.json) records each step's duration and result, the seven journey results and the job IDs. The fourth sample runs the evidence commit; its results and the final median are recorded in the PR.

The journeys were completed-dictation recovery, command receipts after reconnect, queued steering, the daily mixed-provider workspace with an owned local push, workspace restart, Settings, and widget dictation. They use the built app's real renderer, preload and services with scripted providers. The widget starts hidden, appears while the scripted microphone listens, delivers the exact scripted transcript to Paste test, then returns to idle and hides. Native `BrowserWindow.isVisible()` is asserted as well as the renderer's state.

Inspected evidence, retained from this runner rather than captured on forge:

- [`widget-listening.png`](../../artifacts/review-899/evidence/widget-listening.png): the listening pill, with its Stop and Escape controls.
- [`text-delivered.png`](../../artifacts/review-899/evidence/text-delivered.png): the shortcut step's Paste test field containing the exact scripted transcript.
- [`dictation-recovery-820-light.png`](../../artifacts/review-899/evidence/dictation-recovery-820-light.png): completed text remains selectable with Copy text and Dismiss text at the 820×560 minimum.
- [`receipts-after-reconnect.png`](../../artifacts/review-899/evidence/receipts-after-reconnect.png): the model picker reopened after reconnect, with the current thread's model still shown in the composer.
- [`queued-steering-820-light.png`](../../artifacts/review-899/evidence/queued-steering-820-light.png): both queued messages and the newer draft at the 820×560 minimum.
- [`daily-workspace-1600-dark.png`](../../artifacts/review-899/evidence/daily-workspace-1600-dark.png): the Codex implementation and Claude review side by side, with the diagram, command activity and review draft at 1600×1000.
- [`workspace-restart-820-light.png`](../../artifacts/review-899/evidence/workspace-restart-820-light.png): the restored thread's follow-up and newer unsent draft at the 820×560 minimum.
- [`settings-820-light.png`](../../artifacts/review-899/evidence/settings-820-light.png): Appearance in light mode at the 820×560 minimum, with the colour scheme and theme columns.
- [`daily-proof.json`](../../artifacts/review-899/evidence/daily-proof.json): the real temporary repository's committed and pushed heads agree; the scripted GitHub boundary made zero real GitHub writes and recorded no errors.

These selected captures cover all seven journeys and remain in the repository after the hosted artifact expires. No design baseline was regenerated. The workflow retains all journey captures and Playwright diagnostics for 14 days on success and failure during the trial.

The full local suite on forge with Node 24.21.0 had 9,559 passed, 184 skipped and one failure: `tests/unit/release/adrNumbers.test.ts` found two ADR-0065 documents. An isolated run on unmodified `origin/main` at `1312da73` reproduced the same failure. Typecheck, lint, notices and the five smoke-script unit tests passed. The Changed areas shell passed 16 cases, including a long list under pipefail.

GitHub refused a job rerun while the overall workflow was still running. The second sample used the authorized empty-commit fallback after lint and the script unit tests. Once the initial workflow had finished cancelling, GitHub accepted a standalone rerun of its desktop job. Superseding a workflow cancels its other unfinished jobs. Those cancellations and workflow queue time are separate from the desktop job's result and duration.

This proves scripted desktop execution on the hosted Windows runner. It does not prove real microphone input, paid providers, Windows SendInput into another app, macOS execution or a packaged installer. The manual Windows release-machine check remains required. Making the CI check required remains the owner's decision after the trial.

## October 11: PowerShell startup readiness

[Run 38030479227](https://github.com/millZach/Sotto/actions/runs/38030479227), desktop job 114150214136, failed on `edd2c09d72e63ac2cc6937220845e8d78cfb9c42`. All 272 recovery cases and seven of the eight Electron journeys passed. The daily workspace failed its five-second executed-marker assertion. Native PTY output contained only startup output and the PowerShell window title, with neither a prompt nor an echoed command. The inspected [failure capture](../../artifacts/review-899/evidence/terminal-before-prompt.png) shows a blank terminal, a running PowerShell tab and the untouched review draft. The uploaded `windows-desktop-journeys-1` artifact also contains the Playwright error context with the exact failed assertion.

The journey typed as soon as `.xterm` mounted. That proves the view exists, not that PowerShell accepts commands. `TerminalService.start` returns after spawning the PTY; it does not await a shell prompt. The renderer separately disables input while restoring the snapshot. Both behaviors already existed on the failing head. The pinned `node-pty` Windows implementation queues writes until its first data event, which can be the window title rather than the shell prompt.

Main was merged at `3f38255c`, bringing in `99cb180b`. Its Tools terminal service, view and store are identical to main's. The new search, links, zoom, drawer launch-folder and Terminal mode agent-state changes therefore remain intact. The older failure cannot be attributed to those later changes; the comparison run and repeated final-head Windows runs are recorded in [PR #900](https://github.com/millZach/Sotto/pull/900).

The unchanged daily journey passed on the merged head in [run 38153377416](https://github.com/millZach/Sotto/actions/runs/38153377416), desktop job 114511308875. Desktop check (Windows) took 4m 5s and Desktop result also passed. This comparison establishes successful input and execution with main's terminal changes before correcting the test's missing readiness check.

The daily journey now requires the initial PowerShell prompt in native output and completed renderer restoration, then focuses xterm's own input and types through that locator. It still requires the execution-only marker, the edited file in the pinned working copy, and the unchanged file in the other thread's working copy. Neither the command's five-second deadline nor the smoke wrapper's failure handling changed. A shell that never becomes ready now fails the readiness assertion before any command is sent. The original artifact cannot identify which startup layer discarded the early input; it establishes the missing readiness condition.

Each passing run retains `issue-74-daily-workspace/terminal-command-completed.png`, showing the real terminal after executing the command. Repeat results and final check conclusions are kept in the PR so recording the final commit's CI does not create another untested commit. No product code or design baseline changed for this correction.

The first corrected run, [38153741636](https://github.com/millZach/Sotto/actions/runs/38153741636) on `e263feb0`, passed the new readiness assertion, executed the terminal command and checked both working copies. Its inspected [terminal capture](../../artifacts/review-899/evidence/terminal-after-prompt.png) shows the echoed command, `SOTTO_DAILY_TERMINAL` and the returned prompt. The run then failed at the separate Commit menu lookup. The failure capture shows Commit disabled while Changes already displays the real file diff. `PaneMenu` includes the disabled reason in that item's accessible name, so an exact `Commit` lookup cannot match it.

The pane's Git status is a separate record, polled every 30 seconds by default while the window is in front; Changes reads the working tree directly. Those refresh paths predate this main update. The journey now presses the existing working-copy Refresh control before opening Commit, then asserts that Commit is enabled. It also requires Create PR to be enabled after the commit's status update. This drives the normal user refresh path rather than depending on the background poll's phase. Real commit, local push, pull request and confirmation assertions remain unchanged, with no new retries or longer deadlines.

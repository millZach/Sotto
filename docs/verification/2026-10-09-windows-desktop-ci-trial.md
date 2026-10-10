# Windows desktop CI trial

The trial for #899 is [draft PR #900](https://github.com/millZach/Sotto/pull/900). Desktop check (Windows) is optional. No ruleset, release target, publishing action or secret changed. The PR records the full trial's runs, individual step durations and journey results; this note keeps the inspected first-run evidence and the first three samples' timing records.

**VERIFIED on the hosted Windows desktop.** [Run 38015934326](https://github.com/millZach/Sotto/actions/runs/38015934326), job 114106106377, built source `6e3fedee02b56dbfb93374969fcaa1493f11538c`. The runner was Windows Server 2025, image `windows-2025-vs2026` version `20260925.250.1`, with Node 24.21.0 and npm 11.19.0. The job took 235 seconds; its desktop smoke step took 155 seconds. All 278 focused recovery cases and all seven Electron journeys passed with no retries.

The first three samples took 235, 183 and 230 seconds and all passed. [`timings.json`](../../artifacts/review-899/evidence/timings.json) records each step's duration and result, the seven journey results and the job IDs. The fourth sample runs the evidence commit; its results and the final median are recorded in the PR.

The journeys were completed-dictation recovery, command receipts after reconnect, queued steering, the daily mixed-provider workspace with an owned local push, workspace restart, Settings, and widget dictation. They use the built app's real renderer, preload and services with scripted providers. The widget starts hidden, appears while the scripted microphone listens, delivers the exact scripted transcript to Paste test, then returns to idle and hides. Native `BrowserWindow.isVisible()` is asserted as well as the renderer's state.

Inspected evidence, retained from this runner rather than captured on forge:

- [`widget-listening.png`](../../artifacts/review-899/evidence/widget-listening.png): the listening pill, with its Stop and Escape controls.
- [`text-delivered.png`](../../artifacts/review-899/evidence/text-delivered.png): the shortcut step's Paste test field containing the exact scripted transcript.
- [`daily-proof.json`](../../artifacts/review-899/evidence/daily-proof.json): the real temporary repository's committed and pushed heads agree; the scripted GitHub boundary made zero real GitHub writes and recorded no errors.

The emitted 820×560 dictation recovery and light Settings captures and the 1600×1000 daily-workspace capture were also inspected. No design baseline was regenerated. The workflow retains all journey captures and Playwright diagnostics for 14 days on success and failure during the trial.

The full local suite on forge with Node 24.21.0 had 9,559 passed, 184 skipped and one failure: `tests/unit/release/adrNumbers.test.ts` found two ADR-0065 documents. An isolated run on unmodified `origin/main` at `1312da73` reproduced the same failure. Typecheck, lint, notices and the five smoke-script unit tests passed. The Changed areas shell passed 16 cases, including a long list under pipefail.

GitHub refused a job rerun while the overall workflow was still running. The second sample used the authorized empty-commit fallback after lint and the script unit tests. Once the initial workflow had finished cancelling, GitHub accepted a standalone rerun of its desktop job. Superseding a workflow cancels its other unfinished jobs. Those cancellations and workflow queue time are separate from the desktop job's result and duration.

This proves scripted desktop execution on the hosted Windows runner. It does not prove real microphone input, paid providers, Windows SendInput into another app, macOS execution or a packaged installer. The manual Windows release-machine check remains required. Making the CI check required remains the owner's decision after the trial.

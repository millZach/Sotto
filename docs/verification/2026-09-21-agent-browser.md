# Agent browser implementation verification

Windows desktop implementation on `feat/agent-browser`, based on `d0fbf3e8f5babc3eacf24039df6c11b4cdafdb4f`. The user selected corner-preview variant A and authorized implementation with subagents. This note records actual evidence; pending items below are not passing claims.

## Behavior

The corner preview and Tools use the same isolated browser page. The preview identifies its owning thread without changing the active conversation. Sharing grants observation of an origin. Open, navigation, click and typing actions require an exact user answer and resume the same pending provider call. Pause, revocation, expiry and closure never approve. Feedback goes into an editable draft. Screenshot evidence, page grants and browser tasks remain in memory for the current app session.

Native discovery and the unsupported Devin client are recorded separately in [provider compatibility](2026-09-21-browser-provider-compatibility.md). Supported native discovery does not prove a paid model completed a browser journey. Desktop tests use the real Electron browser with a localhost fixture and test-only provider calls.

## Independent review

The code-review skill was applied against the fixed baseline and uncommitted new files. The available agent tool does not expose the skill's custom Fable reviewer; independent review agents performed its Standards and Spec axes instead. No implementation commits existed at review time.

Standards identified: a finished-task observation leak after cross-origin revocation; typing approval that could identify an iframe/shadow host rather than the actual input; pointer-only region feedback. Spec identified: initial-open recovery after denial/pause/expiry; full-page pixel matching that prevented selection on animated pages; retained evidence taken from a different capture than the image returned to the agent. All were corrected. Element feedback first replaced the full-page match with a pixel match of the selected element's region; that too failed in the real journey, because a crop of the saved capture and a fresh capture of the same region are not byte-identical after resampling. Element feedback now checks that the page generation is unchanged and that the same element still answers at the chosen point, and returns the saved image the user was looking at.

## Final checks

Run on Windows 11 at 150% display scale on September 21, 2026, one gate at a time; an earlier run with the suite and two Playwright specs overlapping hit 20-second deadlines in unrelated provider suites, which passed in isolation and in the final serial run.

- `npm run typecheck`, `npm run lint`: passed.
- `npm test -- --maxWorkers=2`: 328 files, 4,240 tests passed, 37 skipped, none failed.
- `npm run notices:verify`: 174 third-party components verified, no new production dependency.
- `tests/e2e/agent-browser.spec.ts` against the built app: passed. It opens a page through `browser_open`, answers the open request in Tools, screenshots with the page hidden behind a closed Tools pane (no extra window remains and focus is unchanged afterwards), checks the corner preview's position and text contrast at 1600x1000, 1280x800 and 820x560 in dark and light, confirms the native page's bounds match the Tools viewport at each size, confirms reduced motion stops the preview animation, pauses (an inspect is refused), resumes, dismisses (the task keeps working), emulates 390x844 and confirms the capture is exactly that size, clicks Save trail after a one-time answer and reads the page's confirmation, adds element feedback to the draft with one attachment, finishes one task as completed and another as failed with unchecked cases, and stops sharing (the thumbnail is cleared). `artifacts/agent-browser/verification.json` records the sizes, contrast ratios and outcomes; `corner-*` and `tools-*` PNGs hold the captures, `page-feedback.png`, `completed-check.png` and `failed-check.png` the remaining states.
- `tests/e2e/tools-sidecar.spec.ts`: passed. Its regenerated captures were discarded; the Tools panel width it measures follows the pane width, not this change.
- Native discovery: Codex, Claude Code and Grok passed. Devin unsupported as documented.

## Limits

Apple silicon macOS, packaged installers and live model-driven browser journeys are not verified here. No release or deployment is part of this request.

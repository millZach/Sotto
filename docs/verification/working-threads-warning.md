# The working threads line

Checked on Windows on October 20, 2026, in the built app over the fake Claude CLI (`tests/fixtures/`), for #1183. Sotto
no longer limits how many threads Watcher and delegation start. Instead, while more than ten threads on this computer are
working, the Threads sidebar says so under its search field, and Watcher's and delegation's start replies carry the same
sentence. Zach picked that pair, A and D, from `docs/prototypes/working-threads-warning-prototype.html`. ADR-0073 and
ADR-0081 record the decision.

## What was done

Eleven threads were created in one project, and each was sent a prompt that the fake CLI held open, so all eleven were
working at once. With the eleventh working, the sidebar showed "11 threads are working. This computer may slow down or use
its battery faster." It was checked in dark and light, at 1280x800 and at the 820x560 minimum, and the sidebar did not
scroll sideways at either size. Then one turn was finished. With ten left working, the line was gone.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/working-threads-warning/line-11-dark-1280x800.png` | Eleven working, dark, 1280x800 |
| `artifacts/working-threads-warning/line-11-light-820x560.png` | Eleven working, light, at the minimum window |
| `artifacts/working-threads-warning/line-10-light-820x560.png` | One finished: ten working and no line |

The line has no motion, so reduced motion changes nothing. Its colours come from theme roles in
`src/renderer/src/agents/workingThreadsLine.css`, which `themeTokens.test.ts` checks.

## Not checked here

The reply sentence for Watcher and delegation is covered by the integration tests, not shown in a live Watcher. macOS and
Linux were not checked. More Watcher actions is gone from Watcher's room, since it held only the old limit. The design
captures do not cover Watcher's room, so no baseline changes. `tests/e2e/watcher.spec.ts` and `watcher-gate.spec.ts` were
updated for it and passed, 28 of 28, before the branch was brought up to date with `main`.

The branch was then brought up to date with `main`, which had added the **Needs attention** line under the same search
field. The two lines can show together, Needs attention first. That pairing has not been captured yet.

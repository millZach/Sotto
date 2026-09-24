# Review comments (#270)

Proved in the built app on September 23, 2026, on Windows, with `tests/e2e/review-comments.spec.ts`. The images named here are in `artifacts/review-comments/`; the whole run writes to `artifacts/review-comments-run/`, which is not committed.

## What the run shows

- **The mouse, T3's way.** A fixture thread's working copy has one changed file. A click picks new line 8, Shift+click extends to line 9, and **Comment** at the end of the pick opens the draft under the lines with focus in **Add a comment…**; **Comment** puts it on the composer and leaves a marker with **Delete comment** under line 9. The draft is captured at 1600x1000, 1280x800 and 820x560. `draft-1280x800-dark.png`, `draft-820x560-dark.png`.
- **The keyboard alone.** Tab reaches the file's lines (one stop, the line last visited), Home and the arrow keys walk to removed line 8, Shift+Down takes line 9 too, Enter opens the draft on `voice.ts L8 to L9 (before)`, and Ctrl+Enter adds it; focus comes back to the last picked line.
- **Waiting on the composer.** Both comments show as chips named for their lines, each chip's accessible name carrying the comment, at the three sizes in dark and light, and with reduced motion on. Every chip, marker, draft and the composer stay inside the window at 820x560. `waiting-1280x800-light.png`, `waiting-820x560-dark.png`, `waiting-1600x1000-dark.png`.
- **Removing a chip** takes its marker off the diff.
- **The send.** The prompt `Tighten this before we merge.` goes with the remaining comment, and the fixture provider records exactly the user's message, then `Comment on `src/voice.ts L8 to L9`:`, the comment and the two added lines in a `diff` fence. The chips and markers clear and the composer is empty. The transcript draws the fence as code. `sent-1280x800-dark.png`, `sent-1280x800-light.png`.
- **No page errors** through the run.

## What I worked out

- The comment is text in the prompt rather than a new field on the command, so main and the four adapters are unchanged and every provider reads the same message (ADR-0027, amendment for #270).
- The comments are written into the draft as its last revision before it is submitted, so the saved revision, main's delivery digest and the sent text agree, and a refused prompt comes back to the composer with them written in. The unit tests prove the saved revision and the sent text match and that a refused send returns everything.
- Split rows became real boxes on the file's grid (`subgrid` instead of `display: contents`) so they can take focus and a selection. Both Changes tests in `tools-sidecar.spec.ts` (every scope, three window sizes, three panel widths, dark and light, with their clipping and contrast checks) and the Changes review in `phase-three-ui.spec.ts` still pass, and a pixel comparison of `artifacts/phase-three-ui/changes-diff-*.png` against the committed copies differs only in the transcript's clock, so those captures were left as they were.
- A comment whose lines have changed since stays on the diff at the end of its file and says so, because #270 asks that a comment stay visible until sent; it still sends the lines as they were written.
- `npm run design:verify` passes all 144 tuples: the matrix has no Changes tuple and its composer captures hold no comments, so no baseline changed.

# A check's reply on its row of delegated work, October 28, 2026

Issue #1312's last piece: Zach's pick C, "Excerpt and tray", of `docs/prototypes/check-reply-card-prototype.html` (tag `prototype/check-reply-card`). It is part of the Owl feature Work across machines (`cross-machine-work`); Stable draws every row as before.

## What changed

- **A check's row** in the delegating thread's delegated work says **Check** with a flask in place of its kind of work, and the Worked for line counts checks ("1 delegated thread · 2 checks"). Its outcome stays Answered.
- **Once answered**, the row's second line quotes its **reply excerpt**, the reply's first line as the thread wrote it: It replied "Failed: 2 of 1,214 tests." with "· cut at 32 KiB" when Sotto cut the reply, and **Read its reply**.
- **Read its reply** reads the reply from main on the press and opens a tray over the bottom of the transcript, above the composer, headed with the check's title and "Its reply, in its own words, on this computer · 4:00 pm": its first 60 lines in monospace with the dashed edge, then "That is all of its reply." (or how many more lines are in its thread, or the 32 KiB sentence) and **Open the check**. Escape and Close return focus to Read its reply.
- **A reply not kept** reads "Its reply wasn't kept here. Open the check to read it in its thread." and has no tray. A waiting check keeps today's card.

## How it was checked

On forge (Omarchy, Linux), in this branch's worktree, against Sotto Owl built from it (`npm run build`), with the real Claude Code and Codex adapters over the fake CLIs:

- `node scripts/verify-linux-window-minimum.mjs --exec <playwright> test tests/e2e/thread-delegation.spec.ts -g "Read its reply opens"` on the owned nested desktop. A Claude Code thread delegates a check to Codex with `test_run`, which takes its place in This computer's check queue and starts at once. Its row says Check with the flask and Working, with no reply line. The fake Codex answers with a ten-line reply; the row reads Answered and It replied "Failed: 2 of 1,214 tests." Read its reply. From the keyboard, Enter on Read its reply opens the tray with the focus in it, showing the reply whole and "That is all of its reply."; Escape closes it and the focus is back on Read its reply; Close does the same; Open the check opens the check's thread in the pane.
- In dark and light, at 1280x800 and the 820x560 minimum, with the tray closed and open: nothing in the pane is wider than the pane, the tray stays in the transcript's column and above the composer, its row stays in view above it, and the row's and the tray's text measure 4.5:1 or more on what they sit on. The one bounds problem the page reports, the composer's Stop button label clipped, is #1730's Linux font metrics on every delegation journey on main, and the journey leaves only that one out.
- Captures: the answered row, [dark 1280x800](../../artifacts/check-reply-card/check-row-dark-1280x800.png) and [light 820x560](../../artifacts/check-reply-card/check-row-light-820x560.png); the tray open, [dark 1280x800](../../artifacts/check-reply-card/check-tray-dark-1280x800.png) and [light 820x560](../../artifacts/check-reply-card/check-tray-light-820x560.png). At 820x560 the tray's text scrolls and its last line fades while more is below. These are verification screenshots, not design baselines: the design scenario has no delegation bridge, and no baseline changed.
- The proof harness again reported "Proof cleanup failed after process termination" with a file-tree diff in another agent's worktree, as #1730 records; the spec itself passed.

Unit and integration tests, run on forge:

- `tests/unit/main/delegationCheckReplies.test.ts`: the excerpt is the first line with words in it, cut at 200 characters and never inside a character; it goes only with an answered check's row, is read once per reply, says a cut at 32 KiB and a reply not kept as `read_delegation` does, and is absent where checks are not offered. The on-press read answers an answered check this thread delegated with the reply cut at 32 KiB, refuses any other delegation, a thread on another machine and any window but the main one, and is registered only where checks are offered.
- `tests/integration/delegationChecks.test.ts`: a start that queued is saved as a check, its row quotes its reply's first line once answered and after a restart, and a later brief to its thread is no check.
- `tests/unit/renderer/agents/checkReplyCard.test.tsx`: the row's words, mark, second line and count; a waiting check unchanged; the not-kept line; the tray's reading on a press, its first 60 lines and what follows, Escape and Close returning focus, one tray at a time, Escape closing it before the Worked for fold; one reader however often the window's state moves; and the card as before with Work across machines off.

## Where it does not reach yet

- A check a thread on a host delegated there: the host's `delegation-views` answer keeps its shape, so its row shows its kind of work and no excerpt.
- A check on another machine than the thread that asked for it, through the desktop relay or as a remote delegation: those delegations have no row in the asking thread's transcript yet (ADR-0081, the October 28 amendment for #1316 part 3).

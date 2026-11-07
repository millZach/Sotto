# The design pass, before and after

November 6, 2026, for PR #2305. Each image puts the app before the pass on the left and the app at 11dbc1cb2 on the right, at the same crop, with rings on what changed. The numbers in each half's label match the rings in that half.

## How the images were made

Both sides come from `scripts/capture-review-evidence.mjs`, which drives `tests/e2e/review-evidence-capture.spec.ts` against the built app with an isolated profile. The provider is the fake host the end-to-end suite uses, so threads, messages and activity records are data it was told, through the real coordinator, IPC and renderer. The renderer's clock is held, the working line keeps its first word, and the window is drawn at scale 1 with the GPU off, as the design captures run. The build is Sotto Owl, so Owl features are on. Nothing was edited in the images except the crop, the labels and the rings.

Three things differ between the sides beyond the pass itself:

- The long thread and Usage use fuller fixtures on the right. The long thread was rewritten to read like a real session, and Usage now has tokens, limits and a month of prompts where the old run had a handful. The look is what to compare; the words and figures are not the same.
- The capture before the pass had no Glass state. The Glass before is the first Glass capture taken during the pass, from a build that already carried some early changes. Glass is translucent, so it is shown over a plain grey desktop.
- A few states exist only on the right, because the harness gained them during the pass: the sidebar over the thread, a day under the pointer in Usage, and Open pull requests opened. Their before is the nearest state the old app had, and the label says what the right side shows.

Watcher's icon row at the foot and the strip under its header come from main's merge, not this pass, so they carry no ring.

## Threads sidebar and rail

Needs you puts each approval or question on one line with Answer in view, a failed turn rests under them in muted ink, and a waiting thread reads "In Needs you" in its folder. A resting row is one line, its name and a muted time; working rows keep two lines with a quieter Working and clocks in minutes. Below a 1000 pixel window the sidebar stands as the rail, with provider marks and status rings in project trays, and Expand sidebar opens the whole sidebar over the thread.

![Needs you](../../artifacts/design-hill-climb/sidebar-needs-you.png)
![Resting and working rows](../../artifacts/design-hill-climb/sidebar-rows.png)
![The rail at the minimum window](../../artifacts/design-hill-climb/sidebar-rail-820.png)
![The sidebar over the thread](../../artifacts/design-hill-climb/sidebar-over-820.png)

## Thread reading and transcript

Messages read a step larger on a narrower line, with quieter inline code. A sent message ends at its words, only a thread's first reply is headed, turns are parted by space with no rule, and a quick turn's Worked for line waits for the pointer. Jump to latest stands beside the column, and the scrubber shows only the ticks near the reader. In the pane header the thread's name is served first, the branch is named once, and Watch is its owl alone in a narrow pane. Code still being written ends in a caret.

![Pane header](../../artifacts/design-hill-climb/reading-header.png)
![The name served first](../../artifacts/design-hill-climb/reading-header-name-first.png)
![The reading column](../../artifacts/design-hill-climb/reading-column.png)
![Turns in a long thread](../../artifacts/design-hill-climb/reading-turns.png)
![Code still being written](../../artifacts/design-hill-climb/reading-code-caret.png)

## Steps and the working line

The working line names the running step and its command, and the plan's checklist stands above it while the turn runs. The closing reply is written under the line. While a request waits, the line says "Waiting for your permission". Opened steps say what each was for, show a command with Copy only once opened, and show a long output's first lines. Worked for says what ran, with the changed files and their line counts beside it. The tip row is gone.

![Plan and working line](../../artifacts/design-hill-climb/steps-plan-and-line.png)
![The reply under the line](../../artifacts/design-hill-climb/steps-reply-under-line.png)
![Opened steps](../../artifacts/design-hill-climb/steps-opened.png)
![Waiting for your permission](../../artifacts/design-hill-climb/steps-waiting.png)
![Worked for](../../artifacts/design-hill-climb/steps-worked-for.png)

## Changes and document edits

Changes says what it compares as one phrase, its totals match the pull request's and say how many whitespace lines are hidden, its toggles are one View menu, and "1 of 30" stands on the file's head. A document reads as its page: a reworked paragraph reads once as it was, struck, and then as it is now, with changed words underlined. Code reads a size smaller, one row per line, with one column of numbers and a quiet arrow where a line runs on. The file tree keeps both ends of a name and the pressed file stays marked without moving the workspace. At the minimum window Changes covers the workspace. A thread's own edit to a document draws the same page with its file's name and both line numbers, and the commit dialog's counts match.

![The Changes bar](../../artifacts/design-hill-climb/changes-bar.png)
![A document as its page](../../artifacts/design-hill-climb/changes-document.png)
![Code](../../artifacts/design-hill-climb/changes-code.png)
![The file tree after a press](../../artifacts/design-hill-climb/changes-tree.png)
![Changes at the minimum window](../../artifacts/design-hill-climb/changes-820.png)
![A document edit in the thread](../../artifacts/design-hill-climb/doc-edit-in-thread.png)
![The commit dialog's counts](../../artifacts/design-hill-climb/changes-commit-dialog.png)

## The pull request surface

The title leads as a heading. A ready checklist folds to one row and Merge is a green wash; when something blocks, the blockers lead and say how they stand, and Merge reads "Can't merge #1612 yet", hatched, with a line saying what has to happen. Description, Checks and Changed files stand on one card and show what they hold, and Open pull requests lists the repository's pull requests with a search. At the minimum window the surface covers the workspace.

![Ready to merge](../../artifacts/design-hill-climb/pr-ready.png)
![Blocked](../../artifacts/design-hill-climb/pr-blocked.png)
![Open pull requests](../../artifacts/design-hill-climb/pr-open-list.png)
![At the minimum window](../../artifacts/design-hill-climb/pr-820.png)

## Usage

The index gives a figure for each measure that has one, Room left draws a ring only for a reading, and model names read plainly. Per day has a scale in round steps and a date each week, and pointing at a day puts its figure over its bar. By provider is rows with a count, a share and a bar.

![The Usage index](../../artifacts/design-hill-climb/usage-index.png)
![Per day](../../artifacts/design-hill-climb/usage-per-day.png)

## The Watcher room

Watcher's colours and night scene are kept exactly. Your messages there are as wide as their words, as in threads, and Stop all stands in the header.

![Watcher's room](../../artifacts/design-hill-climb/watcher-room.png)

## Light, dark and Glass

By night the Sotto theme's room is a soft, warm ink with the sidebar and Tools a step darker below it; the composer's card is unchanged. By day muted words read a step stronger, provider marks take a colour that reads, the open row is a deeper card, Changes marks a modified file in a dark gold, and a ready Merge is a clear mint. On Glass the thread's words run on under the see-through composer card.

![The dark room](../../artifacts/design-hill-climb/theme-dark-room.png)
![The sidebar by day](../../artifacts/design-hill-climb/theme-day-sidebar.png)
![Changes by day](../../artifacts/design-hill-climb/changes-day.png)
![Merge by day](../../artifacts/design-hill-climb/pr-day.png)
![Glass under the composer](../../artifacts/design-hill-climb/theme-glass-foot.png)

## The owner's picks

The picks these images show are recorded in ADR-0024 (the dark room and the dark gold by day), ADR-0027 (Checks, Open pull requests, the checklist's words and fold previews), ADR-0083 (the Usage index), ADR-0092 (a seen failure on one line), ADR-0109 (the scrubber's ticks), ADR-0110 (the rail below 1000 pixels, the Merge wash and mint, and Changes and the pull request covering the workspace), ADR-0134 (the working line, the plan above it, the reply under it and opened steps), ADR-0135 (Needs you and resting rows), ADR-0146 (the rail's trays), ADR-0163 (Watch as its owl), ADR-0169 (reading size and code size), ADR-0182 (the name served first), ADR-0195 (a reworked paragraph as two paragraphs) and ADR-0196 (tips are removed).

## Not verified

- `tests/e2e/watcher.spec.ts` is red in five places and is not run in CI:
  - a prompt that was never confirmed, because an owl button stands past the window's edge in the night scene;
  - "keeps a reader's place";
  - a thread created without a message does not show in the sidebar;
  - the Watcher tab order, which follows the composer;
  - "Stable shows nothing of Watcher", which is stale now that Watcher is on stable.
- `usage-dashboard` fails 2 of 3, the same as on main.
- `agentAnswers` fails on a restart note's title, from main's 80f4d0eb0.
- `thread-list-rest` fails on a 3 px scroll.

# The first sign of the model when thinking shows - October 5, 2026

Issue #768, part of #762. A Claude reply that opens with a thinking block used to show nothing until the block after
it began, because the adapter handled only `text_delta` and the thinking block's own frames went unread. The block now
starts a Thinking row the moment its `content_block_start` arrives (`claudeActivity.ts`), so the first sign of the
model moves from after the thinking to its start. This note measures how far that moves it on the development
machine's own Claude threads.

## What was measured, and how

`scripts/perf-bench/claude-thinking-lead.mjs` reads the newest 400 Claude Code transcripts under `~/.claude/projects`
and keeps the sessions the installed Sotto's `claude-threads.json` names (only their session IDs are read from it).
For each prompt whose reply opened on a thinking block on the main chain, it times two waits from the prompt's line.
"Before" runs to the thinking block's line, which Claude Code writes when the block ends. "After" runs to the block's
start, which is that line's time less the `thinkingDurationMs` Claude Code records beside it. The script reads
durations only: no prompt, reply or thinking text reaches its output. Claude Code records a thinking block's duration
from 2.1.288, so only replies from that version on count, which on this machine is October 1 onwards.

"Before" is a floor, not what Sotto showed. Before this change a finished thinking block showed nothing either:
the first sign was the first byte of the block after it, which comes once the thinking has ended. So the real gain
is at least the one in the table.

A reply that opened on text or a tool is left out. Sotto showed that block from its start before this change and
still does, so it has no before and after to compare.

## Before and after

335 prompts answered in Sotto's Claude threads, 175 of which opened on a thinking block. The table is those 175.

| | Before (thinking finished, a floor) | After (thinking started) |
| --- | ---: | ---: |
| Median | 4.1 s | 1.5 s |
| p90 | 14.5 s | 8.8 s |

Where a reply opened on thinking, the row came at least 1.7 s sooner at the median and 8.2 s sooner at p90: the time
Claude spent thinking before it wrote anything else.

None of the 175 opening blocks carried words in the transcript; 582 of the 3,418 thinking blocks anywhere on the main
chain did. So the row a reply opens on usually shows without text, which the issue allows for, and its words show
where Claude sends them.

## What these numbers are not

- They start at the prompt's line in Claude Code's transcript, when Claude Code took the prompt, not at Send. Sotto's
  own work before that is #762's other children (#763 to #767) and is not in them; the tracking issue's 7.7 s median
  was measured from Send.
- They are not the tracking issue's target. #762 asks for the first sign at the provider's own time to first byte,
  measured from Send; these are Claude Code's own durations from its prompt line, and "after" still includes that
  time to first byte.
- "After" is when the block started, from Claude Code's own record, not a measurement of the row on screen. The row
  needs the `content_block_start` frame to reach the adapter and the snapshot to reach the window, the same path a
  `text_delta` takes; `tests/e2e/thread-thinking.spec.ts` shows the row on screen before any reply text, without
  timing it. How fast that path paints is #771's.
- Whether Claude Code's live stream carries words that its transcript leaves out was not checked: no live Claude run
  was made for this issue. The fake CLI streams words, and both are handled.
- Grok and Devin are not in the table. Grok's history keeps its thought chunks but no durations. One gated live run of
  Devin (`devinThinkingLive.test.ts`, swe-1-6-fast on Devin 3000.10.31) streamed one thought, with words, in five
  live updates before its reply. The test now fails when no thought arrives before the reply; it has not been run
  live since that change.
- Taken on the Windows development machine (Node v24.14.1) from its own history between October 1 and 5, 2026. Read
  the figures as sizes, not budgets. Nothing asserts a time.

## Re-run

```sh
node scripts/perf-bench/claude-thinking-lead.mjs --sessions "$APPDATA/sotto/claude-threads.json" --since 2026-09-01
SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinThinkingLive.test.ts --maxWorkers=1 --disable-console-intercept
```

Without `--sessions` the script keeps every session among the newest 400 transcripts (`--files`), Sotto's or not.

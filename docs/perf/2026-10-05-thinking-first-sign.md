# The first sign of the model when thinking shows - October 5, 2026

Issue #768, part of #762. A Claude reply that opens with a thinking block used to show nothing until the block had
finished, because the adapter handled only `text_delta` and the thinking block's own frames went unread. The block now
starts a Thinking row the moment its `content_block_start` arrives (`claudeActivity.ts`), so the first sign of the
model moves from the end of the thinking to its start. This note measures how far that moves it on the development
machine's own Claude threads.

## What was measured, and how

`scripts/perf-bench/claude-thinking-lead.mjs` reads Claude Code's own transcripts under `~/.claude/projects` and keeps
the sessions the installed Sotto's `claude-threads.json` names (only their session IDs are read from it). For each
prompt it finds the first block Claude wrote in reply on the main chain. "Before" is the wait from the prompt's line
to that block's line, which is written when the block ends: the first moment Sotto had anything to show. "After" is
the same wait to that block's start, which for a thinking block is its line's time less the `thinkingDurationMs`
Claude Code records beside it; any other first block is unchanged. The script reads durations only: no prompt, reply
or thinking text reaches its output. Claude Code records a thinking block's duration from 2.1.288, so only replies
from that version on count, which on this machine is October 1 onwards.

## Before and after

335 prompts answered in Sotto's Claude threads, 175 of which opened on a thinking block.

| | Before (first block finished) | After (first block started) |
| --- | ---: | ---: |
| Every prompt, median | 3.7 s | 2.6 s |
| Every prompt, p90 | 14.1 s | 10.3 s |
| Prompts opening on thinking, median | 4.1 s | 1.5 s |
| Prompts opening on thinking, p90 | 14.5 s | 8.8 s |

Where a reply opened on thinking, the row came 1.7 s sooner at the median and 8.2 s sooner at p90: the time Claude
spent thinking before it wrote anything else.

None of the 175 opening blocks carried words in the transcript; 582 of the 3,418 thinking blocks anywhere on the main
chain did. So the row a reply opens on usually shows without text, which the issue allows for, and its words show
where Claude sends them.

## What these numbers are not

- They start at the prompt's line in Claude Code's transcript, when Claude Code took the prompt, not at Send. Sotto's
  own work before that is #762's other children (#763 to #767) and is not in them; the tracking issue's 7.7 s median
  was measured from Send.
- "After" is when the block started, from Claude Code's own record, not a measurement of the row on screen. The row
  needs the `content_block_start` frame to reach the adapter and the snapshot to reach the window, the same path a
  `text_delta` takes; `tests/e2e/thread-thinking.spec.ts` shows the row on screen before any reply text, without
  timing it. How fast that path paints is #771's.
- Whether Claude Code's live stream carries words that its transcript leaves out was not checked: no live Claude run
  was made for this issue. The fake CLI streams words, and both are handled.
- Grok and Devin are not in the table. Grok's history keeps its thought chunks but no durations. One gated live run of
  Devin (`devinThinkingLive.test.ts`, swe-1-6-fast on Devin 3000.10.31) streamed one thought, with words, in five
  live updates before its reply.
- Taken on the Windows development machine (Node v24.14.1) from its own history between October 1 and 5, 2026. Read
  the figures as sizes, not budgets. Nothing asserts a time.

## Re-run

```sh
node scripts/perf-bench/claude-thinking-lead.mjs --sessions "$APPDATA/sotto/claude-threads.json" --since 2026-09-01
SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinThinkingLive.test.ts --maxWorkers=1 --disable-console-intercept
```

Without `--sessions` the script reads every Claude Code session on the machine, Sotto's or not.

# Idle compaction

[ADR-0123](../adr/0123-sotto-compacts-an-idle-claude-thread-before-its-cache-expires.md), checked on the Windows development laptop on October 23, 2026.

## The numbers behind it

Read from this computer's own logs for the 30 days to October 23, 2026, with throwaway scripts that kept only counts (no prompt or reply text was printed or saved):

- Claude Code session files, 56,421 main-thread requests: 248,135,292 tokens written to the one-hour cache and 1,132,218 to the five-minute one.
- By the gap since the thread's previous request: under 30 minutes, 100% read mostly from cache; 30 to 45 minutes, 98%; 45 to 55 minutes, 92%; 55 to 65 minutes, 55%; over 65 minutes, 5%, writing 247,746 tokens on average (187,960 median).
- 100 manual compactions: 321,836 tokens before (median), a summary of 12,824 characters (median), and 41,861 tokens for the next request to read (median).
- Threads with more than 60,000 tokens of context that went 54 minutes without a request: 424 came back, 212 did not.
- Codex rollouts, 788 files: a request one to three hours after the one before read 81% of its input from cache on average; three to twelve hours, 22%.

## In the built app

`npm run build && SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/idle-compaction.spec.ts` passed. The real Claude adapter ran over the fake CLI in `tests/fixtures/fakeClaudeThread.mjs`, advertising `/compact`. A turn ended with a reply whose usage read 250,000 tokens of context, dated 54½ minutes earlier. Nothing was pressed after that:

- Within one 30-second sweep Sotto sent `/compact` to the CLI. After the CLI's compaction boundary, the transcript showed **Context compacted 250k → 41k tokens** and the line under the composer read **Sotto compacted this idle thread before its cache expired.** with **Turn off**. The window showed no error.
- A further 35 seconds sent no second `/compact`: one quiet stretch, one compaction.
- **Turn off**, pressed with Enter, opened Settings › Providers on Claude Code's page with **Compact idle threads** in focus. Space turned it off, and the saved setting read `compactIdleThreads: false`.
- Dark and light at 1280x800 and at the 820x560 minimum: the line and its link fit, and the pane did not scroll sideways.

Screenshots in `artifacts/idle-compaction/`: `thread-dark-1280.png`, `thread-light-1280.png`, `thread-dark-820.png`, `thread-light-820.png`, `settings-claude-code-1280.png` (the switch in focus after Turn off), `settings-claude-code-off-820.png`.

Not checked here: 1600x1000, which this laptop's screen cannot open the window at, and the Mac. A real Claude Code thread left for 54 minutes was not used, so whether Claude Code's own compaction request reads from cache (the difference between saving about 75% and about 30%) is still unmeasured; the next idle compaction of a real thread will show it in that session's log.

## Tests

`tests/unit/main/idleCompaction.test.ts` (the window, the size and model, every thread that is left alone, once per stretch, at most two at once, the switch), `tests/unit/main/idleCompactionControl.test.ts` (the sweep through the real coordinator to the provider, the idle mark, the window's error untouched, a refused guard writing nothing), `tests/integration/nativeCompaction.test.ts` (Claude carries the idle mark to the result), `tests/unit/renderer/threadCompaction.test.tsx`, `tests/unit/renderer/providersSettings.test.tsx`, `tests/unit/renderer/features/settings/idleCompactionSettings.test.tsx` and `tests/unit/shared/settings.test.ts`.

The first run of the built app found a bug the unit tests had missed: the guard asked again at the provider write also asked that nothing be queued for the thread, and by then the compaction's own outbox entry was queued, so every idle compaction refused itself. The guard now leaves the queue to the sweep, and the coordinator test runs the real sweep to the provider; it fails without the fix.

## After review

Sol's two-axis review found four more: the guard was not asked again between the CLI starting and `/compact` (the Claude adapter now asks it there), the two-at-once limit counted commands rather than compactions (places are now held until the thread shows its result), a compaction leaving 100,000 tokens or more could start a new stretch of its own (the context time it leaves is now remembered as tried), and Find a setting landed on the provider list rather than the switch (its entry now names Claude Code, and Find shows that page first). Each has a test in the files above.


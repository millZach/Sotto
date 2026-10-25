# Why Watcher is slow on Muse Wonder at xhigh

October 23, 2026. Investigation only; no product code changed. Read against `origin/main` at `26679b4ef` (this worktree started 1,290 commits behind and was fast-forwarded first).

Follow-up: the Sotto-side fixes 1 to 4 below are #1419, #1418, #1417 and #1420, made in the pull request that added this note (ADR-0073 and ADR-0079, October 23 amendments).

## Answer

Both, but mostly the provider (A). Sotto's side adds very little time; where Sotto contributes, it is by what Watcher is told and asked to do, not by how it talks to Muse.

- **A. Muse itself is slow per model call, and slow to hand a turn back.** About 5 to 27 seconds for the model step on a bare 30k-token prompt, against about 1.0 to 1.4 seconds on Claude. Then a median 21.6 seconds passes after Muse's last output before it reports the turn finished, against 0.5 seconds on Claude. xhigh is not the cause.
- **B. Muse Watcher makes about twice as many round trips as Claude.** On a user request it makes 7 tool calls per turn against 2 to 3. On wake-up news it makes 3 against 0. Each extra round trip costs one slow Muse call. This is partly how Muse behaves and partly what Sotto's prompt and news leave it free to do.

Sotto's send path, tool execution, prompt caching and tool-result sizes are not the problem.

## Evidence

Sources: Sotto's own stores under `%APPDATA%\sotto` (`threads.sqlite` activities and events, `usage.sqlite` token rows, `turns.jsonl` send timings), plus direct probes of the Muse and Claude CLIs. No prompt text was read or copied.

The Muse Watcher is thread `bb92ba47`, session `01a169bd…`, `muse-wonder-full-1.0` at xhigh, October 23, 17:09 to 18:20 UTC: 19 turns, 105 model calls. Muse has no other Watcher with usage rows. An earlier Muse Watcher (`22a2146e`, October 17 to 19) has activities only.

### Turn time, from the turn activities

| Watcher | Model | News turns, median (n) | User turns, median / p90 (n) | Tool calls per user turn |
| --- | --- | --- | --- | --- |
| Muse, `bb92ba47` | Wonder full, xhigh | 101 s (12) | 113 s / 508 s (7) | 7 |
| Muse, `22a2146e` (earlier) | Wonder | 38 s (7) | 26 s / 322 s (3) | 0 |
| Claude, `ecce1a98` | Opus 5.5 | 2 s (401) | 20 s / 197 s (49) | 2 |
| Claude, `23b33f4a` | Sonnet 5.5 | 2 s (614) | 17 s / 101 s (65) | 1 |
| Claude, `68cbffd5` | Opus 5.5 and Sonnet 5.5 | 1 s (374) | 28 s / 92 s (73) | 0 |
| Codex, `59955228` | GPT-6 Astra | 9 s (17) | 27 s / 133 s (23) | 3 |

The Muse sample is one hour and 19 turns, so treat the ratios as rough. User turns are about 4 to 6 times slower than on Claude. News turns are far slower because Claude mostly answers news in one call with no tools.

### Where a Muse turn's time goes (2,549 s across 19 turns)

- Tool execution: 53 s (2%). Median tool run is 0.1 to 0.8 s. The one `start_thread` took 11.9 s.
- Explicit reasoning items: 131 s (5%). 22 of 105 calls thought at all; the longest took 31.6 s.
- Finish wait: about 350 s (14%). Median 21.6 s, minimum 7.3 s, between Muse's last output, tool or token record and the turn being marked finished. Claude's median is 0.5 s. A news turn that streamed its answer by 12 s did not finish until 32.5 s.
- The remaining ~80% is model calls: about 20 s per call overall.

### Per model call

- Sotto's own `firstOutputMs` for sends to this Muse Watcher: median 13.4 s (n=25). Sotto's send path before that is 2.0 s total, faster than Claude's 3.4 s.
- Probe, `muse exec` 1.4.12 (the build Sotto runs), prompt "Reply with the single word: ok", empty folder, cold cache. The prompt is 30.2k tokens before anything of Sotto's is added.

  | Effort | Runs | First output, from launch | Reasoning tokens |
  | --- | --- | --- | --- |
  | medium | 3 | 10.6, 11.3 and 33.0 s | 6, 6, 12 |
  | xhigh | 3 | 11.8, 11.8 and 20.1 s | 25, 6, not recorded |

  Process start-up is about 5 to 8 s of each figure (the run is accepted at 5.3 s and 8.1 s in the two runs I timed from the first event), so the model step itself is roughly 5 s, 5 s, 12 s and 27 s. Medium and xhigh are indistinguishable, so effort is not the cost. The 33.0 s run also made a second model call after answering, which failed. The other runs spent 1.8 to 2.9 s after the answer before finishing.
- Same prompt on Claude Code 2.1.309, Opus 5.5, high and medium, no tools: API time 0.9 to 1.4 s (6k-token prompt, so not a like-for-like context size).
- Throughput once a long answer is flowing is similar: about 59 output tokens per second on Muse for calls over 800 tokens, against 64 to 96 on Claude. The gap is the wait before the first word and after the last, not the speed in between.

### Things that are not the problem

- **Prompt caching works.** Calls after the first read 98 to 99% of their input from cache. Only the first call was cold (40.2k input, 0 cached; 14 s).
- **Fresh-session size is the same as Claude's.** First call 40.2k tokens on Muse, 36.0k to 40.4k on Claude. Muse's own base prompt is 30.2k of that, so Sotto adds about 10k (Watcher prompt, three tool servers, the message).
- **Tool results are the same size as on Claude.** `read_thread` median 2.8k characters on Muse against 3.2k on Claude; `read_state` 6.4k against 6.8k. Slim reads (#1191) already apply to every provider.
- **No Muse-only polling, retries or wrapping.** `turn/completed` is handled synchronously (`muse.ts:1331`); tool servers are attached once at session start.

## Sotto-side inefficiencies, by impact

1. **Watcher is free to re-read a thread after every piece of news, and Muse does.** 47 `read_thread` calls in 16 turns (2.9 per turn) against 98 in 450 on one Claude Watcher (0.22 per turn). Each costs a round trip of about 15 to 20 s and adds a median 2.8k characters (up to 27k) to the conversation for good. `read_thread` is 258k of the 389k characters of tool results, about 66%. News already carries the start of the worker's reply, and the prompt says to act on it when it is enough. Related: #1142.
2. **Watcher's instructions are sent again with every message to a Muse Watcher.** MSP takes no system prompt, so the 3.7k-character prompt (about 0.9k tokens) is prepended to every send, wake-up news included (`muse.ts:196`, `:1656`). That was 19 copies, about 17k tokens, in a 240k-token conversation. It is cached, so it costs little time, but it fills the context and brings compaction closer. The other providers send it once.
3. **Muse ignores the profile's instructions.** Claude, Codex and Grok use `profile.instructions ?? WATCHER_SYSTEM_PROMPT`. Muse always sends the base prompt, so with worker roles on a Muse Watcher never gets the roles lines. This is a correctness gap, not a speed one.
4. **Large one-off results land in context.** `list_working_copies` 25k characters, `list_projects` 20k, `read_skill` 7 to 10k each. Small next to item 1, and not Muse-specific.
5. **No measurement of where the post-output wait comes from.** Sotto records the turn completing but not when the last output arrived, so the 21 s finish wait can only be inferred from activities.

## Not established

- **Why the finish wait is 21 s.** Probes show Muse runs a second task stream after the answer, which takes 1.8 to 4.3 s on a 30k prompt. With a 200k-token conversation it may take much longer, but I could not see inside Muse. This is for Muse's side to explain.
- **Why first-word latency varies from about 5 s to 27 s** on an identical prompt. I did not look into the cause; repeating the probe at different times of day would show whether it follows load.
- **Whether Wonder at medium would be faster in a real Watcher conversation.** The probe says effort barely changes reasoning on trivial prompts. Hard turns were not tested.

## Recommended fixes

1. **Cut the round trips.** Add a line to Watcher's prompt, or a Muse-specific one, that a news line carrying the worker's reply is enough to act on and `read_thread` is for when it is not. Longer term, #1142's design (news carries the thread's state) removes the reason to read. This is the largest change Sotto can make itself: if a Muse news turn matched Claude's one call with no tool, it would drop from about four calls to one. Untested.
2. **Send Watcher's instructions to Muse once,** with the first message and again after a compaction or resume, not with every send. Keep `museWatcherTyped` able to strip them from history.
3. **Use `profile.instructions ?? WATCHER_SYSTEM_PROMPT` for Muse,** as the other adapters do.
4. **Record the finish wait.** Stamp turn start, first item, last item and `turn/completed` arrival in the Muse adapter and write the gaps into `turns.jsonl` timings. That settles item 5 and gives Muse something concrete to look at.
5. **Report to Muse's maintainers:** model-step latency of about 5 to 27 s on a 30k prompt, and a median 21.6 s between the last output and `turn/completed` in a long session.
6. **Until then,** run Watcher on Claude Code or Codex. Medium instead of xhigh on Muse is worth a try but is not expected to help.

## Method notes

Turn durations and finish waits come from the `turn`, `tool` and `reasoning` activity records and message events (`threads.sqlite`); per-call tokens and cache reads from `token_rows`; send timings from `turns.jsonl`. News turns are the user messages listed in `wake_ups`. Probes ran from an empty temporary folder with the Muse 1.4.12 and Claude Code 2.1.309 binaries Sotto uses; no Watcher thread was started or changed.

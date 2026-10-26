# Why a Muse Watcher slowed down and looked stuck

October 25, 2026, for #1552. Sources: Sotto's own stores under `%APPDATA%\sotto` (`turns.jsonl` send timings, `threads.sqlite` messages, activities and wake-ups, `usage.sqlite` token rows). Watcher thread `20403f30`, Muse session `ae3b0b80`, `muse-wonder-full-1.0`, 16:50 to 18:16 UTC. No prompt text was copied.

## Answer

- **The "still running" replies were not news.** Sotto sent this Watcher nine wake-ups in the whole session. From 17:10 to 17:52 it sent none: the glow thread's finish was held while its background work ran, as it should be. All of the replies in that time came from one Watcher turn (`ee1f3eeb`, 2,563 s) in which Muse called `read_thread` on the glow thread 84 times, every 20 to 30 seconds, and wrote a status reply after each. A second turn did the same more slowly from 17:55 until the user interrupted it at 18:12. This is how Muse behaved, and Sotto never told it what to do instead while a thread works (fixed in #1552).
- **The slow replies are Muse's model time, made worse by the growing conversation.** Sotto's part of each send stayed flat at 1.2 to 2.5 s. Tools ran in 0.1 to 1 s. The rest is time between Muse's model calls, and it rose with the conversation's size. The rereads are what grew the conversation.
- **Compaction works on Muse.** It is not a no-op.

## Evidence

### Sotto's part of each send

`turns.jsonl`, the eight sends and wake-ups to this Watcher: admission 120 to 510 ms, preparation 290 to 1,413 ms, adapter 41 to 67 ms, acknowledgement 246 to 716 ms, total 1.2 to 2.5 s. It did not grow over the session. `firstOutputMs`, the wait from Sotto's send to Muse's first output, did: 12 s, 25 s, 7 s, 13 s, 10 s, 32 s, 65 s, then 103 s.

### Model call time against context size

The gap between one Muse model call and the next, from `usage.sqlite` (257 calls), by the call's input size:

| Input tokens | Calls | Median gap | p90 gap |
| --- | --- | --- | --- |
| 50k to 100k | 15 | 9.6 s | 47.8 s |
| 100k to 150k | 53 | 11.6 s | 26.2 s |
| 150k to 200k | 82 | 14.8 s | 31.5 s |
| 200k to 250k | 74 | 10.6 s | 25.4 s |
| 250k to 300k | 32 | 19.8 s | 77.1 s |

Past 285k the gaps between calls were 97 s, 57 s, 174 s and 142 s, then six minutes with no output after a call at 288,798 tokens with nothing cached. That is the "tool call over 2.5 minutes": the tools themselves took under a second.

Caching worked on almost every call (98 to 99% of input read from cache). Three calls had nothing cached: the first, one at 241k and one at 289k.

### The rereads

- In turn `ee1f3eeb`, 84 `read_thread` calls on one thread, five `read_operation` calls, two `read_skill` calls and 82 short assistant replies. Most reads returned the same 1,205 or 1,567 characters as the read before.
- Input grew from 154k tokens at 17:09 to 260k at 17:50, about 1.2k per reread and reply.
- Across the session, 116 of the Watcher’s 155 tool calls were `read_thread`.

### Compaction

The user's compact command at 18:12:12 returned in 436 ms; that is Sotto sending `session/compact` and Muse accepting it. Muse's compaction item ran from 18:12:13 for 28.9 s. The next model call read 62,391 input tokens, against 288,798 for the last call before. The session ID stays the same because Muse compacts in place. `contextTokenEstimate` 0 in `turns.jsonl` is Sotto's memory-context figure, which commands do not have; it says nothing about Muse's context.

The first reply after compaction took 103 s on that 62k-token call, with 30k of it cached. That is slower than any call of that size earlier in the session, and Sotto's part was 1.4 s, so it is Muse's time, not Sotto's.

## Not established

- Why Muse's first call after compaction took 103 s. Possibly a cold cache after the rewrite, but only Muse can see that.
- Whether the prompt line and `unchangedSince` stop Muse rereading. They are wording and a mark, not a limit, and were not tried against a live Muse Watcher. The measure is `read_thread` calls per Watcher turn while a watched thread runs, before and after.

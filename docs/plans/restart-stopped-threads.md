# Restart stopped threads

Plan for ADR-0144, an Owl feature (`restart-stopped-threads` in `src/shared/owlFeatures.ts`). The mock-up is `design/limit-restart/mockup.html`, kept as the tag `prototype/limit-restart`.

## What Zach asked for (October 26, 2026, through Watcher)

"One thing we need to rework is the wakeup feature. I think we can remove it. I really just use you to rewake my threads. The one thing that would be nice though is a continue feature. Something that starts you back up, which then you would start your watched threads, and any un-watched threads back up if you hit a usage limit."

His answers:

1. Remove both wake-ups: babysitting's pull request wake-ups (ADR-0061) and the resume note after Sotto restarts (ADR-0076). The new restart covers both cases.
2. It runs on its own when the limit resets, with a quiet note that a restart is scheduled.
3. It restarts every thread that was working when the limit hit (a turn running, or waiting on background work), watched or not.
4. Any provider's limit counts. If Watcher's own provider was cut off, Watcher goes first.
5. Watcher keeps all its pull request news (checks, reviews, conflicts, merged). It runs the merge train from it.

His picks from the mock-up:

- **Placement: B and C together.** A band at the top of the Threads sidebar, one per provider: "Claude Code's limit resets at 3:00 PM. Sotto restarts 4 threads then." with the threads' names and **Don't restart them**. A strip over the stopped thread's composer: "Restarts at 3:00 PM, when Claude Code's limit resets." with **Don't restart**. Each stopped thread's sidebar row reads "Restarts at 3:00 PM".
- **Sotto sends**, then tells Watcher. Each thread gets the same short note, Watcher first when its own provider stopped it. Works with Watcher off.
- **Name: Restart stopped threads.** The setting is "Restart stopped threads", the note "Restarts at 3:00 PM", the message tag "Restarted". "Continue" already means a continued thread (ADR-0089).
- **An Owl feature first.** Stable keeps babysitting and the resume note until Zach sends it.
- **A provider that never says when its limit resets: left to the user.** No restart is scheduled. The band says "Devin didn't say when its limit resets, so Sotto can't restart its 2 threads on its own. Send again once it resets." There is no Don't restart, since nothing is scheduled.
- **Usage: Watcher's news counts as Watcher's**, and the wake-up line goes. "You sent 412 and Watcher 88."

## The contract (already in the tree)

- `src/shared/limitRestart.ts`: `RESTART_STOPPED_FEATURE`, `limitRestartNote(provider)`, `LIMIT_RESTARTS_IN_A_ROW_MAX`, `LIMIT_RESTART_GRACE_MS`, `LIMIT_RESTART_HORIZON_MS`, `scheduledRestartSchema` / `ScheduledRestart`, `limitRestartNewsSchema` / `LimitRestartNews`, `LimitStopReport`.
- `AgentThread.scheduledRestart?: ScheduledRestart` (`src/shared/agents.ts`). Set by the host's coordinator, read by clients.
- `AgentCommand` `{ type: 'cancel-restart', threadId }`: the user's Don't restart. The band's Don't restart them sends one per thread.
- `src/shared/owlFeatures.ts` entry `restart-stopped-threads`, `sentToStable: false`.

## Main (with the feature on)

Read the Owl answer once at start, as every Owl feature is. With it off, nothing below runs and stable is exactly as it is today.

1. **Limit stops, every provider that says.** Each adapter tells the coordinator when a turn stopped at a usage limit, with a `LimitStopReport`.
   - Claude Code: `claudeTurnFailure.ts` already knows `usage-limit`. Keep the epoch Claude Code appends (`|1761500000`) as an instant; a spoken time ("resets 3pm (America/Chicago)") becomes the next such instant in that zone, or none if it can't be read. The stored sentence is unchanged.
   - Codex: classify a final turn error that is a usage limit (the app-server's `codexErrorInfo` `usageLimitExceeded`, or HTTP 429 without a retry). Its reset is the newest quota reading's window that is at 100% or `limited` (`providerQuota.ts`, `account/rateLimits/*`).
   - Grok Build and Muse: only when their stop says it was the limit; reset from their quota reading (Muse's `resetsAtMs`; Grok's `period.end` only when that window is the exhausted one).
   - Devin, OpenCode, DeepSeek Harness, Cursor: none today. Report a limit stop only where the provider's own structured error says so, with no reset.
   - Spending limits are not usage limits: they never reset on their own, so they schedule nothing.
2. **The record.** `limit-restarts.json` beside `restart-resume.json`, an `AtomicJsonStore` with a zod schema: per thread, `{ threadId, provider, stoppedAt, at?, restarts }`, thread IDs and times only. A thread is recorded when its turn stops at a usage limit, and also any thread on the same provider that had background work running at the moment of the first stop (it was working). The newest stop for a thread replaces its older one. A record with no `at`, or an `at` beyond the horizon, never fires.
3. **The timer.** One `setTimeout` to the soonest due `at`, rearmed on every change and at start from the file. No sweep that copies state; read it as `idleCompaction.ts` does.
4. **At the reset**, per provider due:
   - Drop any thread the user has sent to since `stoppedAt`, that is running now, that is archived, or whose provider is not connected (keep it until the provider connects, then go).
   - Watcher's own thread first, when it is among them. Then the rest, in the order they stopped.
   - Each gets `limitRestartNote(name)` through `control.deliverWakeUp(threadId, news)` with `LimitRestartNews`, ahead of the user's own follow-ups, as the resume note goes. A note the provider refuses leaves the queue, as the resume note's does.
   - If a restart turn stops at the limit again, it is recorded again with the new reset and `restarts + 1`; past `LIMIT_RESTARTS_IN_A_ROW_MAX` it waits for the user. A turn of the thread's own that finishes resets the count.
   - Then Watcher, when it is on, hears one piece of news: "Sotto restarted N threads Claude Code's limit had stopped: …", naming each thread and whether it is watched. A new `WatcherEvent` kind, `threads-restarted`, outside the request index, since unwatched threads count too.
5. **Don't restart.** `cancel-restart` drops the thread's record; its snapshot's `scheduledRestart` goes.
6. **Publishing.** The coordinator sets `scheduledRestart` on the thread from the record and clears it when the record goes. Copy nothing on the update path; the record is a small map read by ID (`streamingCopyBudget`, `copySites`).
7. **After Sotto restarts.** The resume note stays the mechanism (`restartResume.ts`) under the new setting `restartStoppedThreads`, with its words unchanged and the tag "Restarted". With the feature on, `resumeThreadsAfterRestart` is not read.
8. **Babysitting goes, the reader stays for Watcher.** With the feature on:
   - No `sotto_pull_requests` tool server for any thread (`pullRequestTools.ts`, `devinPolicy.ts`, `watcherProviderTools.ts`, `index.ts`). No `pull-request-babysit` host feature, so the iPhone hides its Babysit control. `babysit-pull-request` and `stop-babysitting` commands are refused with a plain sentence. No babysit wake-up is ever queued, and any saved one is dropped from the queue at start. Babysitting records on disk are left as they are, unread.
   - The GitHub reader in `babysitting.ts` (`runPass`, `readChunk`, `readGroup`, `githubBabysitReads.ts`, `gateOf`, `couldNotRunNotice`) reads the pull requests of **watched threads** (`watcherHooks.watchedThreadIds`: each thread's linked pull requests and its branch's) instead of babysat ones, with the same cost model (one batched fingerprint per repository, detail only when it moved, the pause and reserve rules). It feeds the same `observed` callback (`runtime.ts`): Watcher's `pullRequestObserved`, `notePullRequestState`, `mainCheckout.pullRequestMerged`. Nothing it reads becomes a thread's wake-up.
   - Watcher's settle hold, the clear-threads hold and "completely finished" stop counting babysitting.
9. **Usage.** A prompt with an `origin.operationId` counts as `watcher` before `wake-up`. Restart notes and delegation news stay `wake-up` in the store; the page no longer names them.

## Renderer (with the feature on)

`useOwlFeature('restart-stopped-threads')` before anything exists.

- **Band** at the top of the Threads sidebar, under search, one per provider that has threads with a `scheduledRestart`: "Claude Code's limit resets at 3:00 PM. Sotto restarts 4 threads then." (", Watcher first." when Watcher's thread is among them), the thread titles as a list whose entries open the thread, and **Don't restart them**. For threads with no `at`: "Devin didn't say when its limit resets, so Sotto can't restart its 2 threads on its own. Send again once it resets." and no button. A time on another day says the day ("tomorrow at 3:00 PM", "Thursday at 3:00 PM").
- **Strip** over the stopped thread's composer, as `ContinueStrip` sits: "Restarts at 3:00 PM, when Claude Code's limit resets." and **Don't restart**; with no `at`, "Devin didn't say when its limit resets. Send again once it has." Not shown in Watcher's own pane, whose band entry is enough.
- **Sidebar row** of a thread with an `at`: "Restarts at 3:00 PM" in place of its failure line, in the muted colour, not the warning one.
- **Transcript**: the restart note and the resume note show as sent by Sotto, tagged "Restarted".
- **Queue**: a restart note waiting in the queue reads "Sotto · Restart".
- **Pull request surface, sidebar, monitor**: no Babysit pull request, no hourglass row, no babysitting pose. With the host feature gone most of this hides already; check each.
- **Settings**: Git & worktrees loses "Let agents babysit pull requests". Threads → In a thread shows "Restart stopped threads" where "Resume threads after a restart" was, on by default: "When a provider's usage limit resets, or Sotto opens again after closing, every thread that was working carries on, with a short note from Sotto in the thread." Off: "A thread stopped by a usage limit or by Sotto closing waits for your next message."
- **Usage**: "You sent 412 and Watcher 88." No "N of them wake-ups" in Where you work. About these numbers: "Prompts are what you and Watcher sent, and Sotto's notes when it restarts a thread."

Keyboard: the band's list entries and both Don't restart buttons are reachable in reading order. The strip's button comes before the composer field. Escape does nothing new here, since nothing opens.

## Not in this change

- Deleting babysitting's code. Stable still runs it; it goes in the pull request that sends this feature to stable.
- Detecting limits for Devin, OpenCode, DeepSeek Harness and Cursor, which report none Sotto can read.

# Stopped threads restart when their limit resets

## Status

Accepted October 26, 2026, at Zach's request, as an Owl feature (`restart-stopped-threads`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). While the feature is on it supersedes the thread wake-ups of [ADR-0061](0061-a-thread-can-babysit-its-pull-request.md) (decisions 1 to 12, 14 and the look) and the setting of [ADR-0076](0076-threads-resume-after-sotto-restarts.md) (decision 1). ADR-0061's reader (its amendment of October 8, #823, and decision 13's cost) stays and now serves Watcher. ADR-0076's record, note and three-in-a-row rule stay under the new setting. With the feature off, both stand as written. The mock-up is `design/limit-restart/mockup.html`, kept as the tag `prototype/limit-restart`. Zach picked B and C together. The plan is `docs/plans/restart-stopped-threads.md`.

Zach, through Watcher: "One thing we need to rework is the wakeup feature. I think we can remove it. I really just use you to rewake my threads. The one thing that would be nice though is a continue feature. Something that starts you back up, which then you would start your watched threads, and any un-watched threads back up if you hit a usage limit."

## Context

Two things wake a thread on Sotto's own initiative. Babysitting sends a wake-up when a pull request needs the thread (ADR-0061). The resume note goes to a thread whose turn Sotto closing stopped (ADR-0076). Zach uses neither for what it was built for. He has Watcher wake his threads, and Watcher reads pull request news itself. What nothing does is carry on after a provider's usage limit. When Claude Code's limit hits, every thread on it stops, Watcher too when it runs on Claude Code. Each one waits until someone notices the limit has reset and sends again.

Sotto already reads limits. Claude Code's stop names its reset, and Sotto words it (`claudeTurnFailure.ts`, `limitStops.ts`). Codex, Grok Build and Muse report their windows and resets in their usage readings (`providerQuota.ts`). Devin, OpenCode, DeepSeek Harness and Cursor report none.

The word Zach used, "continue", already means a **continued thread** (ADR-0089): carrying a thread on to another provider. The chips under a usage-limit stop already read "Or continue now on". So this record does not use it.

## Decision

**1. The name is restart.** Sotto **restarts** a stopped thread: it sends the thread one note so the agent carries on. The setting is **Restart stopped threads**, a scheduled one reads "Restarts at 3:00 PM", and the thread shows the note tagged **Restarted**. Zach picked it over "Pick up" and "Carry on".

**2. A usage limit's stop schedules a restart at its reset.** When a thread's turn stops at a provider's usage limit, the thread's host records it with the reset the provider gave, as an instant. A thread on that provider that had background work running at the first stop is recorded too, since it was working. Spending limits never reset on their own and schedule nothing. The record is `limit-restarts.json` in the host's data folder, holding thread IDs, the provider and times only. It survives a restart.

**3. Every provider that says when counts.** Claude Code's reset comes from its stop. Codex's, Grok Build's and Muse's come from their own usage readings, taken from the window the stop used up. A provider that does not say when its limit resets gets no restart, and the thread waits for the user (Zach's pick). The same goes for a reset more than eight days away.

**4. At the reset, Sotto restarts them, Watcher first.** A minute after the reset, Sotto sends each recorded thread the note, through the thread's own send path and ahead of its queued messages, as the resume note goes. Watcher's own thread goes first when its provider stopped it. A thread the user has sent to since, a running one and an archived one are skipped. A thread whose provider is not connected waits for it. Watched or not makes no difference. Zach picked Sotto sending over Watcher sending each one its own message: it works with Watcher off and costs Watcher no turn per thread.

**5. The note.** Every provider receives the same words: "Claude Code's usage limit has reset. Your last turn stopped at the limit partway through, and any command or tool it was running stopped too, so its result may be missing. Check where things stand, then carry on." Like ADR-0076's note, it never re-sends the user's message, answers nothing and approves nothing. A thread is restarted at most three times in a row before a turn of its own finishes.

**6. Then Watcher hears it.** When Watcher is on, Sotto tells it which threads it restarted, and whether each is watched, as Watcher news. That covers unwatched threads too, which Watcher's other news never names.

**7. Where the user sees it: a band and a strip.** A band at the top of the Threads sidebar, one per provider: "Claude Code's limit resets at 3:00 PM. Sotto restarts 4 threads then.", the threads' titles, and **Don't restart them**. A strip over the stopped thread's composer: "Restarts at 3:00 PM, when Claude Code's limit resets." with **Don't restart**. The thread's sidebar row reads "Restarts at 3:00 PM" in place of its failure. For a provider that gave no reset, the band reads "Devin didn't say when its limit resets, so Sotto can't restart its 2 threads on its own. Send again once it resets." with no button. Zach picked the band and the strip together over a line in the transcript.

**8. After Sotto restarts, the same setting.** ADR-0076's resume note now runs under **Restart stopped threads**, shows tagged **Restarted**, and its words do not change. One switch, in Settings → Threads where "Resume threads after a restart" was, governs both, and it is on by default.

**9. Babysitting's wake-ups go; its reader stays for Watcher.** No thread gets a wake-up for a pull request. The `sotto_pull_requests` tool server is offered to no thread. The host stops advertising `pull-request-babysit`, so the iPhone hides its control. The Pull request surface loses **Babysit pull request**, and Settings loses "Let agents babysit pull requests". A wake-up saved in a queue is dropped at start. Babysitting records on disk are left as they are, unread. The reader that read babysat pull requests reads the pull requests of watched threads instead, at ADR-0061's cost. It feeds Watcher's pull request news: checks failed or passed, required checks passed, a review or comment, a conflict, a merge or close. Watcher runs the merge train from that news, so none of it is lost.

**10. Usage stops naming wake-ups.** A prompt Watcher sent counts as Watcher's, news turns included. The page reads "You sent 412 and Watcher 88." Restart notes and delegation news stay in the totals, and About these numbers says so.

**11. Owl first.** Stable keeps babysitting and the resume note's own setting until Zach sends this to stable. That change also deletes babysitting's code.

## Considered Options

- **Keep babysitting and add the restart.** Rejected by Zach: he doesn't use babysitting, and two ways for Sotto to wake a thread is one too many.
- **Watcher restarts each thread itself.** It would choose its words per thread, but it needs Watcher on and spends a Watcher turn for every thread. Zach picked Sotto.
- **Try a provider with no reset every hour.** It would bring Devin and the others in, at the cost of a failed turn each hour. Zach left those threads to the user.
- **A line under the stop in the transcript (variant A).** It is quieter, but it scatters across threads. Zach picked the band and the strip.

## Consequences

- A limit no longer leaves Zach's threads stopped until he comes back. A thread that stops again at the limit is scheduled again, up to three times in a row.
- Watcher's background pull request reads now follow the watched set rather than babysat pull requests, so a watched thread's pull request is read without anyone asking. README's "Privacy and cost" names the same GitHub reads.
- The iPhone needs no change: it already hides Babysit when the host does not offer it.
- Removing babysitting's code waits for the move to stable.

## October 28, 2026: threads leave CI to Watcher's news

The October 28 latency report (`~/Developer/Reports/sotto-pr-latency-2026-10-28.md`, fix 8) found threads waiting on CI with `gh pr checks --watch` in the shell. A restart killed one (#1707, about 2 minutes), and the watch waited for Gates (Windows) when a shard had already failed 6 minutes earlier. It proposed babysitting, which decision 9 retired. Drake chose Watcher's pull request news instead. That news already says checks failed once any check fails, before the rest finish, and its reader starts again with Sotto and reads every watched pull request afresh, where a shell watch is simply gone.

While this feature is on, and so the news runs, `watcherPrompt.ts` tells Watcher that a watched thread which pushed to a pull request ends its turn rather than watching CI. On a failure, Watcher sends the thread back to read which check failed and fix it, or to merge the base branch in when the base already has the fix. When the required checks pass, it sends the thread to merge. With the feature off Watcher hears nothing of checks, so it is not told this. `AGENTS.md` tells threads the same, with that condition. The news still names no check, because Watcher's evidence stays text-free. The thread reads the name with `gh pr checks` when it is sent back.

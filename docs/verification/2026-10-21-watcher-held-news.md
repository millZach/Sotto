# Held news that went unseen, and news told twice: what was checked

October 21, 2026. Issue #1263, follow-up to #1261. Evidence is from Zach's own Sotto data and Watcher's Claude Code session log on this laptop, read only, by identities and times; no prompt or reply text is quoted here.

## What happened on the night of October 20

- "Port audio-capture-bar to Windows" (`ebbe34ae…`, Claude Code), a thread Watcher watches, delegated a code review to a Codex thread (`430eb2eb…`) at 07:05 UTC. That delegation read `background` from 07:15 for 7.5 hours (#1261).
- The Port thread got the delegation's `background` news at 07:15:08 and finished its turn at 07:15:13, with nothing running. That finish is news Watcher should have had within a minute.
- Watcher's session log shows no news at all from 07:06:24 to 14:53:42, for any thread. At 14:53:42 one note carried the 07:15 finish beside receipts and finishes from much earlier, and Watcher called it "old news replayed". From 14:54 to 15:02 the same two lines, `Pull request #1221: merged` and `#1253: merged`, came once a minute.
- The computer was awake (no power events in the System log), and Sotto's Codex processes ran the whole night.

## The cause

Watched live at 15:56 on October 21: Watcher's hidden wake-up reached Watcher (it answered at 15:56:57), but Sotto's queue held it as `uncertain` ("The provider has not confirmed this user message in its state"). While it was there, `watcherWakeUpQueued()` held every later piece of Watcher's news. Watcher next heard anything at 16:26:43, including a question card raised at about 16:00, which should have gone within seconds.

A thread outside the watched set carries no messages in a snapshot, and the queue never put the thread it was sending to in that set. So the read that confirms a send found no echo whenever no window showed Watcher. The send stayed `uncertain` until something else had Watcher observed. It then settled `unknown`, and an `unknown` send forgets what it carried, so everything was told again: the replayed note at 14:53, and, while the user worked in another thread, a `merged` line every minute.

The 20-minute release of a busy finish was not what failed. The 7.5-hour hold was the delegation's `background` outcome, which had no release at all, and a delegated thread makes no Watcher news of its own. Watcher's own release did fire, but its line still said the turn was not done and work-settled news would follow.

## The tests

Each failed before the change that makes it pass. Run against `main`'s source for the same files.

- `tests/integration/wakeUpUnviewedThread.test.ts`: news to a thread the user moved away from, a delegation's and Watcher's, is sent and confirmed, and leaves the queue. Before: the delegation's news never reached the parent, and Watcher's wake-up stayed in its queue.
- `tests/integration/delegationHeldRelease.test.ts`: a delegation ends `background` with a monitor running. At 19 minutes nothing is said. At 21 the delegating thread is told once: "held 21 minutes, thread idle" and the start of the delegated thread's last reply. `read_delegation` says the same, and an hour later nothing more is sent.
- `tests/unit/main/watcherWakeUp.test.ts`, under #1263: a finish held twenty minutes opens "Held 20 minutes, thread idle." with its reply's start; a merged pull request is not told again after an `unknown` send; failed checks still are; a receipt refused with `THREAD_TAKEN_OVER` or `THREAD_BUSY` is no news.
- Two existing tests changed. `watcherStandingWatch` now declares that the user steers from Watcher's window, since the fixture's first observed set otherwise left Watcher's messages out. `watcherSettleFinished` turns the setting off before Watcher's turn ends: it passed before only because the unconfirmed wake-up delayed settling.

A failed GitHub read between two reads that say `merged` was also checked as a cause of the repeats. It tells nothing twice on `main`, so nothing was changed there.

Not checked in the running app: the fix needs a build of Sotto, and the evidence above comes from the installed one.

# Threads resume after Sotto restarts

## Status

Accepted October 12, 2026, by the owner's choice, as an Owl feature (ADR-0072). The owner asked for "a setting that
allows threads to resume whenever the app restarts", "a toggle in application settings that is on by default", and
chose that it covers any stop: a restart for an update, Quit, a crash or a restart of the computer. Asked what a
resumed thread should be sent, they asked for the choice to be researched against T3 Code, then approved the note
below and a limit of three resumes in a row (`docs/prototypes/update-all-prototype.html`).

It clarifies rather than reverses the rules that Sotto never sends anything twice (ADR-0058), never replays a retired
provider's evidence (ADR-0007) and never replays a follow-up whose dispatch was interrupted: the note is Sotto's own
message, not a copy of the user's. It adds a record of what was working, which ADR-0046 does without; the unread
mark it describes is unchanged.

## Context

Quitting closes every provider process on this computer. Claude Code, Codex, Grok Build and Devin each resume their
own session the next time a thread is used (ADR-0016, ADR-0057), but the turn that was running is gone, and nothing
told the agent so. The thread sat stopped until the user noticed and sent "carry on". With Update all (ADR-0077)
asking to restart Sotto while agents work, that became something Sotto did to the user several times a day on Owl.

T3 Code checkpoints a running turn and, after a restart, sends the thread "Continue where you left off." (Codex gets
a turn with no text), stops after three continuations in a row, and turned the setting on by default.

## Decision

**1. A setting, on by default, behind the Owl list.** Settings → Application gains "Resume threads after a restart"
(`resumeThreadsAfterRestart`). Only a process whose Owl list turns on `resume-after-restart` shows it, records
anything or resumes anything; stable leaves any record an Owl build wrote untouched.

**2. What is recorded, and when.** The local host's coordinator keeps `restart-resume.json` in its data folder:
for each thread a connected provider reports running, its Sotto thread ID, when the turn started, and how many times
in a row it has been resumed. No text, no provider identifier. A thread leaves the record when its turn ends while
Sotto runs, however it ends: finished, failed, stopped by the user, or ended by its provider process exiting. The
record stops changing the moment Sotto starts closing, so the stops that closing causes are not read as turns ending.
A crash leaves the last record written.

**3. Any stop counts.** An update restart, Quit, a crash and a restart of the computer all leave the same record,
and the next start reads it the same way.

**4. What the next start does.** With the setting on, each recorded thread that is not settled or archived is sent
a resume note once its provider is connected and reports the thread not running. The note goes through the wake-up
path babysitting built (ADR-0061 decision 8): Sotto's own item in the thread's follow-up queue, sent when the thread is
ready. Unlike other wake-ups it goes ahead of the user's follow-ups, which were queued behind the turn it resumes, so
the turn ends before they go; a queue paused because that turn did not finish takes the note as its review. With the
setting off, the record is cleared and nothing is sent. A record older than seven days is cleared unsent. A note
already saved in a queue goes only while the feature and the setting are both on, so a build or a setting without them
sends nothing.

**5. The note.** Every provider receives the same words:

> Sotto restarted while you were working on this, and your last turn stopped partway. Any command or tool that was
> running was stopped too, so its result may be missing. Check where things stand, then carry on.

It says what happened and that a running command was stopped, so an agent checks a test run or a build rather than
assuming it finished. The thread shows it as Sotto's, with Sotto's mark, a "Resumed" tag and every word the provider
received. Codex is sent the same words rather than T3's empty turn, so what the user reads is what was sent. A
message is told as a resume note by its text only after the host's own record has marked it Sotto's; text alone
never makes a message Sotto's.

**6. Three in a row.** A thread is resumed at most three times before a turn of its own finishes. A fourth stop
leaves it for the user, so a crash that recurs cannot keep restarting work. Only the turn the note itself starts, which
the coordinator reports as it sends the note, carries the count; any other turn, the user's own included, starts again
from none, and the count resets whenever a turn ends while Sotto runs. A record goes when its note leaves the queue
unsent, and when its thread is deleted.

**7. Nothing is sent twice and nothing is approved.** The user's message is never re-sent. A delivery left uncertain
stays uncertain and still holds the thread (ADR-0058). A permission request open when Sotto closed was declined then;
the resumed agent asks again, and the user answers it (ADR-0004).

**8. Hosts follow their own Owl list.** The record lives in the runtime the desktop and a headless host share, but a
host reads its Owl list from its own version, and a host runs a stable host build. A host's threads keep running when
the desktop quits (ADR-0025), so only a restart of the host itself stops them; those resume once this feature is sent
to stable. Until then Update all waits for a host's working threads before restarting it (ADR-0077).

## Consequences

- A resumed thread has one more user-role message than the user wrote, marked as Sotto's.
- The note goes only once the provider reports the thread idle. A provider that reports a turn it lost as still in
  progress leaves the thread waiting, as it did before.
- `restart-resume.json` is written when a turn starts or ends, not while it streams.

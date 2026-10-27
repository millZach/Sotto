# An unsent thread is listed on no client, and its host removes it

## Status

Accepted October 27, 2026, at Drake's report that four empty "New thread" rows sat among real threads on the iPhone and on no desktop list. It extends to the iPhone the rule the desktop's sidebar already follows (`listedRows` in `src/renderer/src/agents/unsentThreads.ts`), and touches [ADR-0033](0033-the-desktop-lets-paired-phones-reach-its-threads.md), under which a paired iPhone opens threads. It changes nothing in the host protocol. 0151 is claimed by an open pull request, so this takes 0152.

Amended October 27, 2026, at Drake's word that the empty records should not be there at all: the host now removes an unsent thread no client holds. Decisions 2 and 4 are replaced; see decisions 5 to 8. It gives [ADR-0140](0140-settled-threads-can-be-cleared.md)'s deletion a second caller, outside its Owl gate, and touches [ADR-0041](0041-a-worktree-has-an-end.md) only through that deletion's worktree guards.

## Context

New thread on the desktop and on the iPhone both send `create-thread` as soon as it is confirmed, so the thread has a Sotto thread ID, a composer and a folder before its first message. The desktop leaves the record on its computer and lists it only once something is typed or attached in its composer, or a send from it is under way; New thread then goes back to an unused thread that matches instead of making another (#347). The iPhone listed every thread its computer shared, so each New thread opened and backed out of stayed on Threads as "New thread" with no first message.

## Decision

1. **One rule for every list.** A thread is unsent while it is on its default title (`titleSource: "default"`), idle, asking nothing, not delegated, not settled and with no messages (`summary.messageCount` 0). The iPhone's Threads tab leaves an unsent thread out unless it is the thread open on the iPhone or the iPhone holds something for it: words, photos or files in its reply box, a refused reply, or an operation on it not yet confirmed, such as its own creation or a first send (`ThreadGroups.isUnsent` and `FocusThreads` in SottoCore). The desktop's sidebar keeps its own rule, which is the same.
2. **Hidden, not removed.** Each client decides from what it holds. The host cannot see an iPhone's reply box, so it removes nothing and hides nothing; a thread one client lists because something is typed there stays out of the other's list until the first message is sent.
3. **Compatible both ways.** The iPhone reads `titleSource` and `summary.messageCount`, which every published thread already carries. A computer that sends neither proves nothing, so its threads stay listed as before. No feature flag and no protocol version is needed.
4. **Records already left behind.** Empty threads left by earlier iPhone builds meet the rule, so they leave the iPhone's list with this build, as they were never on the desktop's. They stay on their computer; settling one or sending to it works as for any thread.

5. **The host removes an unsent thread no client holds.** On every host, at start and every hour, the worktree sweep (ADR-0041) first asks the coordinator to remove unsent threads. One goes when all of these hold (`unsentThreadRemovable` in `src/main/agents/threadClearing.ts`):
   - it is unsent as in decision 1, its title was not taken from a first message, and its provider session never started (`nativeSessionStarted: false`);
   - nothing is running, compacting, asked, queued, babysat or watched for it, it delegated to no thread, and it has no open pull request;
   - no client holds it: no connected client, desktop pane or phone, observes it; it is not the desktop's composer or active thread; no saved composer draft for it holds words, an attachment or a file; and no delivery record names it, so a send that failed or is still unconfirmed keeps it;
   - it is from before this run, or it was made in this run more than an hour ago.
   Anything in doubt keeps it. A phone's reply box lives on the phone, so the host counts it only while the phone is connected and has the thread open; a phone that typed into a new thread and then lost its connection for an hour loses that thread, and its words stay in its own reply box.
6. **It is ADR-0140's deletion.** The coordinator hands the list to the workspace's `deleteThreads`, which checks each thread again in its own lane, asking the rule again too, removes the thread's own worktree only under ADR-0041's guards (a fresh worktree holding nothing of the user's goes with it; one with changes, ignored files or another user keeps the thread), and erases the record, its creation record and its alias, adding its ID to the cleared list so no snapshot brings it back. Clear settled threads stays an Owl feature; this removal runs on stable too, since it shows nothing and fixes a bug, and its log line is `unsent-threads-removed` with a count.
7. **Records already left behind go at the first start.** Unsent threads from before this build are from before the run, so its first sweep removes those no client holds, on the desktop and on a headless host alike. The desktop's own unsent threads, from New thread opened and left, go the same way.
8. **New thread put away says nothing new.** The iPhone and the desktop send no command when New thread is dismissed: the hour and the holds cover it, and a destructive command from a phone would need the remote-answer policy (ADR-0140 decision 7) for a thread no list shows.

## Considered options

- **Create the thread on first send.** It would leave no record at all, but the iPhone's thread page, its reply box, attachments staged on the computer and the Watch chip all need the thread to exist first, and so does the desktop's. It would be a new command on both sides for a record no list shows.
- **Have the host drop unsent threads at start, or when New thread is put away**, with no holds. The host cannot tell an iPhone's typed reply from an empty one, so it could throw away words the user had not sent. The amendment removes them only when no client holds them (decision 5).
- **Hide them and keep the records** (decisions 2 and 4 as first accepted). Drake rejected it: the records are the bug, seen from the computer's side.
- **Reuse an unused thread on the iPhone, as the desktop does.** The iPhone does not see a thread's effort or permission mode in its list, so it cannot tell whether an unused thread matches what New thread would make. Hidden records cost a list nothing, so it is left for when the shell carries them.

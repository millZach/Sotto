# An unsent thread is listed on no client

## Status

Accepted October 27, 2026, at Drake's report that four empty "New thread" rows sat among real threads on the iPhone and on no desktop list. It extends to the iPhone the rule the desktop's sidebar already follows (`listedRows` in `src/renderer/src/agents/unsentThreads.ts`), and touches [ADR-0033](0033-the-desktop-lets-paired-phones-reach-its-threads.md), under which a paired iPhone opens threads. It changes nothing in the host protocol. 0151 to 0153 went to pull requests that merged first and 0154 is claimed by two open ones, so this takes 0155.

## Context

New thread on the desktop and on the iPhone both send `create-thread` as soon as it is confirmed, so the thread has a Sotto thread ID, a composer and a folder before its first message. The desktop leaves the record on its computer and lists it only once something is typed or attached in its composer, or a send from it is under way; New thread then goes back to an unused thread that matches instead of making another (#347). The iPhone listed every thread its computer shared, so each New thread opened and backed out of stayed on Threads as "New thread" with no first message.

## Decision

1. **One rule for every list.** A thread is unsent while it is on its default title (`titleSource: "default"`), idle, asking nothing, not delegated, not settled and with no messages (`summary.messageCount` 0). The iPhone's Threads tab leaves an unsent thread out unless it is the thread open on the iPhone or the iPhone holds something for it: words, photos or files in its reply box, a refused reply, or an operation on it not yet confirmed, such as its own creation or a first send (`ThreadGroups.isUnsent` and `FocusThreads` in SottoCore). The desktop's sidebar keeps its own rule, which is the same.
2. **Hidden, not removed.** Each client decides from what it holds. The host cannot see an iPhone's reply box, so it removes nothing and hides nothing; a thread one client lists because something is typed there stays out of the other's list until the first message is sent.
3. **Compatible both ways.** The iPhone reads `titleSource` and `summary.messageCount`, which every published thread already carries. A computer that sends neither proves nothing, so its threads stay listed as before. No feature flag and no protocol version is needed.
4. **Records already left behind.** Empty threads left by earlier iPhone builds meet the rule, so they leave the iPhone's list with this build, as they were never on the desktop's. They stay on their computer; settling one or sending to it works as for any thread.

## Considered options

- **Create the thread on first send.** It would leave no record at all, but the iPhone's thread page, its reply box, attachments staged on the computer and the Watch chip all need the thread to exist first, and so does the desktop's. It would be a new command on both sides for a record no list shows.
- **Have the host drop unsent threads at start, or when New thread is put away.** The host cannot tell an iPhone's typed reply from an empty one, so it could throw away words the user had not sent. Left out.
- **Reuse an unused thread on the iPhone, as the desktop does.** The iPhone does not see a thread's effort or permission mode in its list, so it cannot tell whether an unused thread matches what New thread would make. Hidden records cost a list nothing, so it is left for when the shell carries them.

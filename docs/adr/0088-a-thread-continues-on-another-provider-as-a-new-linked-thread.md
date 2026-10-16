# A thread continues on another provider as a new linked thread

## Status

Accepted by Zach on October 14, 2026, when he picked variant B ("in place") of the continue prototype (tag `prototype/continue-and-bring-back`, decision 10 of the Watcher engine ticket map, #1023). It is built with #1027 (ticket E4). It follows [ADR-0002](0002-sotto-owned-thread-identity.md) rather than amending it, uses the handover of [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md)'s provider change, and is an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Continuing on another machine waits for [ADR-0082](0082-work-moves-between-a-desktops-machines-over-its-own-ssh-link.md) (#1033).

## Context

A thread's provider session is fixed when the thread starts. Sotto refuses to move it ("Existing sessions cannot move between providers"), because the provider session is the provider's own state and ADR-0002 binds each Sotto thread to one session for good. The common reason to want another provider is a usage limit: Claude Code stops a turn at the plan's limit and Sotto already says so in its own words, with when it resets. Until now the user copied the conversation by hand into a new thread on another provider, or waited.

E3 (#1026) built a handover: a fixed-rule summary of a thread's history from Sotto's own record (ADR-0016), with no model call, that says what it carried and left out and that it is context, not a new request. Watcher uses it when its provider changes.

## Decision

**1. Continuing makes a new thread; it never moves one.** The **continued thread** has its own Sotto thread ID and its own provider session, on the provider and model the user chose, in the same project. The thread it continues keeps its session, its history and its folder, and stays readable and sendable: once its provider takes prompts again, the user can carry on there.

**2. Same folder by default.** The continued thread works in the source's own folder: the project folder for a thread on it, or the source's worktree, used again rather than copied. A new worktree made from the branch the source is on is the other choice. A source whose worktree was put away (ADR-0041) offers only the new worktree until a send brings its folder back.

**3. The handover goes with the first message.** The first message the user writes in the continued thread goes after the handover of the source, as one message, so no turn is spent on an acknowledgement. Main builds the handover when the message is sent. The continued thread's record keeps how many characters were the handover and their digest, never the words, and every copy (the pane, Copy and the phone) shows the handover as Sotto's beside the user's words by that record alone, as Watcher's first message does. A handover of a continued thread carries its first message's words without the older handover.

**4. Each thread links to the other.** The continued thread's record names the thread it continues and its provider ("Continued from"); the source's record lists the threads that continue it, newest last ("Continued in"), up to the newest hundred so a record cannot grow without end. The source is linked once the first message went; a refusal before that leaves the new thread unstarted, and a retry uses it again. Both are Sotto's record, kept on each thread's own record by Sotto thread ID, so the links survive a restart and a provider's update. The continued thread keeps the source's title: one the user typed stays theirs, and any other is kept as Sotto's, so naming from the first message, which begins with the handover, never renames it.

**5. Where it starts.** From the usage-limit (or spending-limit) error, "Or continue now on" offers each other connected provider on its default model; from the composer's model chip, "Continue in a new thread on" lists every other provider's models; and the pane's More menu has "Continue on another provider…", which opens the model picker on the other providers (the ticket's pane-menu entry, kept in place rather than as variant A's dialog). Each turns the composer into "Continue on Codex" (or whichever) with a strip above it naming the folder, the machine (This computer for now) and what the handover carries and leaves out, with the words on request. X or Escape puts it away. Nothing is sent until the user sends. The new thread starts on the user's new-thread permission default, never the source's, and the user can change it on the chip first.

**6. Refusals.** A thread with a turn running or a request waiting cannot be continued until it finishes; a thread nothing was sent to changes provider from its model chip instead; a thread Sotto holds no messages of has nothing to hand over; a provider that is not connected, not signed in or still connecting is shown disabled with why. Main checks each of these again when the user sends.

**7. This computer only, for now.** A thread on a paired host is refused in plain words. Continuing on another machine, and a paired host continuing its own threads, come with ADR-0082's work and an optional host-v1 feature then.

## Consequences

- "Existing sessions cannot move between providers" stays true. A continued thread is an ordinary thread in every other way: its own pane, requests, Git action and history.
- The handover is in the provider's record of the first message. A provider that reads its own history again shows the whole message, and Sotto splits it by the recorded digest; a message that no longer matches is shown whole.
- With Keep local history off, the handover carries only what Sotto holds in memory since it started, and says so (E3's rule).
- Stable builds no service, registers no bridge and shows none of it. A thread continued in Owl keeps its links on its record, and stable shows its first message whole.
- The iPhone and Android clients read no handover yet: a phone shows a continued thread's first message as the user's words alone, as it shows Watcher's.

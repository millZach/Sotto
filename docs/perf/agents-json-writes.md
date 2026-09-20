# Coordinator saves while a reply streams

What `agents.json` costs while a provider writes. The coordinator persists after every host snapshot
(`AgentControl.acceptSnapshot`), and `WorkspaceHost` publishes a snapshot at the end of every 16 ms
window while a reply streams. Each persist is an `AtomicJsonStore.write`: a fresh temporary file,
`fsync`, and a rename over `agents.json`, queued behind the write before it.

## Before

`agents.json` holds the coordinator's own facts: configuration, assignments, the attention queue, drafts,
the outbox and delivery receipts. A streaming chunk changes none of them, but every snapshot wrote the
file again. Measured with `tests/unit/main/agentPersistence.test.ts` over the fixture host, which
publishes one snapshot per frame with no coalescing between:

| | writes |
| --- | ---: |
| 50 streaming frames, nothing saved changed | 50 |

In the running app the workspace's 16 ms window bounds this at about sixty `fsync`ed writes a second for
as long as a reply streams, all of them putting the same bytes back. The store serialises them, so a
slow disk turns the queue into a backlog that a real save (a draft, a delivery receipt) then waits behind.

## After

`persist()` serialises what it would write and compares it with what the last successful write put on
disk. Equal bytes cost no write; a failed write leaves the comparison alone so the next attempt writes.
Everything else about the path is unchanged: `saved()` still runs (it also upgrades the legacy draft),
a changed fact still writes exactly once, and the draft-persistence publish that follows a write still
follows a skipped one.

| | writes |
| --- | ---: |
| 50 streaming frames, nothing saved changed | 0 |
| One configuration change | 1 |
| The same change again | 0 |

The test asserts each of these rows, and that a write which fails is retried with the same content.

## Also in this change

- The request-draft lookup in `src/main/index.ts` read `agentControl.get()`, which copies every viewed
  thread's history, on every coalesced publish for every held request draft. It reads only the thread's
  requests and status, which the shell carries, so it reads `shell()` now.
- `summarizeThread` parsed each message's `createdAt` twice while finding the newest one. It parses once.

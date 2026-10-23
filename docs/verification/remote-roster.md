# A remote parent's delegated threads in Tools › Agents — 2026-10-23

A thread on a headless host delegates to threads on its own machine (#1310), but the desktop's Tools › Agents listed them from their `delegatedBy` links alone, with no brief, outcome or card, since the delegation record is the host's. Zach picked variant B of the remote roster prototype on October 23, 2026: a heading per machine with a count. He also decided that a machine's rows keep their last outcome greyed while it is away, and chose the words for a start held because this computer cannot answer there, and for a start refused for asking for another machine. ADR-0081's October 23 amendment (the remote roster) records it. All of it is behind the Owl feature Work across machines; stable shows none of it.

## What Sotto does now

- **The data.** A host that runs delegation for its own threads lists `delegation-views` to a recorded desktop and answers `delegation-views` and `delegation-brief` from its own record, never a reply, and pushes `delegations-changed`. The desktop's router reads a remote thread's delegations there, keys every ID by that host, and keeps the last read of each thread in memory.
- **The roster.** Tools › Agents groups the delegated threads under a heading per machine, the delegating thread's own first, with a count: "Forge 4 threads · 2 working". Each row has its brief, kind of work, model, effort, start, outcome and time, as for a thread on this computer, both levels. A roster of this computer's threads alone keeps its single list.
- **Held.** A start the host held at Ask for approval says why on its row and card: "Started at Ask for approval: Forge had no new-thread default from this computer yet." or "Held at Ask for approval: this computer can't answer on Forge." (the reason only, until #1447 gives it a control of its own). Opened, a row held because Forge was not told says "Forge hasn't had this computer's defaults yet. It gets them the next time this computer connects to it; new threads there use them from then, unless this computer can't answer there." A grant taken away says "Forge no longer lets this computer answer there." and offers no fix.
- **Refused.** A start that asked for another machine or system is refused, and its card names what it asked for: "Asked for a Mac. Forge can start threads only on Forge for now. Nothing was started."
- **Away.** When the host disconnects, each row keeps its last outcome greyed, "Working when last read", with "as of" the time Sotto lost the connection, and its clock stops. The heading says "not connected", and a notice above the roster says "Forge is not connected. These threads are as Sotto last read them at 2:47 pm. Losing the connection stops nothing on Forge." The cards say "Working when last read" and how it stood then. Connected again, every row is read afresh from the host's own record.

## Automated checks

- `tests/unit/main/remoteDelegations.test.ts`: keyed reads, an older host, the last read kept as of the loss, told again on reconnect, a read from a replaced connection dropped, the bound.
- `tests/unit/renderer/tools/remoteRoster.test.tsx`: grouping only with Work across machines and another machine, counts, last-read rows and words, held lines, the refusal words, the cards connected and away, the older-host note, and stable showing none of it.
- `tests/integration/hostDelegation.test.ts`: over a real headless host's socket and loopback tool server with Codex's fake app server, the read, the push on change, the held reasons including a revoked grant, the refusal's `asked`, the brief, the last read while the host is away and a fresh read after reconnecting; a stable host and an unrecorded client are offered nothing.

## In the running app

`tests/e2e/remote-roster.spec.ts` runs the built Owl app against a real headless host in the test process, connected through the e2e remote host harness (real socket, router, IPC and renderer), with Codex's fake app server on the host. Tool calls go through the host's own `sotto_delegate` server with each thread's token. At each size and theme it checks that nothing overflows and that the roster's text, headings, notice and cards are 4.5:1 on what they sit on. Reduced motion is on. Captures are in `artifacts/remote-roster/` (`SOTTO_E2E_EVIDENCE=publish`):

- `cards-dark-1280x800.png`: the parent's transcript, its cards naming Forge, both held lines and the refused card.
- `roster-{dark,light}-{1600x1000,1280x800,820x560}.png`: Tools › Agents under the Forge heading, "4 threads · 2 working", both levels, held lines.
- `roster-opened-dark-1280x800.png`: a held row opened from the keyboard to its whole brief and the held reason.
- `away-{dark,light}-{1600x1000,1280x800,820x560}.png`: Forge disconnected: greyed "… when last read" rows, "as of", "not connected" and the notice.
- `reconnected-dark-1280x800.png`: connected again and read afresh; the review that answered while away reads Answered.

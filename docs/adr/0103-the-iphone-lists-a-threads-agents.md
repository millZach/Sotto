# The iPhone lists a thread's agents

Accepted by Zach on October 21, 2026 (#1200). An Owl feature (ADR-0072), `iphone-agents-view` in `src/shared/owlFeatures.ts`: a stable host offers none of it, and the phone shows none of it.

A thread on the desktop lists its delegated threads (ADR-0081) and its provider's own sub-agents in Tools › Agents. Once #1279 took delegated threads off the phone's thread list, the phone had no way to reach them, or to see what a thread's sub-agents were doing.

## What the phone shows

Variant A of `docs/prototypes/iphone-agents-view-prototype.html`, Zach's pick on October 21, 2026. Variant B (a Threads | Agents switch at the top of the Threads tab) and variant C (a line on each delegating thread's card that opens in place) were rejected.

- A thread's top bar has **Agents** with a count: its delegated threads, both levels, and its sub-agents. While a delegated thread needs the user it carries the Needs you light: it waits on a permission or a question, settled or not (ADR-0081 decision 11), or its last turn failed and no client has shown it (ADR-0092, read from the shell's `failureSeen` where the host lists `failure-seen`). It is there only while the thread has either.
- Agents opens a sheet that lists them newest start first, each delegated thread followed by its own, as Tools › Agents does (`delegatedRoster.ts`). A row carries the title, Thread or Agent, the brief, provider · kind of work · model · start time, the outcome in the glossary's words and the time it has worked. Above the list a line counts them and says what needs the user and what is working.
- A delegated thread's row opens that thread, and Back returns to the sheet. One that waits on the user says **Open to answer**, as the desktop does; it opens the thread, where its request is answered as any other. Nothing in the sheet answers anything (ADR-0004).
- A failed delegated thread no client has shown says **Needs attention**, as its desktop row does, with nothing to answer. Settled is quiet: apart from a waiting request, a settled thread's rows carry no colour and never say Just finished or Needs attention.
- A sub-agent's row opens in place to its task and its latest update or result, read again when the agent's run, revision or status changes and on a refresh. A workflow's run is one row with its agents under it, as Tools › Agents keeps it apart, and no count includes it.

## What the host sends

A host whose Owl answer turns the view on lists the `agents-view` feature and answers `thread-delegations` (`docs/host-protocol.md`). For one thread the read names each delegated thread below it, both levels, found by the snapshot's `delegatedBy` links: the thread that delegated to it, the kind of work, when the brief that started it was sent, its newest delegation's outcome and when that finished, whether the delegating thread is still waiting in its `delegate` call, and the first 600 characters of its newest brief. It is read from delegation's own record when the sheet opens, never pushed, and never carries the delegated thread's reply (ADR-0081 decision 7). The brief is already the delegated thread's first message, which the phone is sent when it opens that thread.

Delegation runs only on the desktop's own threads, so the read has rows only where `thread-delegation` is on too, and the shell carries `delegatedBy` only then. A headless host offers the view with its sub-agents alone. Sub-agents come from the `subagent-page` and `subagent-assignments` reads the `subagents` feature already offers, and the shell's `subagentSummary` counts them for the top bar.

## Why this keeps the promises

No host is added and nothing new leaves the computer: the phone reads, over its paired connection, what the desktop's own window reads of the same threads, minus every reply. Nothing is logged. The view answers no request and grants nothing; opening a waiting thread is the same press as opening it from the list.

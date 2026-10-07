# Typing starts a thread's provider session

## Status

Accepted October 6, 2026. The trigger is the owner's decision of October 5, 2026 on #769 ("A stopped session wakes on the first keystroke in its thread's composer, not on opening the thread"); the mechanism below is the agent's, made while building #769 under tracking issue #762. Amends [ADR-0038](0038-one-client-process-per-thread.md), whose consequences said connect starts the watched threads' processes together: Claude Code's connect started them one after another, and now starts them a few at a time. Keeps [ADR-0014](0014-thread-follows-its-worktree-branch.md) whole: nothing native, no worktree and no branch exists before the first send.

## Context

Pressing Send starts the thread's provider session first whenever it is not running, and the provider hears the prompt only after that. On the development machine Claude Code 2.1.289 took 1.0-1.3 s to start and answer `initialize`, with the user's hooks; the user's MCP servers add to it. A session is not running before Send in these cases: a new thread's first send, whose session the send itself creates; a thread whose session the reaper stopped or that ended on its own, whether the user sends to it from its composer or it is sent to off screen, from the queue, a follow-up or the coordinator; and, at app start, the watched threads whose CLIs Claude Code's adapter was still starting one after another.

The user starts typing well before pressing Send. That is time the start can use, as long as it starts nothing the send would not, and creates nothing the user did not ask for.

## Decision

**Early start.** The first keystroke in a thread's composer asks its host to start the thread's provider session now, the way the thread's next action would. `CONTEXT.md` has the term. Avoid "wake", which is the voice coordinator's wake phrase and wake session.

**The window asks once.** Each thread now says whether its provider session is open on its host (`providerSessionOpen`, published by the adapter and never saved). A window asks for a thread whose session is not open, once, and asks again only after it has seen that session open: a session the reaper stopped is asked for the next time the user types, and one already open is never asked for. A host that does not publish the flag gets one ask per thread for as long as the window runs.

**One command, in the thread's lane, saying nothing.** `start-thread-session` is a thread command. It takes its place in the thread's own lane in the coordinator and in the workspace, so a send typed meanwhile waits behind it and finds the session it started. It marks nothing busy, writes nothing and reports nothing, and its own handling publishes nothing: a session it opened says so through `providerSessionOpen` in the adapter's next snapshot, as a session opened any other way does. A start that fails leaves the send to start the session and report its own error, as it always has. It is counted as activity by the session reaper.

**What each provider does.**

| Provider | Thread whose native session exists | New thread, before its first send |
| --- | --- | --- |
| Claude Code | starts its CLI, `--resume` or `--session-id`, as a send would | a **spare**: the CLI the first send would start, on the session ID it will create the thread under, in the folder it will run in, answered `initialize` and nothing more |
| Codex | resumes the thread on its own app-server, as opening it does | starts the app-server the first send would use and introduces itself; `thread/start` waits for the send, since it makes a Codex thread |
| Grok Build | `session/load` on the thread's own process, as a send would | starts the process the first send would use, checked and signed in; `session/new` waits for the send, since it makes a Grok session |
| Devin | opens its session, as its next action would | nothing: Devin's process opens on a session, and making one is the send's |

A spare runs in the thread's folder, so Claude Code starts one only when that folder already exists and is the one the first send will use, the project checkout the thread shares. A thread getting a new worktree gets no spare, because the first send makes the worktree; its draft names no folder (`ThreadSessionDraft`). Codex's app-server and Grok's process run outside the thread's folder, so they start for that thread too.

**A spare creates nothing native.** Claude Code writes a session file only once a prompt arrives. `tests/integration/claudeEarlyStartLive.test.ts` checked that against 2.1.289 for spares the thread's creation took and for one let go: none wrote one. The spare's session ID is held in memory by the Sotto thread host (`SottoThreadHost.unbound`) and the adapter, and nothing is bound or saved until the send. The send adopts the spare only when it creates the thread with exactly what the spare was started with: the folder, the model, the effort, the permission mode, and whether the thread now has the host setup tools. Anything else stops the spare and the send starts the thread's own CLI. That CLI runs another session ID than the spare's, so it starts without waiting for the spare to exit. Should a Claude Code ever write a session file at `initialize`, the thread would resume the spare's session, so a session file already on that ID makes the thread wait for the spare to exit before resuming it: one session never has two CLIs. A spare nobody sends to is stopped by the reaper after the usual thirty idle minutes, or at disconnect or a client update.

**Connect starts the watched set's CLIs four at a time.** Each Claude Code CLI is a process of its own that takes about a second to answer `initialize`. Four at a time keeps a send to the last of them from waiting on all the others, without a burst of processes on a machine with many panes open.

**Remote hosts and the iPhone.** A paired host takes `start-thread-session` like any other thread command (`src/host/remoteCommands.ts`), so a remote host's threads get the same early start once that host is updated. The desktop router sends it to the thread's own host and swallows a refusal, so a host that predates it, is away or refuses it changes nothing and says nothing. Unlike other thread commands, the desktop reads nothing back after the host answers: a session the start opened shows in the host's next push, and a read there would cost a whole-thread read just before the send and could show an error. Host protocol version 1 is unchanged: the command is optional, the thread flag is optional, and the iPhone client neither sends one nor reads the other.

## Consequences

- A new Claude Code thread's first send no longer pays its CLI's start when the user typed for longer than that start takes: 1.0-1.5 s before against about 5 ms after on Claude Code 2.1.289 (`docs/perf/2026-10-06-early-start.md`). The rest of a first send is unchanged.
- A thread the user types into and never sends holds a process for up to thirty minutes, as a thread used and left does. It holds no provider session and no record.
- Typing in a stopped thread starts its process even when the user then deletes the draft. That costs a process start and no tokens; nothing is sent to a model. A Claude Code CLI started this way runs the user's own Claude Code hooks and MCP servers in the project folder, as opening a thread does, even for a message that is never sent.
- Only typing starts a session early. A thread sent to off screen, from the queue, a follow-up or the coordinator, after the reaper stopped its session still starts it inside that send, as before.
- Changing a new thread's model, effort or permission mode after typing makes its first send start a CLI of its own; the composer does not ask again, because a spare was already started for that thread.
- A spare belongs to no thread its adapter publishes, so no host can say it stopped, and the window cannot see a spare the reaper let go. The composer does not ask again for that thread before its first send, which then starts the CLI itself, as it did before early start. Publishing a flag for a thread that does not exist yet would mean a record before the send.

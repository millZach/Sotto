# One provider process per thread

## Status

Accepted September 28, 2026. Follows T3 Code (`pingdotgg/t3code`, `apps/server/src/provider/`). Amends ADR-0042, whose client update no longer disconnects the provider, and extends to Codex and Grok Build what Claude Code already did: a process per thread or chat.

## Context

Pressing Update on a provider client disconnected the provider, ran the installer and connected again, so every working thread on that provider was cut off for as long as npm ran. ADR-0042 gave the reason as "Windows refuses to overwrite a running executable". Measured on Windows 11 ([evidence](../verification/2026-09-28-client-update-over-running-executable.md)), that is only half true: a running executable cannot be overwritten in place, but its folder can be renamed while it runs, and a real `npm install -g` of a package whose executable was running exited 0, installed the new version and let the old process finish. Grok Build's own installer moves its running `grok.exe` aside to `grok.exe.old`, and Claude Code's updater replaces `~/.local/bin/claude.exe` while sessions run.

So the installer can run while threads work. What stopped Sotto doing that was its own process model. Claude Code already ran one CLI per thread. Codex ran one `codex app-server` for every thread on the provider, and Grok Build ran one ACP process that reached every session through Grok's shared leader. With one process, a thread either stays on the old client until every thread is idle at once, or the process is restarted and the working threads lose their turns. Grok's leader makes it worse: its source (`xai-org/grok-build`, `leader/mod.rs`) shows that a client newer than the running leader asks it to relaunch on the new binary, and the leader gives running turns five seconds before it exits. One thread started on the new client would end every other thread's turn.

T3 Code had already solved this. Its maintenance runner installs the update without stopping, disconnecting or restarting any session, then reads the provider's version from the binary on disk. Its Codex and Grok adapters keep a session per thread, and each session starts its own `codex app-server` or `grok agent stdio`. A working thread keeps its old process, and the next process a thread starts is the new version.

## Decision

**Every provider runs one process per thread session.** Claude Code runs a CLI per thread, as before. Codex runs a `codex app-server` per thread, launched on first need. Grok Build runs `grok agent --no-leader stdio` per thread, so no Grok process is shared and none can be told to relaunch by a newer one. A thread's live work, its history reads and its requests go to its own process, and an answer goes back to the process that asked. Devin is unchanged: it runs inside the Devin app and updates with it.

**A process that ends on its own affects only its thread.** The provider stays connected, a reply the process was writing is marked failed with a line saying it may be cut short, its unanswerable requests are dropped, and the next action on the thread starts a new process. This was Claude Code's rule; it is now every provider's.

**A client update moves each thread to the new client as it goes idle.** After a good install the coordinator tells the provider's adapter, which finds the client again the way connect does (the path may have moved into a new npm package folder), reads the version from the binary on disk, and then:

- stops every process that is not busy at once, the way the idle reaper stops one, so nothing is shown and the thread's next action starts the new client;
- marks every busy process to stop the moment it is no longer busy, so a working thread finishes its turn, and a thread waiting on a request keeps waiting for the user, on the old client;
- starts a watched thread again on the new client straight away, because a watched thread always has a process.

It never disconnects the provider, cancels a turn or answers a request. A version reported later by a process started from the old client does not replace the newer one. Personal chats are told the same way and stay connected.

A new client the adapter cannot find, that does not answer, or that Sotto would refuse on connect is not moved to. Every adapter handles that the same way: nothing is stopped, the provider's version stays the one its threads run, and the adapter says what happened, that nothing was lost and what to do next. The update reports that sentence rather than calling the client updated.

A process being created, or a send between its first read of the thread and the prompt leaving, counts as busy, as does an answer the process still owes Sotto after its deadline, since a late answer is still applied. An idle process is let go by closing its input, and forced only if it has not exited within the request deadline.

**The provider-level process is for what no thread owns.** Codex keeps one app-server that never holds a thread: `initialize`, the model list, the account, skills for a folder and `config/read`, which every create and resume needs and which a process per call would pay a start for each time. One that stopped is started again for the next read; one that cannot start fails that read alone and disconnects nothing. A client update starts a new one, reads the version and models from it and lets the old one finish the replies it owes. Grok Build keeps none between connects: connect and a client update check the client and sign-in on a short-lived process and close it. Claude Code needs none.

## Consequences

**A process per open thread.** Before, Codex and Grok ran one process per connection. Now each runs one per live thread session: the threads on screen, the threads used in the last 30 minutes, and every saved personal chat, since personal chats are always watched. The session reaper bounds the rest: it sweeps every five minutes and stops a session idle for 30, and a thread with a running turn, a request waiting or background work is never stopped. The first action on a thread whose process was stopped pays a process start and a handshake before it resumes, and connect starts the watched threads' processes together. (October 6, 2026: Claude Code's connect started them one after another and now starts them four at a time, and typing in a thread's composer starts its process before the action that needs it; see [ADR-0055](0055-typing-starts-a-threads-provider-session.md).) Whether personal chats should stay outside the reaper is left open.

**A Grok turn no longer outlives Sotto.** The shared leader used to keep a turn running after Sotto quit. Now it ends with its process, as Codex and Claude Code turns already did. Grok's history would show such a turn running forever and refuse every later send, so the adapter records how it ended in the thread's alias (interrupted when Sotto closed the process, failed when it died on its own) and the thread reads as idle or as an error. A Grok session another process holds, such as one taken over in the Grok CLI, has not yet been checked against a live `--no-leader` process.

**The fakes are multi-process.** `fakeCodexAppServer.mjs` and `fakeGrokThreadAgent.mjs` share their state across processes under a file lock, and each records which process did what. Every adapter that takes client updates passes the client update case in `tests/integration/adapterContract.ts`: a working thread's turn completes across the update, the provider stays connected and the version is read again.

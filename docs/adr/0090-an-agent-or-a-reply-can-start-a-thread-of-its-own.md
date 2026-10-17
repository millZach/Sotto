# An agent or a reply can start a thread of its own

## Status

Accepted by Zach on October 14, 2026, when he picked variant B, in place, of the continue prototype (tag `prototype/continue-and-bring-back`, decision 10 of the Watcher engine ticket map, #1023). It is built with #1028: Continue as a thread (ticket E5) first, and Fork from here (E5b) in a change stacked on it. It keeps [ADR-0002](0002-sotto-owned-thread-ids.md) whole and is an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It relies on the handover of #1026 (CONTEXT.md, **Handover**).

## Context

A thread's agents show in the Agents roster and nowhere else. The roster only observes: a **subagent** is not a Sotto thread or a target for commands (CONTEXT.md). When an agent's result is worth pursuing, the user has to start a new thread and retell it what the agent was doing.

Codex runs each sub-agent as a full Codex thread, and Codex 0.162.1's app-server can copy one (`thread/fork`). The e5-fork spike (#1028, October 14) found that a durable fork of a sub-agent's thread makes a new top-level thread that carries the agent's whole conversation, its task included, which Codex keeps encrypted; that `cwd` puts the copy in another folder; that `lastTurnId` copies a thread up to one of its turns under the source's own turn IDs; and that the copy reads its history from its source's rollout. Claude Code keeps a subagent's working history inside its own session, where Sotto cannot copy it, but Sotto stores the task and result it reported. Claude Code's own session fork is the one Sotto already uses to rewind a thread.

## Decision

**1. An agent continues as a thread of its own, and leaves its parent as it was.** A finished agent's row in the roster offers Continue as a thread. It makes a new Sotto thread in the parent's project, with its own Sotto thread ID, in the same folder by default or a new worktree. The same folder is the parent's own: its worktree when it works in one, so the agent's work is where the new thread starts. A new worktree starts from the branch the parent works on. The agent's row and the parent thread do not change. A working agent is refused until it finishes, and so is one Sotto last saw working before a restart or a lost connection, until it is seen to finish.

- **Codex:** the new thread is Codex's own durable fork of the agent's thread, made without its turns in the answer and read back with `thread/turns/list`. Sotto never reads the agent's task: it travels inside the copy, encrypted, and the new thread opens with a note Sotto writes saying so, in place of a brief it cannot show.
- **Claude Code:** the new thread starts from a **thin handover** of the agent's task and the result it reported, which says plainly that it is thin. It goes ahead of the new thread's first message, as the handover does after a Watcher provider change, so no turn is spent on it.
- **Grok Build and Devin** report no agents to Sotto, so they have no rows to continue.

**2. Fork from here starts a thread at a reply.** The newest reply of a finished turn offers Fork from here, which draws a card into the transcript at that reply and labels everything below it "Not carried". Codex forks natively at the reply's turn (`lastTurnId`); Claude Code forks through the session fork rewind uses, into its thread's own folder, since the copy lives with its source's session; files are not rewound, which the card says. Grok Build, Devin and Muse start from a handover of the conversation up to that reply, read from Sotto's own record, which goes with the first message as the thin handover does. A fork is titled "Fork of …", and a thread with a turn running is refused until it ends. Sotto's note on a forked thread sits under the last reply it copied, where the fork's own conversation begins.

**3. The binding is made when the thread is.** A forked thread is bound to its provider's copy the moment the provider confirms it, the way creation binds a thread to its provider session (ADR-0002), and a restart keeps the binding. A thread that starts from a handover is bound on its first send, as any new thread is. The new thread records where it began by the source's Sotto thread ID alone (`startedFrom`), never a provider's identifier.

**4. A Codex fork depends on its source's rollout.** Codex keeps a fork's history in its source's rollout. If that rollout is removed, Codex can no longer read, resume or fork the copy; the thread then says so in plain words and keeps what Sotto shows. An archived source still reads. Sotto never archives, unarchives or deletes a Codex rollout: an agent whose conversation Codex keeps archived is refused in plain words, and the user unarchives it in Codex. When Codex no longer has an agent's conversation at all, the row offers a thin handover of the agent's title and result instead.

**5. Refusals make nothing, and are said where they were asked.** A refused or unconfirmed fork leaves no thread behind, and a new worktree made for it is removed again. A worktree that cannot be removed then keeps the thread, as an ordinary unstarted one, and the refusal says so: the worktree sweep and Remove folder reach only a thread's worktree (ADR-0041), so a folder without one would be lost track of. An unconfirmed fork is never asked for twice, and Codex's answer to it, should one come later, binds nothing; Codex may have kept a copy, which Sotto leaves alone. A refusal answers in the agent's row, never as the window's banner.

**5a. The handover goes with the first message the provider takes.** A first send the provider refuses puts the handover back, and the next send carries it, even when the provider's session had already started. Once a send went with it, or may have, no later message carries it again.

**6. Paired hosts.** A thread on a paired host continues its agents on that host. The command is on the host's remote allow-list, and the host lists the optional `thread-starts` feature when it offers it; an older host is refused in plain words and nothing is made.

**7. Owl.** `continue-agent-thread` is an Owl feature. Stable shows and starts none of it, and keeps a forked thread's record whole. A first message that went with a handover shows on stable as it was sent.

**8. History off keeps no agent words.** With Keep local history off, the saved record of where a thread began keeps the source's thread ID and the route, not the agent's title, which may be its task's words (ADR-0016). The handover itself is built from Sotto's roster whenever it is needed and kept nowhere else. The new thread's own title is a thread title, kept as every thread's is, and the user can rename it.

## Consequences

- The **Subagent** entry in CONTEXT.md stays true: the agent remains observational, and continuing it makes a new thread from a copy or a handover.
- Fork carries its source's turn IDs. What Sotto keys by a native turn or item ID is keyed by its thread as well (`codex.ts`, `codexActivity.ts`), and a fork never takes its source's agents.
- A fork opens Codex's usual connection to the Responses API, as opening any Codex thread does; no host is added.

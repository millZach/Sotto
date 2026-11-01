# The next prompt reaches new threads and remote hosts

## Status

Accepted October 31, 2026, at Drake Morey's ask: "ghost text should also show on new threads and remote hosts, make it work everywhere". The source for a new thread is his: "it looks at project recent work and recent thread titles and brainstorms several potential ideas (ideas meaning new avenues, follow up work, etc) and the ghost text is its #1 idea." Still part of the `next-prompt` Owl feature. **Number provisional until merge** (docs/agents/domain.md).

Amends [ADR-0132](0132-a-finished-turn-suggests-the-next-prompt.md): decision 1 (a new thread and a thread at rest after a restart are asked too, and a new thread's material is its project) its consequence that remote hosts are left out, and decision 8's name for the switch.

## Context

The next prompt came only after a turn ended on this computer. Three places never showed one:

- **A new thread.** It has no conversation to predict from.
- **A thread on a remote host.** A headless host built no next prompts, and the host protocol had no message to carry them.
- **A thread at rest after Sotto restarted.** Main holds next prompts in memory only, so a restart or an Owl update let go of every one until each thread's next turn ended.

## Decision

**1. A new thread is asked for its first prompt when a client first shows it.** A thread with no message from the user yet, at rest, is asked once, on its own provider as a title is (ADR-0026). Its own provider is told the project's recent work: the folder's branch, its latest eight commit subjects and up to twenty uncommitted file names. It is also told the titles of the user's latest eight named threads in the same project, on any provider. Default titles, Watcher's threads and the thread itself are left out. The instruction asks it to brainstorm distinct ideas (follow-up work, unfinished work, checks worth running, new avenues) and rank them. Its #1 idea is the ghost, and the next four are the Next list's suggestions, under the same four intents. Its headline says where the project stands. The reply is read exactly as ADR-0132 decision 2 reads one. A new Watcher thread, a delegated thread and a project with no recent work and no named threads are asked nothing. Its first accepted send lets the suggestion go, as any send does.

**2. A thread at rest after a restart is asked once, when a client first shows it.** A thread that ended on an answer and has nothing held for it since Sotto started is asked from its history, as a thread that finished unseen already is. Turns the user stopped, turns that failed, Watcher's answers to Sotto's news and delegated threads are still asked nothing.

**3. A headless host builds its own and pushes them to the desktops that want them.** The host builds next prompts for its threads, from its own providers, under its own `next-prompt` Owl answer. It lists a new host feature, `next-prompts`, to desktops only; phones are never offered it or sent anything. A desktop whose own Owl answer is on accepts it in its hello and then tells the host, with `next-prompts-wanted`, whether its **Suggest a next prompt** switch is on. It tells the host again whenever the switch changes. While no connected desktop wants them, the host asks its providers nothing. A desktop that wants them is pushed every one the host holds (`next-prompts`), then each change (`next-prompt`, a let-go one with no prompt). A thread that client is not sent is never named to it. The desktop keeps what each host pushed, and lets go of what a host no longer holds when it reconnects. The window reads and hears them under the same keys as every other thread the router joins. The window's bridge no longer depends on this computer's own host being on.

**4. Grok Build and Cursor answer a new thread before its session exists.** Their side writers were always sessions of their own; only a guard waited for the thread's session. That guard now lets the next prompt through, and titles still wait. OpenCode starts no server for a thread before its session exists, and Muse, Devin and DeepSeek have no side call, so their new threads get none.

**5. The switch is named for both.** It was **Suggest a next prompt after each turn**; it is now **Suggest a next prompt**, since it also covers a new thread, which has had no turn. Its description says a new thread's suggestion reads the project's recent work and the user's latest thread titles there. While it is off, a thread shown is not looked at, so turning it on later lets the next show ask.

## Consequences

- Opening a new thread costs one short request on its provider, and opening a thread after a restart costs one more. Both count against the same limits as the thread's own work, and the same switch turns them off.
- The titles of the user's other threads in a project can go to a different provider than the one each ran on. The README's privacy section says so.
- The host protocol gains one desktop-only feature, one request and two pushes. Older desktops and hosts, and every phone, carry on as before. A newer desktop with an older host simply gets no suggestions for that host's threads.
- Next prompts are still never saved, on this computer or on a host.

## Considered options

- **Only the project's recent work**, without other threads' titles. Nothing from other threads goes to this provider, but the guesses are weaker. Drake chose to include the titles.
- **Local only, no side call**: offer the user's own recent first prompts in the project. Free and instant, but it only repeats what was sent before.
- **The desktop asking on a host's behalf.** The side call belongs on the thread's own provider client, which runs on the host.

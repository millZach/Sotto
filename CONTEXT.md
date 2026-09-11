# Sotto domain context

Sotto is a desktop dictation app that is becoming a voice development coordinator: the user talks to Sotto, and Sotto manages the coding agents. This file is the glossary for that domain. Use these terms in issues, tests and code; do not drift to the synonyms each entry lists as avoided.

## Threads

**Thread.** A conversation with one coding agent about one project, owned by Sotto. A thread has a Sotto thread ID, a title, a project, a model, a status (idle, running, error), messages and pending requests. Threads are a core Sotto function: memory, goals, assignments and the attention queue refer to threads by Sotto thread ID and never by a provider's own identifier. Avoid: "T3 thread", "conversation", "chat".

**Sotto thread ID.** An opaque ID that Sotto assigns the first time it sees or creates a thread, normally a fresh UUID. It outlives any provider session and is the only thread identity that agent state, queue items and assignments carry.

**Provider.** The system that actually runs the agent for a thread. Today the only provider is `t3` (the local T3 Code host). Native providers (Codex, Claude, Grok) replace it later. In code, `Host` in a class name (`AgentHost`, `T3CodeHost`, `E2EAgentHost`) means a provider adapter.

**Provider session.** The provider's own identifier for the same thread, for example a T3 thread ID or a Codex thread ID. Provider session IDs exist only inside the provider adapter and in the thread registry. In prose and user-facing text say "provider session", not "session" on its own or "remote ID".

**Project.** A working folder the provider knows about, with an ID, a title and a path. A thread belongs to exactly one project.

**Thread binding.** The persisted record `Sotto thread ID → provider → provider session ID → project ID`. The **thread registry** stores bindings in `threads.json` in the user data folder, so the mapping survives a restart. Bindings are never deleted by Sotto; a provider that forgets a session leaves an orphan binding, which is harmless. On the first run after upgrading from a build without the registry (the saved coordinator state already refers to threads and the registry file does not exist), the provider's own IDs are adopted as Sotto thread IDs so saved assignments, drafts and queue items keep resolving.

**Thread interface.** The verbs the coordinator uses for any provider, with no provider identifiers in their signatures:

| Verb | Meaning | In code (`AgentHost`) |
|---|---|---|
| create | open a new thread in a project with a model | `execute({ type: 'create-thread' })` |
| resume | observe an existing thread's detail so events arrive for it | `observeThreads` (optional for adapters that always deliver detail) then `snapshot` |
| prompt | send a user message to a thread | `execute({ type: 'send' })` |
| cancel | interrupt the agent's current turn | `execute({ type: 'interrupt' })` |
| status | read every project, model and thread the provider knows | `snapshot` |
| events | subscribe to status changes pushed by the provider | `subscribe` |

Answering a question or permission request (`execute({ type: 'answer' })`) and creating a project are also part of the interface. `SottoThreadHost` in `src/main/agents/threads.ts` is the implementation that owns Sotto thread IDs and delegates to a provider adapter; `T3CodeHost` is the first provider adapter. `E2EAgentHost` is the fake adapter used by tests and end-to-end runs.

**Provider adapter.** An implementation of `AgentHost` that speaks one provider's protocol and identifiers. Avoid: "driver", "backend".

## Coordination

**Assignment.** Sotto's authority to reply automatically on a thread. Modes are `managed` (Sotto may send follow-ups within its limits) and `manual` (the user replied in the provider directly, so Sotto only watches). Selecting or reading a thread never creates an assignment. Avoid: "subscription", "watch".

**Attention queue.** The ordered list of threads that need the user: a thread is `ready` for a prompt, has a `question`, has a `permission` request, or is `blocked`. Permissions are never answered automatically and are never inferred. Avoid: "inbox", "notifications".

**Draft.** The one prompt or answer the user is composing, bound to a thread and optionally to a question request. A draft survives a restart.

**Outbox.** Durable intent for a dispatched command whose acknowledgement may be lost. Sotto reconciles outbox items against the next status rather than resending.

## Speech

**Wake phrase.** "Hey Sotto". Bare "Sotto" is not a wake phrase.

**Utterance.** One transcribed spoken command handled by the coordinator.

## Where things live

- `src/shared/agents.ts` — schemas for state, commands and snapshots shared with the renderer.
- `src/main/agents/control.ts` — the coordinator (`AgentControl`): assignments, queue, drafts, outbox.
- `src/main/agents/host.ts` — the `AgentHost` interface and command shapes.
- `src/main/agents/threads.ts` — thread registry and `SottoThreadHost`.
- `src/main/agents/t3.ts` — the T3 Code provider adapter.
- `docs/agent-control.md` — user-facing behaviour of agent control.
- `docs/adr/` — decisions, including ADR-0002 on Sotto-owned thread identity.

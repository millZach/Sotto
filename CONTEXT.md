# Sotto domain context

Sotto is a desktop dictation app that is becoming a voice development coordinator: the user talks to Sotto, and Sotto manages the coding agents. This file is the glossary for that domain. Use these terms in issues, tests and code; do not drift to the synonyms each entry lists as avoided.

## Threads

**Thread.** A conversation with one coding agent about one project, owned by Sotto. A thread has a Sotto thread ID, a title, a project, a model, a status (idle, running, error), messages and pending requests. Threads are a core Sotto function: memory, goals, assignments and the attention queue refer to threads by Sotto thread ID and never by a provider's own identifier. Avoid: "T3 thread", "conversation", "chat".

**Sotto thread ID.** An opaque ID that Sotto assigns the first time it sees or creates a thread, normally a fresh UUID. It outlives any provider session and is the only thread identity that agent state, queue items and assignments carry.

**Provider.** The system that actually runs the agent for a thread. Providers today are `t3` (the local T3 Code host, the default) and `codex` (a native Codex App Server child process). One provider is active at a time, chosen by `configuration.provider` when Sotto connects; Claude and Grok follow later. In code, `Host` in a class name (`AgentHost`, `T3CodeHost`, `CodexAppServerHost`, `E2EAgentHost`) means a provider adapter.

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

Answering a question or permission request (`execute({ type: 'answer' })`) and creating a project are also part of the interface. `SottoThreadHost` in `src/main/agents/threads.ts` is the implementation that owns Sotto thread IDs and delegates to a provider adapter; `T3CodeHost` is the first provider adapter and `CodexAppServerHost` the second. `E2EAgentHost` is the fake adapter used by tests and end-to-end runs.

**Provider adapter.** An implementation of `AgentHost` that speaks one provider's protocol and identifiers. Every adapter must pass the shared adapter contract in `tests/integration/adapterContract.ts`. Avoid: "driver", "backend".

**Codex provider session alias.** The adapter-owned record in `codex-threads.json` that maps the provider session ID Sotto chose at creation to the thread ID the Codex App Server assigned, plus the working directory, title, model and the digests of dispatched messages. The thread registry holds only the Sotto-chosen provider session ID; the Codex thread ID never leaves the adapter (ADR-0005).

**Codex session log.** Codex's own persisted transcript of a provider session (`rollout-*.jsonl` under `$CODEX_HOME/sessions`). Sotto reads only its user-authored entries to tell its own dispatched messages from text typed directly in Codex: a dispatched message's digest suppresses every consecutive log entry with the same digest, and any other authored entry is a takeover. Sotto never copies or logs the log's content.

**Takeover.** The user sends a message to an assigned thread directly through the provider (for example `codex resume` in the Codex CLI). The adapter reports that message as a user message with no command ID, so the coordinator switches the assignment to manual mode and keeps watching. Opening or reading a thread is not a takeover.

## Coordination

**Assignment.** Sotto's authority to reply automatically on a thread. Modes are `managed` (Sotto may send follow-ups within its limits) and `manual` (the user replied in the provider directly, so Sotto only watches). Selecting or reading a thread never creates an assignment. Avoid: "subscription", "watch".

**Attention queue.** The ordered list of threads that need the user: a thread is `ready` for a prompt, has a `question`, has a `permission` request, or is `blocked`. Permissions are never answered automatically and are never inferred. Avoid: "inbox", "notifications".

**Draft.** The one prompt or answer the user is composing, bound to a thread and optionally to a question request. A draft survives a restart.

**Turn.** One coordinator action from start to finish: a spoken utterance, a typed command, or an automatic follow-up sent by supervision. Every turn is recorded.

**Turn record.** One JSON line in `turns.jsonl` in the user data folder, written by the turn recorder when a turn finishes: source (`utterance`, `command` or `supervision`), the Sotto thread ID and project the turn acted on, the provider session resolved from the thread registry, timings (intent, retrieval, delegation, total; speech-to-intent and speech-to-first-feedback once the voice pipeline supplies an end-of-speech time), retrieved memory IDs (empty until memory exists), a context-token estimate, the outcome (`completed`, `clarified`, `failed`) and the text and error, which are blanked when Keep local history is off. Draft edits are not turns. Avoid: "trace", "log entry".

**Outbox.** Durable intent for a dispatched command whose acknowledgement may be lost. Sotto reconciles outbox items against the next status rather than resending.

## Speech

**Wake phrase.** "Hey Sotto". Bare "Sotto" is not a wake phrase.

**Utterance.** One transcribed spoken command handled by the coordinator.

## Memory

**Memory.** One remembered fact about the user, a project or the world, with the metadata the spec requires: type, scope, content, source class (explicit, observed, inferred, imported, agent-confirmed), confidence, evidence count, importance, temporal fields (created, last confirmed, last used, valid from, valid to), provenance, tags, state (active, superseded, disputed, temporary, archived) and authority (preference, policy, permission). Avoid: "fact", "note", "record".

**Memory store.** The SQLite database `memory.sqlite` in the user data folder, the single source of truth for accepted memories. It is opened by Node's built-in `node:sqlite` in the packaged Electron runtime, so production dependencies stay `zod` only, and it carries a full-text index for lexical retrieval. Search honours a memory's validity window and includes temporary memories that are current. See ADR-0003.

**Provenance.** Where a memory came from: a list of Sotto thread IDs with a reference into the thread (for example a turn record ID). Provenance never carries a provider session ID; the thread registry resolves that when needed.

**Memory store probe.** The check that proves the shipped build can use the store: the packaged executable is launched in a probe mode that opens the real memory store in a temporary user-data folder, migrates, inserts, answers a full-text query and prints its evidence. The packaged-resource verifier fails the build without it. A direct Node-only probe (`scripts/probe-memory-store.mjs`) exists for the Mac runtime check.

## Authority

**Policy record.** One row in the `policies` table of the memory store that carries authority: an action (`spend`, `publish`, `destroy`, `relax-verification`), a resource (`*` or a specific path, repository or provider), a scope (`global` or a project id), an effect (`allow` or `always-confirm`), a source (`user` or `questionnaire`), a note, and granted, expiry and revocation times. Policy records are the only thing that can authorize a risky action; a memory whose authority field says `permission` is evidence, never a grant. An `always-confirm` record beats any `allow`; expired or revoked records never allow. See ADR-0004. Avoid: "permission memory", "rule".

**Risky action.** A permission approval that the coordinator classifies from the request text as spending, publishing, destroying or relaxing verification. A request can carry several classes. Dispatch of a risky action consults policy before the provider sees the answer: supervision never answers a permission request, and the user's explicit Allow is the confirmation an `always-confirm` boundary requires. Avoid: "dangerous command", "privileged op".

**Risk boundary.** An action the user says Sotto must always confirm, captured by the questionnaire and stored as `always-confirm` policy records with source `questionnaire`, never as inferred memory.

## Memory evaluation

**SottoMemEval.** The product-specific memory benchmark in `scripts/memeval/`: labelled memory cases run against a pluggable backend, scored per category (recall, abstention, temporal adaptation, temporary exception, project leak, authority leak), printed as a table and saved with the backend name and case-set version. Run it with `npm run memeval`.

**Case.** One labelled scenario in a case set: a short history of provider events, a question asked as of a date and a project, and the expected outcome (an answer pattern, an abstention, or a forbidden leak pattern). Cases carry a `draft` or `reviewed` status until the founder has checked them. Avoid: "sample", "example".

**Case set.** A versioned file of cases (`scripts/memeval/cases/v1.json`). Results always name the case-set version they were scored against.

**Backend.** The memory system under test in SottoMemEval: it observes history events and answers questions, and never sees ground-truth labels. The `none` backend remembers nothing and always abstains; it is the required baseline. This is the one place "backend" is the right word; a provider adapter is never a backend.

## Where things live

- `src/shared/agents.ts` — schemas for state, commands and snapshots shared with the renderer.
- `src/main/agents/control.ts` — the coordinator (`AgentControl`): assignments, queue, drafts, outbox.
- `src/main/agents/host.ts` — the `AgentHost` interface and command shapes.
- `src/main/agents/threads.ts` — thread registry and `SottoThreadHost`.
- `src/main/agents/turns.ts` — the turn recorder and turn record schema.
- `src/main/agents/t3.ts` — the T3 Code provider adapter.
- `src/main/agents/codex.ts` — the Codex App Server provider adapter and its provider session aliases; `codexRequests.ts` normalises Codex permission and question requests and their answers; `codexSessionLog.ts` reads the Codex session log for takeover detection.
- `src/main/agents/providerSwitch.ts` — `ConfiguredProviderHost`, which picks the active provider adapter at connect.
- `tests/integration/adapterContract.ts` — the shared behavioural contract every provider adapter must pass; `tests/fixtures/fakeCodexAppServer.mjs` is the scripted fake Codex App Server it runs against.
- `docs/agent-control.md` — user-facing behaviour of agent control.
- `src/main/memory/` — the memory store, its migrations, the policy store, the runtime opener and the packaged probe.
- `src/main/agents/authority.ts` — the `Authority` interface and the risky-action classifier the coordinator consults at dispatch.
- `scripts/memeval/` — SottoMemEval harness, backends, case sets and results.
- `docs/adr/` — decisions, including ADR-0002 on Sotto-owned thread identity and ADR-0003 on the memory store, ADR-0004 on authority in policy records and ADR-0005 on the Codex App Server adapter.

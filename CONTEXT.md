# Sotto domain context

Sotto is a desktop dictation app that is becoming a voice development coordinator: the user talks to Sotto, and Sotto manages the coding agents. This file is the glossary for that domain. Use these terms in issues, tests and code; do not drift to the synonyms each entry lists as avoided.

## Threads

**Thread.** A conversation with one coding agent about one project, owned by Sotto. A thread has a Sotto thread ID, a title, a project, a model, a status (idle, running, error), messages and pending requests. Threads are a core Sotto function: memory, goals, assignments and the attention queue refer to threads by Sotto thread ID and never by a provider's own identifier. Avoid: "T3 thread", "conversation", "chat".

**Sotto thread ID.** An opaque ID that Sotto assigns the first time it sees or creates a thread, normally a fresh UUID. It outlives any provider session and is the only thread identity that agent state, queue items and assignments carry.

**Provider.** The installed native client that runs the agent for a thread: Codex, Claude Code or Grok Build. One provider is active at a time and retains its own sign-in; new installations initially select Codex.

**Provider session.** The native client's own identifier for a thread, distinct from the Sotto thread ID. In prose and user-facing text say "provider session", not "session" on its own or "remote ID".

**Project.** A working folder the provider knows about, with an ID, a title and a path. A thread belongs to exactly one project.

**Thread binding.** The durable relationship between a Sotto thread, its provider session and its project. Historical bindings survive a provider's retirement and never grant a replacement provider authority over that thread.

**Provider retirement.** An upgrade that stops using an old thread provider while retaining recovery evidence and the user's draft. Old assignments, answers and uncertain actions are not transferred or replayed through a native client.

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

**Assignment facts.** What the coordinator records on an assignment so the app can say how it started and why it stopped: `startedAt`, `origin` (`voice`, `typed` or `unknown`), `stopReason` (`none`, `limit`, `repeat` or `error`) and `stoppedAt`. A takeover clears the stop facts; a save failure only stamps `error` when nothing else stopped the assignment first.

**Threads page.** The management-window view that lists every thread the active provider knows, grouped as needs you, running, finished today and earlier days. Groups, states and the one-sentence summary derive only from the attention queue, assignments and thread status, never from provider-specific fields. Rows waiting on a decision carry the request inline with Allow and Deny; nothing else on the page answers a request. Attention rows are never hidden by search, and an open row's card shows the user's latest prompt. Avoid: "inbox", "dashboard".

**Attention queue.** The ordered list of threads that need the user: a thread is `ready` for a prompt, has a `question`, has a `permission` request, or is `blocked`. Permissions are never answered automatically and are never inferred. Avoid: "inbox", "notifications".

**Draft.** The one prompt or answer the user is composing, bound to a thread and optionally to a question request. A draft survives a restart.

**Turn.** One coordinator action from start to finish: a spoken utterance, a typed command, or an automatic follow-up sent by supervision. Every turn is recorded.

**Turn record.** One JSON line in `turns.jsonl` in the user data folder, written by the turn recorder when a turn finishes: source (`utterance`, `command` or `supervision`), the Sotto thread ID and project the turn acted on, the provider session resolved from the thread registry, timings (intent, retrieval, delegation, total; speech-to-intent and speech-to-first-feedback once the voice pipeline supplies an end-of-speech time), retrieved memory IDs, a context-token estimate, the outcome (`completed`, `clarified`, `failed`) and the text and error, which are blanked when Keep local history is off. Draft edits are not turns. Avoid: "trace", "log entry".

**Outbox.** Durable intent for a dispatched command whose acknowledgement may be lost. Sotto reconciles outbox items against the next status rather than resending.

## Speech

**Wake phrase.** "Hey Sotto". Bare "Sotto" is not a wake phrase.

**Utterance.** One transcribed spoken command handled by the coordinator.

**Transcription.** Turning dictated audio into text. Since ADR-0006 there is exactly one route: each segment is encoded as a 16 kHz mono PCM16 WAV and sent from the main process to Microsoft MAI-Transcribe-2 through OpenRouter's transcription endpoint with the user's OpenRouter key. Nothing is transcribed on this computer and there is no fallback route; a failed request is reported with its reason. Avoid: "local model", "preset", "transcription server", "remote ASR".

**OpenRouter key.** The one API key the user supplies, stored encrypted in the operating system credential store under the `formatting` slot and never returned to the renderer. It pays for transcription, the cleanup pass and any OpenRouter-hosted reasoning. In settings code it is still the `llmApiKey` field.

**Personal dictionary.** The user's list of names and terms, one per line (`llmDictionary`). It is sent with every transcription request as an Azure phrase list so MAI spells those words as written, and it is also quoted in the cleanup prompt. Avoid: "vocabulary hints" in user-facing text.

**Cleanup pass.** The optional LLM pass over the finished transcript (punctuation, fillers, self-corrections, lists), run through OpenRouter chat completions at the chosen quality tier and skipped for very short transcripts. Audio never goes through it. Avoid: "polish" in user-facing text (the code still says `polish`).

**Segment.** One slice of a dictation, cut at a pause while streaming transcription is on, transcribed as its own request so the final text is ready almost as soon as the user stops. Avoid: "chunk".

## Memory

**Memory.** One remembered fact about the user, a project or the world, with the metadata the spec requires: type, scope, content, source class (explicit, observed, inferred, imported, agent-confirmed), confidence, evidence count, importance, temporal fields (created, last confirmed, last used, valid from, valid to), provenance, tags, state (active, superseded, disputed, temporary, archived) and authority (preference, policy, permission). Avoid: "fact", "note", "record".

**Memory store.** The SQLite database `memory.sqlite` in the user data folder, the single source of truth for accepted memories. It is opened by Node's built-in `node:sqlite` in the packaged Electron runtime, so production dependencies stay `zod` only, and it carries a full-text index for lexical retrieval. Search honours a memory's validity window and includes temporary memories that are current. See ADR-0003.

**Provenance.** Where a memory came from: a Sotto thread and reference, or a dated questionnaire answer or inspector correction. Questionnaire and inspector provenance do not invent a thread; provenance never carries a provider session ID.

**Working preferences.** The user's explicit answers about communication, autonomy, verification, git and review, agent choices, workflow and privacy. They guide coordinator replies without granting permissions or changing history settings.

**Retrieved preferences.** Current explicit memories relevant to the coordinator's question, drawn from the current thread, its project and global scope in that order. Irrelevant memories are omitted; retrieved preferences provide context, never authority.

**Memory inspector.** The Memory page where the user sees remembered content, its provenance and history, and can correct, supersede or delete it. Corrections retain earlier versions; deleting a memory removes its full chain of versions.

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

## Main window

**Crossing.** The main window's shell since redesign round 3: one black room under a thin strip, black only, set in Bricolage Grotesque. There is no light theme and no appearance setting; a persisted theme value is tolerated and ignored. The floating widget keeps its own look. Avoid: "dark mode" (there is no other mode).

**Strip.** The top bar of the main window: the Sotto mark on the left, the switch in the centre, the window controls on the right. It is the window's drag region.

**Switch.** The two-state control in the strip that flips the room between Dictate and Agents. It is a tablist; arrow keys move between the two. Avoid: "tabs" in prose.

**Room.** The single content area under the strip. The switch chooses the Dictate room or the Agents room; the footer links open the other pages (Threads, History, Dictionary, Settings, Help) in the same area.

**Dictate room.** The Dictate side of the switch: the large seven-bar wave, one sentence for the current state, one button with the shortcut, then the last transcript at reading size with Copy.

**Footer status.** The one-line status text on the right of the footer links, supplied by whichever page is open (for example the model and paste mode in the Dictate room, the thread count on the Threads page).

## Where things live

- `src/renderer/src/components/AppShell.tsx` — the Crossing shell: strip, switch, room, footer links and footer status.
- `src/renderer/src/features/dictate/DictateRoom.tsx` — the Dictate room.
- `src/main/asr/openRouterTranscriptionService.ts` — the transcription request to OpenRouter (MAI-Transcribe-2, phrase list, key check); `src/renderer/src/transcription/openRouterTranscriber.ts` encodes the WAV and calls it over IPC.
- `src/main/llm/transcriptPolishService.ts` — the cleanup pass.
- `scripts/asr-bench/` — the transcription bench (`bench-stt.mjs`) and its results; `docs/perf/` holds the decision reports.
- `src/renderer/src/styles/tokens.css` and `global.css` — the black token set and shared styles; `src/renderer/src/assets/fonts/` holds the bundled typefaces.
- `scripts/design-capture-matrix.mjs` — the design gate's capture matrix (one theme, scales, motion, focus).
- `src/shared/agents.ts` — schemas for state, commands and snapshots shared with the renderer.
- `src/main/agents/control.ts` — the coordinator (`AgentControl`): assignments, queue, drafts, outbox.
- `src/main/agents/host.ts` — the `AgentHost` interface and command shapes.
- `src/main/agents/threads.ts` — thread registry and `SottoThreadHost`.
- `src/main/agents/turns.ts` — the turn recorder and turn record schema.
- `src/main/agents/t3.ts` — the T3 Code provider adapter.
- `src/main/agents/codex.ts` — the Codex App Server provider adapter and its provider session aliases; `codexRequests.ts` normalises Codex permission and question requests and their answers; `codexSessionLog.ts` reads the Codex session log for takeover detection.
- `src/main/agents/providerSwitch.ts` — `ConfiguredProviderHost`, which picks the active provider adapter at connect.
- `tests/integration/adapterContract.ts` — the shared behavioural contract every provider adapter must pass; `tests/fixtures/fakeCodexAppServer.mjs` is the scripted fake Codex App Server it runs against.
- `src/renderer/src/agents/ThreadsView.tsx` — the Threads page; `threadFacts.ts` derives rows, groups, states and sentences from agent state.
- `docs/agent-control.md` — user-facing behaviour of agent control, including the Threads page.
- `src/main/memory/` — the memory store, its migrations, the policy store, the runtime opener and the packaged probe.
- `src/main/agents/authority.ts` — the `Authority` interface and the risky-action classifier the coordinator consults at dispatch.
- `scripts/memeval/` — SottoMemEval harness, backends, case sets and results.
- `docs/adr/` — decisions, including ADR-0002 on Sotto-owned thread identity and ADR-0003 on the memory store, ADR-0004 on authority in policy records, ADR-0005 on the Codex App Server adapter and ADR-0006 on hosted transcription through OpenRouter.

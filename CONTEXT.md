# Sotto domain context

Sotto is a desktop dictation app that is becoming a voice development coordinator: the user talks to Sotto, and Sotto manages the coding agents. This file is the glossary for that domain. Use these terms in issues, tests and code; do not drift to the synonyms each entry lists as avoided.

## Threads

**Thread.** A conversation with one coding agent about one project, owned by Sotto. A thread has a Sotto thread ID, a title, a project, a model, a status (idle, running, error), messages and pending requests. Threads are a core Sotto function: memory, goals, assignments and the attention queue refer to threads by Sotto thread ID and never by a provider's own identifier. Avoid: "T3 thread", "conversation", "chat" when referring to a project-bound thread.

**Thread title.** The thread's name in every surface that names it: sidebar, pane header, attention queue, widget and spoken summaries. It is Sotto's own record, renamed at any time from the sidebar row or the pane header and never pushed to the provider. A thread records whether its title was set by hand (`titleSource`): a name the user typed, in the New thread dialog or a rename, is `user`; a name Sotto's writing model wrote is `generated`; the stand-in "New thread" and any name a provider supplied are `default`. Anything that generates a title leaves a `user` one alone.

**Generated thread title.** The name Sotto writes for a thread that still carries a `default` one, once the first reply to its first message lands. The writing model sees that first message and that first reply alone, and is asked nothing while generated titles are off, while no OpenRouter key is stored, or while Keep local history is off. A failure leaves the stand-in name and is logged, never shown. Regenerate title asks again for a `default` or `generated` name; a `user` name is never offered for rewriting.

**Writing model.** The small OpenRouter model, chosen in Settings under Cleanup, that writes Sotto's own short text: thread titles and commit messages today, pull request text next. It reaches OpenRouter with the same stored key as transcript cleanup and transcription.

**Commit message draft.** The message the writing model drafts from the staged diff alone when the Changes panel's commit form opens, with an imperative subject under 72 characters and a body only where the change needs one. It is a draft: the user edits, clears or regenerates it, and only the Commit button commits it. With no OpenRouter key or generated commit messages off, the form opens empty.

**Sotto thread ID.** An opaque ID that Sotto assigns the first time it sees or creates a thread, normally a fresh UUID. It outlives any provider session and is the only thread identity that agent state, queue items and assignments carry.

**Provider.** The installed native client that runs the agent for a thread: Codex, Claude Code or Grok Build. Providers keep their own sign-ins and may be connected together; each thread's chosen model belongs to one provider.

**Provider session.** The native client's own identifier for a thread, distinct from the Sotto thread ID. In prose and user-facing text say "provider session", not "session" on its own or "remote ID".

**Project.** A working folder the provider knows about, with an ID, a title and a path. A thread belongs to exactly one project.

**Thread working copy.** The folder in which a thread's provider works, either a separate Git worktree or a deliberately shared folder. Separate working copies can belong to the same project and share its project memory scope.

**Thread pane.** A view of one thread within the Threads page, with its own reading position and input. Closing a pane leaves the thread and its running work intact.

**Thread activity.** Provider-reported work alongside a thread's messages, including commands, file changes, visible summaries, tool results and subagent states. Activity is observational history, not a user message, an assignment or permission to act.

**Native skill.** A reusable instruction set exposed by a provider for a thread's working copy. Selecting a skill adds reviewed text and a provider-recognized reference to that draft; it neither submits the draft nor grants authority.

**File mention.** A file of a thread's working copy named in a draft by typing `@` and picking it, like a native skill's `$`: both are mentions, a sigil and a name written into the draft's own text. The mention is the reference — deleting its token removes the file from the send — and it reaches every provider as the same `@path` relative to the working copy. Files outside the working copy, git-administrative entries and paths containing a space are never offered.

**Tools panel.** The shared working surface beside the thread panes. It follows the focused thread unless pinned to a particular thread's working copy.

**Settled.** A reversible workspace grouping for a thread or project whose work the user has put aside. It preserves history and running work; restoring a project preserves the individual threads the user had already settled.

**Terminal mode.** The Threads sidebar showing terminals instead of threads, switched with the Threads | Terminal control under the header. Terminals open in the same pane grid as thread panes. Avoid: "terminal tab", "terminal page".

**Terminal.** In Terminal mode, a shell or a provider CLI that Sotto starts in a project folder or in its own worktree, named by the user when it opens. It belongs to a project, never to a thread, and keeps running while its pane is hidden. Distinct from the Tools panel's terminal, which belongs to a thread's working copy. Its first line, printed by Sotto, names the folder and the command.

**Closed.** Terminal mode's counterpart to Settled: the shelf of terminals ended this session, which can be reopened with the same command until Sotto quits.

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

Answering a question or permission request and creating a project are also part of the thread interface. The native provider adapters preserve Sotto thread identity across these actions.

**Provider adapter.** An implementation of `AgentHost` that speaks one provider's protocol and identifiers. Every adapter must pass the shared adapter contract in `tests/integration/adapterContract.ts`. Avoid: "driver", "backend".

**Codex provider session alias.** The adapter-owned record in `codex-threads.json` that maps the provider session ID Sotto chose at creation to the thread ID the Codex App Server assigned, plus the working directory, title, model and the digests of dispatched messages. The thread registry holds only the Sotto-chosen provider session ID; the Codex thread ID never leaves the adapter (ADR-0005).

**Codex session log.** Codex's own persisted transcript of a provider session (`rollout-*.jsonl` under `$CODEX_HOME/sessions`). Sotto reads only its user-authored entries to tell its own dispatched messages from text typed directly in Codex: a dispatched message's digest suppresses every consecutive log entry with the same digest, and any other authored entry is a takeover. Sotto never copies or logs the log's content.

**Takeover.** The user sends a message to an assigned thread directly through the provider (for example `codex resume` in the Codex CLI). The adapter reports that message as a user message with no command ID, so the coordinator switches the assignment to manual mode and keeps watching. Opening or reading a thread is not a takeover.

## Personal conversations

**Personal chat.** A saved, project-free conversation with Sotto's configured coordinator, distinct from a project-bound thread. A started personal chat stays with its original provider; changing coordinator defaults affects new chats only. Avoid: "project thread", "global project".

**Personal chat ID.** The durable Sotto-owned identity of one personal chat, independent of its provider session and of every project thread. Selecting or resuming it grants no management, delegation or project-creation authority.

## Coordination

**Coordinator.** The default reasoning agent Sotto uses for deep reasoning and managing assigned threads. Its account, model and reasoning effort are independent of the providers and models running those threads. Avoid: "thread provider" when referring to Sotto's reasoning agent.

**Assignment.** Sotto's authority to reply automatically on a thread. Modes are `managed` (Sotto may send follow-ups within its limits) and `manual` (the user replied in the provider directly, so Sotto only watches). Selecting or reading a thread never creates an assignment. Avoid: "subscription", "watch".

**Assignment facts.** What the coordinator records on an assignment so the app can say how it started and why it stopped: `startedAt`, `origin` (`voice`, `typed` or `unknown`), `stopReason` (`none`, `limit`, `repeat` or `error`) and `stoppedAt`. A takeover clears the stop facts; a save failure only stamps `error` when nothing else stopped the assignment first.

**Threads page.** The management-window view that lists threads across Sotto's providers, including retained threads whose provider is disconnected. A thread's messages and pending decisions stay with its original provider. Avoid: "inbox", "dashboard".

**Attention queue.** The ordered list of threads that need the user: a thread is `ready` for a prompt, has a `question`, has a `permission` request, or is `blocked`. Permissions are never answered automatically and are never inferred. Avoid: "inbox", "notifications".

**Draft.** An unsent prompt or answer, including its attachments, owned by a thread or personal chat and optionally a question request. Each conversation retains its own drafts across navigation and restart; accepting one submitted revision does not clear a newer revision.

**Answer draft.** Saved choices and text for a particular provider question in its original conversation, recoverable even if the provider closes or changes that question. Retaining or copying an answer does not recreate the question, confirm delivery, or grant authority to send it.

**Follow-up queue.** The ordered messages the user has prepared for a thread after its current provider turn, editable or removable until dispatch. It is distinct from the attention queue and the outbox of already-dispatched commands.

**Steering.** The user's explicit submission of new input to a provider's current running turn through a supported native mechanism. It does not imply permission to cancel the turn or start a replacement conversation.

**Turn.** One coordinator action from start to finish: a spoken utterance, a typed command, or an automatic follow-up sent by supervision. Every turn is recorded.

**Turn record.** One JSON line in `turns.jsonl` in the user data folder, written by the turn recorder when a turn finishes: source (`utterance`, `command` or `supervision`), the Sotto thread ID and project the turn acted on, the provider session resolved from the thread registry, timings (intent, retrieval, delegation, total; speech-to-intent and speech-to-first-feedback once the voice pipeline supplies an end-of-speech time), retrieved memory IDs, a context-token estimate, the outcome (`completed`, `clarified`, `failed`) and the text and error, which are blanked when Keep local history is off. Draft edits are not turns. Avoid: "trace", "log entry".

**Thread lane.** The order the coordinator runs one thread's own commands in. A command that names a thread and acts only on that thread — a prompt, a steer, an answer, thread options, compaction, settling and restoring, working-copy actions — runs in that thread's lane, so it waits only for earlier work on the same thread. Commands with no thread, and those that move assignment authority, the composer draft or a whole project, keep the single global lane, which is what the published `globalLaneBusy` mark stands for; the threads whose own lanes are running are published beside it as `busyThreadIds`. Every surface that shows one thread reads that thread's mark, so work on one thread never dims or locks another's pane; the provider and configuration surfaces read the global one. Avoid: "queue" for a lane, "busy" on its own for either mark.

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

**Crossing.** The main window's shell since redesign round 3: one room under a thin strip, set in Bricolage Grotesque. It is dark by default and can be light; see Appearance and Theme. The floating widget keeps its own look.

**Appearance.** The main window's mode setting: System, Light or Dark. Dark is the default for new and upgraded installs (ADR-0009). System follows the operating system's scheme live. The `theme` setting is the floating widget's mode, not a Theme. Avoid: "theme" for the mode.

**Theme.** A named palette of colour roles (background, text, accent, sidebar, terminal and so on) in the T3 Code file format: one of the six built-ins (Sotto, Rose, Fern, Tide, Copper, Dusk; T3 Code's palettes under Sotto's own names) or a custom theme the user created, duplicated or imported (ADR-0011). A theme has a light variant, a dark variant or both. The selected palettes also colour the Sotto mark, the voice sphere and the floating widget. The widget still resolves its own mode from the system. Avoid: "accent" for the palette; the accent chooser is gone.

**Light half, dark half.** The two theme selections, `lightTheme` and `darkTheme`: the theme that paints the window when it resolves to Light, and the one for Dark. They are chosen independently and both start on Tide.

**Contrast and Glass.** The two appearance sliders. Contrast (50-200%) strengthens or softens text and borders against the theme's own background. Glass (40-100%) sets how solid dialogs, menus and floating panels are over the blurred room.

**Theme editor.** The floating panel that creates or edits a custom theme and paints it live over the saved look until Save or Cancel. Pick app color (the inspector) chooses a colour role by pointing at the page; a role's label spotlights everywhere it is used.

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
- `src/renderer/src/styles/tokens.css` and `global.css` — every `--tt-*` token derived from the theme roles, and shared styles; `glass.css` paints floating surfaces; `src/renderer/src/state/appearance.ts` applies the mode, theme, contrast and glass to the window root; `src/renderer/src/assets/fonts/` holds the bundled typefaces.
- `scripts/design-capture-matrix.mjs` — the design gate's capture matrix (dark and light rooms, built-in themes, minimum width, scales, motion, focus).
- `src/shared/themes/` — the theme model: T3 palettes, colour parsing, token engine, library and file format, VS Code import; `src/renderer/src/features/settings/themes/` — gallery, editor, inspector and import dialog; `src/main/themes/` — export and the Open VSX client behind IPC.
- `src/shared/agents.ts` — schemas for state, commands and snapshots shared with the renderer.
- `src/main/agents/control.ts` — the coordinator (`AgentControl`): assignments, queue, drafts, outbox.
- `src/main/agents/host.ts` — the `AgentHost` interface and command shapes.
- `src/main/agents/threads.ts` — thread registry and `SottoThreadHost`.
- `src/main/agents/turns.ts` — the turn recorder and turn record schema.
- `src/main/agents/codex.ts` — the Codex App Server provider adapter and its provider session aliases; `codexRequests.ts` normalises Codex permission and question requests and their answers; `codexSessionLog.ts` reads the Codex session log for takeover detection.
- `src/main/agents/providerSwitch.ts` — `ConfiguredProviderHost`, which aggregates independent provider connections and routes each thread to its bound adapter.
- `tests/integration/adapterContract.ts` — the shared behavioural contract every provider adapter must pass; `tests/fixtures/fakeCodexAppServer.mjs` is the scripted fake Codex App Server it runs against.
- `src/renderer/src/agents/ThreadsView.tsx` — the Threads page; `threadFacts.ts` derives rows, groups, states and sentences from agent state.
- `src/renderer/src/terminals/TerminalWorkspace.tsx` — Terminal mode; `terminalFacts.ts` derives its rows and states; `src/main/terminals/service.ts` owns the terminals and their PTYs; `src/shared/terminalCommands/` maps a provider, model, reasoning and permission choice to the CLI command.
- `docs/agent-control.md` — user-facing behaviour of agent control, including the Threads page.
- `src/main/memory/` — the memory store, its migrations, the policy store, the runtime opener and the packaged probe.
- `src/main/agents/authority.ts` — the `Authority` interface and the risky-action classifier the coordinator consults at dispatch.
- `scripts/memeval/` — SottoMemEval harness, backends, case sets and results.
- `docs/adr/` — decisions, including ADR-0002 on Sotto-owned thread identity and ADR-0003 on the memory store, ADR-0004 on authority in policy records, ADR-0005 on the Codex App Server adapter and ADR-0006 on hosted transcription through OpenRouter.

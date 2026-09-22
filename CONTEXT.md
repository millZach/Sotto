# Sotto domain context

Sotto is a desktop dictation app that is becoming a voice development coordinator: the user talks to Sotto, and Sotto manages the coding agents. This file is the glossary for that domain. Use these terms in issues, tests and code; do not drift to the synonyms each entry lists as avoided.

## Threads

**Thread.** A conversation with one coding agent about one project, owned by Sotto. A thread has a Sotto thread ID, a title, a project, a model, a status (idle, running, error), messages and pending requests. A new thread starts with the native agent and model selected in Settings → Agents; a model chosen for that thread overrides its starting choice without changing the setting. Threads are a core Sotto function: memory, goals, assignments and the attention queue refer to threads by Sotto thread ID and never by a provider's own identifier. Avoid: "T3 thread", "conversation", "chat" when referring to a project-bound thread.

**Thread title.** The thread's name in every surface that names it: sidebar, pane header, attention queue, widget and spoken summaries. It is Sotto's own record, renamed at any time from the sidebar row or the pane header and never pushed to the provider. A thread records whether its title was set by hand (`titleSource`): a name the user typed, in the New thread dialog or a rename, is `user`; a name Sotto's writing model wrote is `generated`; the stand-in "New thread" and any name a provider supplied are `default`. Anything that generates a title leaves a `user` one alone.

**Generated thread title.** The name Sotto writes for a thread that still carries a `default` one, once the first reply to its first message lands. The writing model sees that first message and that first reply alone, and is asked nothing while generated titles are off, while no OpenRouter key is stored, or while Keep local history is off. A failure leaves the stand-in name and is logged, never shown. Regenerate title asks again for a `default` or `generated` name; a `user` name is never offered for rewriting.

**Writing model.** The small OpenRouter model, chosen in Settings under Cleanup, that writes Sotto's own short text: thread titles, commit message drafts and pull request drafts. It reaches OpenRouter with the same stored key as transcript cleanup and transcription.

**Commit message draft.** The message the writing model drafts from the staged diff alone when the Changes panel's commit form opens, with an imperative subject under 72 characters and a body only where the change needs one. It is a draft: the user edits, clears or regenerates it, and only the Commit button commits it. With no OpenRouter key or generated commit messages off, the form opens empty.

**Pull request draft.** The title and body the writing model drafts when the pull request form opens on a branch with commits, from the branch's commit subjects and its capped diff against the base alone. It replaces the form's prefill from the last commit, not words the user has typed; the user edits, clears or regenerates it, and only the Create button creates anything. With no OpenRouter key or generated pull request text off, the form opens as it always did.

**Host ID.** The permanent identity of the Sotto host that owns a workspace. Together with a Sotto thread ID, it distinguishes a thread from threads on every other host.

**Sotto thread ID.** An opaque ID, unique within its host, that Sotto assigns the first time it sees or creates a thread, normally a fresh UUID. It outlives any provider session. Agent state, queue items and assignments refer to this ID; a client pairs it with the Host ID when it shows more than one host.

**Provider.** The installed native client that runs the agent for a thread: Codex, Claude Code, Grok Build or Devin. Providers keep their own sign-ins and may be connected together; each thread's chosen model belongs to one provider.

**Client update.** What Sotto knows about one installed client: the version the adapter connected to, the version that client's own install channel publishes, and the one press that installs it. The **channel** is what installed it — npm (including a client whose package npm owns but whose binary lives elsewhere), the client's own updater, or the Devin app — and it decides both where the published version is read and what an update runs. A client whose channel Sotto will not drive shows the command instead of a button. Say "client update", not "provider update": the provider is connected or not, the client is what gets replaced (ADR-0021).

**Verified version.** The client version an adapter was checked against. Sotto connects to that version or newer and notes when the installed client is past it; older is refused. Not a pin: an exact pin is what kept an installed client old while newer ones were published.

**Provider session.** The native client's own identifier for a thread, distinct from the Sotto thread ID. In prose and user-facing text say "provider session", not "session" on its own or "remote ID".

**Project.** A working folder the provider knows about, with an ID, a title and a path. A thread belongs to exactly one project.

**Thread working copy.** The folder in which a thread's provider works: the shared project folder by default, or an explicitly chosen new or existing Git worktree. Threads sharing a folder share its files and checked-out branch; a separate working copy provides isolation without changing the thread's project memory scope (ADR-0014).

**Branch-changed notice.** The dismissible line above a shared-project-folder thread's composer when that checkout is on a different named branch from the thread's last send. Sending continues on the current branch; **Restore branch** is the user's explicit choice to switch back, with confirmation for uncommitted changes, and worktree-backed threads do not show the notice.

**Temporary thread branch.** The short starting branch of a new worktree, created on its first send and eligible for a descriptive name from that first prompt. It stops being replaceable once the user or agent changes its branch, or another thread shares the folder.

**Reclaim (a worktree).** Removing a thread's own worktree folder while keeping its branch and the thread; the next send puts the folder back on that branch. It happens on the user's word (**Remove worktree** in the Working copy panel, or the question Settle asks) or under a cleanup rule the user turned on, never for a folder with uncommitted work without their answer (ADR-0019). Avoid: "delete the worktree", "clean up the thread".

**Thread pane.** A view of one thread within the Threads page, with its own reading position and input. Closing a pane leaves the thread and its running work intact.

**Thread activity.** Provider-reported work alongside a thread's messages, including commands, file changes, visible summaries, tool results and subagent states. Activity is observational history, not a user message, an assignment or permission to act.

**Native skill.** A reusable instruction set exposed by a provider for a thread's working copy. Selecting a skill adds reviewed text and a provider-recognized reference to that draft; it neither submits the draft nor grants authority.

**File mention.** A file of a thread's working copy named in a draft by typing `@` and picking it, like a native skill's `$`: both are mentions, a sigil and a name written into the draft's own text. The mention is the reference — deleting its token removes the file from the send — and it reaches every provider as the same `@path` relative to the working copy. Files outside the working copy, git-administrative entries and paths containing a space are never offered.

**Tools panel.** The shared working surface beside the thread panes. It follows the focused thread unless pinned to a particular thread's working copy.

**Browser task.** One thread's work with a page in Sotto's browser, including its current action, user decisions, checks and evidence. A browser task may be working, paused, completed or failed; its reported result states what was checked and what remains unchecked.

**Browser preview.** The small corner view of a browser task's page. Opening it reveals that same page in the Tools panel; dismissing it does not pause the work.

**Shared browser page.** A browser page the user has made observable to its owning thread. Sharing observation does not approve navigation, clicks or typing, and revoking it ends that access.

**Browser feedback.** A screenshot and optional selected-element or region context added to a thread's draft by the user. It is unsent draft content until the user sends it.


**Settled.** A reversible workspace grouping for a thread or project whose work the user has put aside. It preserves history and running work; restoring a project preserves the individual threads the user had already settled. Creating a new thread in a settled project returns the folder to the active sidebar with only the new thread; older threads stay in Settled.

**Terminal mode.** The Threads sidebar showing terminals instead of threads, switched with the Threads | Terminal control in the sidebar's top row. Terminals open in the same pane grid as thread panes, so turning the control to Terminal from another page leads to the Threads page. A project's folder head in Terminal mode offers Settle project, the same as in the thread list; a settled project leaves the list once its terminals close. Avoid: "terminal tab", "terminal page".

**Terminal.** In Terminal mode, a shell or a provider CLI that Sotto starts in a project folder or in its own worktree, named by the user when it opens. It belongs to a project, never to a thread, and keeps running while its pane is hidden. Distinct from the Tools panel's terminal, which belongs to a thread's working copy. Its first line, printed by Sotto, names the folder and the command.

**Closed.** Terminal mode's counterpart to Settled: the shelf of terminals ended this session, which can be reopened with the same command until Sotto quits.

**Thread binding.** The durable relationship between a Sotto thread, its provider session and its project. Historical bindings survive a provider's retirement and never grant a replacement provider authority over that thread.

**Provider retirement.** An upgrade that stops using an old thread provider while retaining recovery evidence and the user's draft. Old assignments, answers and uncertain actions are not transferred or replayed through a native client.

**Thread interface.** The verbs the coordinator uses for any provider, with no provider identifiers in their signatures:

| Verb | Meaning | In code (`AgentHost`) |
|---|---|---|
| create | open a new thread in a project with a model | `execute({ type: 'create-thread' })` |
| resume | observe an existing thread's detail so its history and later events arrive for it | `observeThreads` (optional for adapters that always deliver detail) then `snapshot` |
| prompt | send a user message to a thread | `execute({ type: 'send' })` |
| cancel | interrupt the agent's current turn | `execute({ type: 'interrupt' })` |
| status | read every project, model and thread the provider knows | `snapshot` |
| events | subscribe to status changes pushed by the provider | `subscribe` |

Answering a question or permission request and creating a project are also part of the thread interface. The native provider adapters preserve Sotto thread identity across these actions.

**Provider adapter.** An implementation of `AgentHost` that speaks one provider's protocol and identifiers. Every adapter must pass the shared adapter contract in `tests/integration/adapterContract.ts`. Avoid: "driver", "backend".

**Codex provider session alias.** The adapter-owned record in `codex-threads.json` that maps the provider session ID Sotto chose at creation to the thread ID the Codex App Server assigned, plus the working directory, title, model and the digests of dispatched messages. The thread registry holds only the Sotto-chosen provider session ID; the Codex thread ID never leaves the adapter (ADR-0005).

**Codex session log.** Codex's own persisted transcript of a provider session (`rollout-*.jsonl` under `$CODEX_HOME/sessions`). Sotto reads only its user-authored entries to tell its own dispatched messages from text typed directly in Codex: a dispatched message's digest suppresses every consecutive log entry with the same digest, and any other authored entry is a takeover. Sotto never copies or logs the log's content.

**Transcript cursor.** How far a thread's provider transcript had been read when Sotto last stopped, stored by the adapter beside the thread's alias: the byte after the last complete line, the identity of the file it was read from, and what the reader had already matched there. Reconnecting seeks to it instead of reading the file again, and it is only trusted beside the messages and bounded activity it accounts for in the same history epoch. `WorkspaceHost` supplies that evidence through the per-thread history source, or through `restoreThreadHistory` on the legacy path (ADR-0015, ADR-0016). Claude has one; a thread whose history is not handed back is read from its first byte. Avoid: "bookmark", "watermark".

**Takeover.** The user sends a message to an assigned thread directly through the provider (for example `codex resume` in the Codex CLI). The adapter reports that message as a user message with no command ID, so the coordinator switches the assignment to manual mode and keeps watching. Opening or reading a thread is not a takeover.

## History and the host

**Event store.** The SQLite database `threads.sqlite` in the user data folder, opened by `node:sqlite` behind `ThreadStore`, and the source of truth for what was said in every thread. Providers are read to append to it and never asked to rebuild it; their transcripts are read on demand for rewind, takeover detection and a capped import (ADR-0016). It is a second database beside the memory store, which keeps memories and policy records and is not touched by history. Avoid: "message cache", "transcript backup".

**Thread event.** One append-only row in the event store's `events` table: a sequence number, the Sotto thread ID, a kind, a time and a JSON payload. The kinds are `message-added`, `message-text-appended` (a streaming message grew by a suffix), `message-replaced` (a whole message changed in a way an append cannot say), `messages-reset` (a confirmed rewind, carrying the new history epoch) and `answer-given` (a permission or question answer, with its attribution). Nothing is edited or deleted to change what happened; a correction is another event. Avoid: "log line", "record" for one of these.

**Sequence number.** The event store's own counter, one per thread event across all threads, and the thing a client resumes from: "everything after N" is the whole catch-up protocol. Distinct from a thread detail's `revision`, which is what one window holds for one thread, and from a message's position in the projection. Avoid: "offset", "version".

**Projection.** A table derived from the event log for reading, currently `messages`: one row per message of a thread, keyed by position, which is what a thread pane draws. A projection is rebuilt from the log when it is missing or when the schema version moves, and is never written to by hand. Avoid: "view", "cache".

**History window.** How much of a thread's history a pane holds: the newest ten turns when it opens, then twenty more each time the user presses **Show earlier messages**. A turn here is a user message and the assistant messages that follow it. The detail says whether anything older exists (`earlierAvailable`), so opening a long thread costs the same as opening a short one.

**Turn fold.** The one line a finished turn puts its work under, between the user's message and the turn's last written reply. It says how the turn ended and how long it took ("Worked for 40s", "Failed after 12s"), with the files it changed beside it. Pressing it opens the messages and activity in between. A turn still running, and a turn whose start is above the history window, keep every row on screen because neither has a finished span to fold. So the rows a pane draws count what it is showing, never how much history it holds.

**Monitoring task.** A live, provider-confirmed watch on background work. A running command or unattended process is not enough evidence. The little creature above the thread composer appears while that watch is active and leaves when it ends or needs your answer. Monitoring is observation, never permission to act, and is not restored from history.

**Held action.** One action of the live turn — a command, a tool call or a subagent — has held the thread for twenty seconds or more. The same creature stands above the composer holding an hourglass, naming the action and how long it has run; the reader is told **Waiting**, which is the plain word for it. Not to be confused with a thread **waiting on you**, which is `ThreadRow.waitingFor` and reads *Needs your approval* or *Needs your answer* in the sidebar: that is the one case a held action excludes, because its request card already says so. A held action claims only elapsed time — unlike a monitoring task it is no evidence that the provider is watching anything, it grants nothing, and it reads the `activities` every adapter writes rather than any one provider’s events, so it needs only that the adapter record when a running action started, which Claude Code, Codex, Grok Build and Devin all do. A confirmed monitoring task outranks it, because the composer reserves room for one creature and the watch is the stronger claim.

**Watched set.** The threads the host keeps in memory and keeps a provider session for: the threads on screen, plus assigned or queued ones. It is what `observeThreads` names. A thread outside it carries its summary alone, so startup and publish cost follow the open panes rather than the whole archive. Avoid: "active threads", "open threads".

**Session reaper.** The host's sweep, every five minutes, that stops a provider session idle for thirty minutes. It never stops a session with a running turn, one with a pending request, one with a confirmed live monitoring task, or one in the watched set, and stopping one costs only a resume because the resume cursor stays on the host.

**Host.** The process that owns the providers, the worktrees and the event store. It is Electron main on this computer (the local host) or `src/host/index.ts` running under plain Node on any machine reached over SSH (a remote host); the desktop can hold several at once (ADR-0023). The word is also the suffix of the interfaces inside it (`AgentHost`, `WorkspaceHost`); in the host-and-client sense it means the whole owning side, whichever machine it runs on. A host Sotto started over SSH outlives the desktop and stops only on Stop host or Forget. Avoid: "server", "backend".

**Host service.** The interface the host offers a client and nothing more: the event stream after a sequence number, the shell, one thread's detail, and commands. `HostService` in `src/main/agents/hostService.ts`, with `LocalHostService` over `AgentControl` as the only implementation today; the window's commands go through it, so a second transport is a new client rather than a rewrite. Distinct from `AgentHost`, which is the interface a provider adapter implements on the other side of the coordinator. Avoid: "API", "server interface".

**Client identity.** Who is speaking to the host service, carried on every command: `{ clientId, user, transport }`. The desktop window is `desktop-window` over `ipc`; Sotto's own supervision is `sotto-supervision`, so a record shows an answer that came from Sotto rather than the user; a paired remote client is its pairing ID over `socket`. It becomes the attribution on an `answer-given` event, and `Authority.mayGrant` is where it is asked whether that client's answer may count as a grant. The user name is recorded locally and never logged or sent. Avoid: "session", "caller".

**Client.** The side that draws threads and sends commands, speaking only the event stream and the thread interface and holding no provider identity of its own. The app's window is one over IPC; the desktop reaching a remote host, and the iPhone, are others, speaking the same two things over a socket (`SocketHostService`, ADR-0023). Avoid: "frontend", "UI" when the split is what is meant.

**Attribution.** Who gave an answer, carried on every `answer-given` event: `{ clientId, user, transport }`, where transport is `ipc` for the desktop window on this machine or `socket` for a paired remote client. It is evidence of who answered and never authority in itself; policy records decide whether an answer counts as a grant (ADR-0004), and the local desktop window always may answer. Avoid: "identity", "actor".

**Pairing.** How a client beyond loopback is admitted: a short-lived single-use code is redeemed once for a token, and signed sessions over that token carry every later request. `PairedClients` in `src/main/agents/pairing.ts` holds the records — a client ID and the token kept only as a hash — and a per-install secret signs the sessions. Over SSH the desktop asks the host for a code and redeems it itself, the tunnel being the user's authenticated session; the iPhone types a code shown on the host, reached over private Tailscale HTTPS (ADR-0023). Being paired is admission and not authority: a `remote-answer` policy record scoped `client:<clientId>` is what lets a client's answers count as grants (ADR-0004). The host's listener binds loopback only, and the README's "Privacy and cost" section names the SSH and Tailscale paths.

**Launch script.** The fixed Node script the desktop runs on a remote host's machine over SSH, for as long as that SSH session lasts: it finds the host or starts one detached, and on request asks it for a pairing code, revokes a client, or stops a host Sotto started. Requests and replies each carry their own marker, because the terminal ssh runs under echoes every request back. `src/main/hosts/launchScript.ts`. Avoid: "supervisor", which is Sotto following an assigned thread (supervision); "daemon".

**Remote command.** A command a paired client may send over the socket. The list in `src/host/remoteCommands.ts` is closed: a new command or field is refused remotely until it is added on purpose. Commands that change what a thread may do unasked (a runtime mode, a provider mode other than the one that asks about everything) or discard uncommitted work need the same `remote-answer` policy record an answer does. Avoid: "remote API".

## Personal conversations

**Personal chat.** A saved, project-free conversation with Sotto's configured coordinator, distinct from a project-bound thread. A started personal chat stays with its original provider; changing coordinator defaults affects new chats only. Avoid: "project thread", "global project".

**Personal chat ID.** The durable Sotto-owned identity of one personal chat, independent of its provider session and of every project thread. Selecting or resuming it grants no management, delegation or project-creation authority.

## Coordination

**Coordinator.** The default reasoning agent Sotto uses for deep reasoning and managing assigned threads. Its account, model and reasoning effort are independent of the providers and models running those threads. Avoid: "thread provider" when referring to Sotto's reasoning agent.

**Assignment.** Sotto's authority to reply automatically on a thread. Modes are `managed` (Sotto may send follow-ups within its limits) and `manual` (the user replied in the provider directly, so Sotto only watches). Selecting or reading a thread never creates an assignment. Avoid: "subscription", "watch".

**Assignment facts.** What the coordinator records on an assignment so the app can say how it started and why it stopped: `startedAt`, `origin` (`voice`, `typed` or `unknown`), `stopReason` (`none`, `limit`, `repeat` or `error`) and `stoppedAt`. A takeover clears the stop facts; a save failure only stamps `error` when nothing else stopped the assignment first.

**Threads page.** The management-window view that lists threads across Sotto's providers, including retained threads whose provider is disconnected. A thread's messages and pending decisions stay with its original provider. Avoid: "inbox", "dashboard".

**Allowance.** What a Devin thread's owned profile lets Devin do without asking: nothing, edits, or everything. Sotto writes it and reads it back, so it is what decides whether a permission request reaches the user. It carries out the permission mode the user chose; it is not an ADR-0004 policy record and is never a grant of authority. A provider's own conversation mode is set alongside the allowance and never stands in for one: a mode named for not asking says what the provider will not ask itself about, not what Sotto will stop asking (ADR-0022). Avoid: "grant", which is ADR-0004's word; "permission level"; "mode" for the allowance.

**Attention queue.** The ordered list of threads that need the user: a thread is `ready` for a prompt, has a `question`, has a `permission` request, or is `blocked`. Permissions are never answered automatically and are never inferred. Avoid: "inbox", "notifications".

**Draft.** An unsent prompt or answer, including its attachments, owned by a thread or personal chat and optionally a question request. Each conversation retains its own drafts across navigation and restart. Sending ends a draft: the press starts a fresh empty revision, and what was sent is a sent message from then on. Accepting one submitted revision never clears a newer revision.

**Sent message.** What the user sent from this window, drawn in the transcript where it will be read from the press onwards, with the state of its delivery beside it: queued, sending, unconfirmed or not sent. It becomes an ordinary message when the provider's own history carries it. A refused one comes back to an empty composer, or is offered back when something newer is written there; an unconfirmed one stays in its message, because Sotto will not send it twice. Avoid: "optimistic message", "ghost message".

**Answer draft.** Saved choices and text for a particular provider question in its original conversation, recoverable even if the provider closes or changes that question. Retaining or copying an answer does not recreate the question, confirm delivery, or grant authority to send it.

**Follow-up queue.** The ordered messages the user has prepared for a thread after its current provider turn, editable or removable until dispatch. It is distinct from the attention queue and the outbox of already-dispatched commands.

**Steering.** The user's explicit submission of new input to a provider's current running turn through a supported native mechanism. It does not imply permission to cancel the turn or start a replacement conversation.

**Option chips.** The three controls in the composer footer that say what a thread is set to: the model, with its provider's mark, the reasoning effort and the permissions. Each is one chip that opens its own picker above the composer, so the typed text and the send disc stay where they were. The model's menu is two columns: a rail of provider marks down the left, one tile each and no names, so a provider costs the same room whatever it is called and its name is the tile's accessible name and tooltip; and on the right that provider's models under a search line, with the reminder that any provider is still a choice on a thread before its first message. Once the thread has sent, the list holds its own provider's models alone and there is no rail. A model is listed under the fullest name the provider gives it, version and all, and the one the provider recommends stays at the top of its list. The effort chip opens the effort card: the level word and one line saying what the level costs, Default when the model reports one, and a pill track with a stop per level. Dragging previews and settles on a stop; release chooses, and the wheel, arrows, Home, End and the digits step. The level chosen is what the control shows from the press itself — the word, the chip, the composer's outline and the arrival — while the save runs behind it, and the card stays live rather than waiting on it. The provider is still authoritative: the level it answers with is what remains, so a change it refuses takes the press back and says so. At the model's highest level the word, the chip and the composer take the effort color, and reaching it plays the arrival once (ADR-0019). Claude prompts can add a visible `ultrathink` instruction for that prompt; this does not change the saved effort or permissions. The effort levels and permission list come from the provider: Claude Code reports its effort levels at initialize, so a level it does not report cannot be offered. A provider whose permission modes are its own rather than Sotto's four lists those instead, each with the one sentence saying what Sotto will still ask about under it. New thread and New terminal show the same three controls laid out in full. Avoid: "pill" or "Thread options" for the row.

**Turn.** One coordinator action from start to finish: a spoken utterance, a typed command, or an automatic follow-up sent by supervision. Every turn is recorded.

**Turn record.** One JSON line in `turns.jsonl` in the user data folder, written by the turn recorder when a turn finishes: source (`utterance`, `command` or `supervision`), the Sotto thread ID and project the turn acted on, the provider session resolved from the thread registry, timings (intent, retrieval, delegation, total; speech-to-intent and speech-to-first-feedback once the voice pipeline supplies an end-of-speech time), retrieved memory IDs, a context-token estimate, the outcome (`completed`, `clarified`, `failed`) and the text and error, which are blanked when Keep local history is off. Draft edits are not turns. Avoid: "trace", "log entry".

**Thread lane.** The order the coordinator runs one thread's own commands in. A command that names a thread and acts only on that thread — a prompt, a steer, an answer, thread options, compaction, settling and restoring, working-copy actions — runs in that thread's lane, so it waits only for earlier work on the same thread. Commands with no thread, and those that move assignment authority, the composer draft or a whole project, keep the single global lane, which is what the published `globalLaneBusy` mark stands for; the threads whose own lanes are running are published beside it as `busyThreadIds`. Every surface that shows one thread reads that thread's mark, so work on one thread never dims or locks another's pane; the provider and configuration surfaces read the global one. Avoid: "queue" for a lane, "busy" on its own for either mark.

**Outbox.** Durable intent for a dispatched command whose acknowledgement may be lost. Sotto reconciles outbox items against the next status rather than resending.

## Speech

**Wake phrase.** "Hey Sotto". Bare "Sotto" is not a wake phrase.

**Voice coordinator (hidden).** Everything that speaks, listens for the wake phrase or hands a thread to Sotto: the wake session, the Agents room, spoken hints, the widget's microphone and speech controls, the voice settings, a personal chat's Talk controls, and Manage, Pause managing, Resume managing and Stop managing. All of it is hidden for the beta behind `voiceCoordinatorEnabled` in settings, which defaults to false; the renderer asks `useVoiceCoordinatorEnabled()` and the floating widget is told through the snapshot's `voiceCoordinator` field. Nothing is deleted, and dictation never depended on it (ADR-0012).

**Utterance.** One transcribed spoken command handled by the coordinator.

**Transcription.** Turning dictated audio into text. Since ADR-0006 there is exactly one route: each segment is encoded as a 16 kHz mono PCM16 WAV and sent from the main process to Microsoft MAI-Transcribe-2 through OpenRouter's transcription endpoint with the user's OpenRouter key. Nothing is transcribed on this computer and there is no fallback route; a failed request is reported with its reason. Avoid: "local model", "preset", "transcription server", "remote ASR".

**Transcription failure.** Why a transcription request came back without text, and what the user is told. Each reason has its own widget title and sentence: no key (API key needed), a rejected key (API key rejected), no connection or a deadline (Connection unavailable), no credit on the key (Out of credit, HTTP 402), rate limited (Too many requests, 429), any other HTTP error, 5xx after its one retry (OpenRouter error), and an unreadable answer (Couldn't transcribe). Every sentence says the recording was not kept, because dictation audio never is. Main appends each failure except a user's cancel to `transcription-diagnostics.jsonl` beside `polish-diagnostics.jsonl`: when the request started, reason, the last attempt's HTTP status, attempts, clip length and time taken, and never words, audio or the key. Avoid: "error log", "crash report".

**OpenRouter key.** The one API key the user supplies, stored encrypted in the operating system credential store under the `formatting` slot and never returned to the renderer. It pays for transcription, the cleanup pass and any OpenRouter-hosted reasoning. In settings code it is still the `llmApiKey` field.

**Personal dictionary.** The user's list of names and terms, one per line (`llmDictionary`). It is sent with every transcription request as an Azure phrase list so MAI spells those words as written, and it is also quoted in the cleanup prompt. Avoid: "vocabulary hints" in user-facing text.

**Cleanup pass.** The optional LLM pass over the finished transcript (punctuation, fillers, self-corrections, lists), run through OpenRouter chat completions at the chosen quality tier and skipped for very short transcripts. Audio never goes through it. Avoid: "polish" in user-facing text (the code still says `polish`).

**Segment.** One slice of a dictation, cut at a pause while streaming transcription is on, transcribed as its own request so the final text is ready almost as soon as the user stops. Avoid: "chunk".

## Memory

**Memory.** One remembered fact about the user, a project or the world, with the metadata the spec requires: type, scope, content, source class (explicit, observed, inferred, imported, agent-confirmed), confidence, evidence count, importance, temporal fields (created, last confirmed, last used, valid from, valid to), provenance, tags, state (active, superseded, disputed, temporary, archived) and authority (preference, policy, permission). Avoid: "fact", "note", "record".

**Memory store.** The SQLite database `memory.sqlite` in the user data folder, the single source of truth for accepted memories. It is opened by Node's built-in `node:sqlite` in the packaged Electron runtime, without another production dependency, and it carries a full-text index for lexical retrieval. Search honours a memory's validity window and includes temporary memories that are current. See ADR-0003.

**Provenance.** Where a memory came from: a Sotto thread and reference, or a dated questionnaire answer or inspector correction. Questionnaire and inspector provenance do not invent a thread; provenance never carries a provider session ID.

**Working preferences.** The user's explicit answers about communication, autonomy, verification, git and review, agent choices, workflow and privacy. They guide coordinator replies without granting permissions or changing history settings.

**Retrieved preferences.** Current explicit memories relevant to the coordinator's question, drawn from the current thread, its project and global scope in that order. Irrelevant memories are omitted; retrieved preferences provide context, never authority.

**Memory inspector.** The Memory page where the user sees remembered content, its provenance and history, and can correct, supersede or delete it. Corrections retain earlier versions; deleting a memory removes its full chain of versions.

**Memory (hidden).** The Memory page and its link, the questionnaire that greets the Agents room, and the preferences a turn would retrieve from the store are all hidden for the beta behind `memoryEnabled` in settings, which defaults to false; the renderer asks `useMemoryEnabled()` and the main process reads the setting once at start and hands neither the agent control nor the personal chats a preferences source. The store still opens and its IPC stays registered, and nothing is deleted (ADR-0013).

**Memory store probe.** The check that proves the shipped build can use the store: the packaged executable is launched in a probe mode that opens the real memory store in a temporary user-data folder, migrates, inserts, answers a full-text query and prints its evidence. The packaged-resource verifier fails the build without it. A direct Node-only probe (`scripts/probe-memory-store.mjs`) exists for the Mac runtime check.

## Authority

**Policy record.** One row in the `policies` table of the memory store that carries authority: an action (`spend`, `publish`, `destroy`, `relax-verification`), a resource (`*` or a specific path, repository or provider), a scope (`global` or a project id), an effect (`allow` or `always-confirm`), a source (`user` or `questionnaire`), a note, and granted, expiry and revocation times. Policy records are the only thing that can authorize a risky action; a memory whose authority field says `permission` is evidence, never a grant. An `always-confirm` record beats any `allow`; expired or revoked records never allow. See ADR-0004. Avoid: "permission memory", "rule".

**Risky action.** A permission approval that the coordinator classifies from the request text as spending, publishing, destroying or relaxing verification. A request can carry several classes. Dispatch of a risky action consults policy before the provider sees the answer: supervision never answers a permission request, and the user's explicit Allow is the confirmation an `always-confirm` boundary requires. Avoid: "dangerous command", "privileged op".

**Risk boundary.** An action the user says Sotto must always confirm, captured by the questionnaire and stored as `always-confirm` policy records with source `questionnaire`, never as inferred memory.

**Approval surface.** The place a provider client sends the requests only a person can answer. Sotto claims it at launch, per thread, in every runtime mode, and a client that does not grant it answers those requests itself: Claude Code denies them and withholds its question tool, so a thread keeps working while nothing reaches the user. Because that looks exactly like a model choosing not to ask, an adapter that finds the surface missing, or that receives a request for the user it cannot read, says so on the provider instead of staying quiet. See ADR-0021. Avoid: "permission channel", "prompt host".

## Memory evaluation

**SottoMemEval.** The product-specific memory benchmark in `scripts/memeval/`: labelled memory cases run against a pluggable backend, scored per category (recall, abstention, temporal adaptation, temporary exception, project leak, authority leak), printed as a table and saved with the backend name and case-set version. Run it with `npm run memeval`.

**Case.** One labelled scenario in a case set: a short history of provider events, a question asked as of a date and a project, and the expected outcome (an answer pattern, an abstention, or a forbidden leak pattern). Cases carry a `draft` or `reviewed` status until the founder has checked them. Avoid: "sample", "example".

**Case set.** A versioned file of cases (`scripts/memeval/cases/v1.json`). Results always name the case-set version they were scored against.

**Backend.** The memory system under test in SottoMemEval: it observes history events and answers questions, and never sees ground-truth labels. The `none` backend remembers nothing and always abstains; it is the required baseline. This is the one place "backend" is the right word; a provider adapter is never a backend.

## Main window

**Crossing.** The main window's shell since redesign round 3: one room under a thin strip, set in Figtree. It is dark by default and can be light; see Appearance and Theme. The floating widget keeps its own look.

**Appearance.** The main window's mode setting: System, Light or Dark. Dark is the default for new and upgraded installs (ADR-0009). System follows the operating system's scheme live. The `theme` setting is the floating widget's mode, not a Theme. Avoid: "theme" for the mode.

**Theme.** A named palette of colour roles (background, text, accent, sidebar, terminal and so on) in the T3 Code file format: one of the six built-ins (Sotto, Rose, Fern, Tide, Copper, Dusk; five of them T3 Code's palettes under Sotto's own names, and Sotto's own look on the sixth) or a custom theme the user created, duplicated or imported (ADR-0011). A theme has a light variant, a dark variant or both. The selected palettes also colour the Sotto mark, the voice sphere and the floating widget. The widget still resolves its own mode from the system. Avoid: "accent" for the palette; the accent chooser is gone.

**Light half, dark half.** The two theme selections, `lightTheme` and `darkTheme`: the theme that paints the window when it resolves to Light, and the one for Dark. They are chosen independently and both start on Sotto.

**Contrast and Glass.** The two appearance sliders. Contrast (50-200%) strengthens or softens text and borders against the theme's own background. Glass (40-100%) sets how solid dialogs, menus and floating panels are over the blurred room.

**Effort color.** The colourway a thread's effort control turns at a model's highest level: one of Ember, Cyberpunk, Rainbow, Aurora, Plasma or Theme accent, chosen on Settings → Appearance and painted on the window root as `data-effort-color` (ADR-0019). It colours the card's fill and tinted word, the effort chip, and the composer's outline and arrival. Ember and Theme accent come from theme roles; the other four are fixed palettes no theme carries, the one place the main window's colour does not come from the theme. Avoid: "effort theme"; a theme is a palette of roles, and this is one choice across all of them.

**Highest level.** The last effort level in Sotto's order, whatever it is called (Max on Claude Code, Ultra on GPT-6 Astra). Sotto lists a model's levels least to most thorough; Codex and Claude Code report them that way, and Grok's own list, which runs highest first, is turned round (ADR-0023). A model that reports one level has no highest level. The composer wears the effort color's outline while a thread sits there, and the arrival is what plays on reaching it from below: a tide of the colourway through the card and the composer, the letters of the level taking the colour in turn while the word lifts and settles as one, both borders tinting and fading. Reduced motion shows the settled state. Avoid: "max" or "gold" for the state; the name belongs to the level, and the colour is the user's.

**Theme editor.** The floating panel that creates or edits a custom theme and paints it live over the saved look until Save or Cancel. Pick app color (the inspector) chooses a colour role by pointing at the page; a role's label spotlights everywhere it is used.

**Strip.** The top bar of the main window on the pages that still wear one, Agents and Memory (both behind their beta gates) and onboarding: the Sotto mark on the left, the switch in the centre, the window controls on the right. It is the window's drag region. Every other page has the sidebar top row instead. The Threads page owns the whole window, with the sidebar's top row and the pane header as its drag regions and the window controls once at the top right. Dictate, History and Help seat the Threads sidebar beside the room, with a thin drag strip above the room carrying the window controls. Settings and Chats give their own left column the sidebar top row and the sidebar foot, and carry the window controls at the top right the way Threads does.

**Sidebar width.** The remembered space the user gives the Threads sidebar, shared with Terminal mode and with the same sidebar beside Dictate, History and Help. Collapsing it leaves a narrow rail for threads and page links; expanding it restores the chosen width, while Settings and Chats keep their own columns.

**Sidebar top row.** The first row of the Threads sidebar, and of the Settings and Chats columns: the Sotto mark with the wordmark "Sotto" beside it, then, in the Threads sidebar only, the Threads | Terminal control, Add project, New thread and Collapse sidebar. It is a drag region. On macOS it is inset and drops the wordmark, to leave the traffic lights their place.

**Sidebar foot.** The bottom of the Threads sidebar, and of the Settings and Chats columns: the switch, the page links as icons (Chats, History, Settings, Help, and Memory while memory is switched on) and the update control. Every page without a strip has one, so the way to any page is the same from any page.

**Switch.** The two-state control that flips the room between Dictate and Threads. It is a tablist; arrow keys move between the two. Dictate is lit on the Dictate room, Threads for the threads, chats and memory pages, and neither on History, Settings and Help. It sits in the sidebar foot beside the page links, and in the strip on the pages that still wear one. Both places offer the same rooms: while the voice coordinator setting is on, Agents joins as a third state in each. The room keeps its place in the shell tree across the layouts, so switching pages never remounts what is inside it. Avoid: "tabs" in prose; "Agents" for the second state.

**Room.** The single content area beside the sidebar, or under the strip where a page still wears one. The switch chooses the Dictate room or the Threads page, and Threads is the page the application opens on; the page links open the others (Chats, History, Settings, Help, and Memory while memory is switched on) in the same area. Those links are icons in the sidebar foot; only a page under a strip lists them in a footer.

**Dictate room.** The Dictate side of the switch: the large seven-bar wave, one sentence for the current state, one button with the shortcut, then the last transcript at reading size with Copy.

**Footer status.** The one-line status text supplied by whichever page is open (for example the model and paste mode in the Dictate room, or whether History still holds older transcripts once it is off). Beside the sidebar it sits in a thin foot under the room; on Settings and Chats it sits in the room's bottom-right corner; under a strip it sits on the right of the footer links. The Threads page has no footer status; a thread says what it is doing in its own row and pane.

**Update control.** The small round button at the end of the sidebar foot, or at the far right of the footer under a strip, the one place the updater shows itself in the window. Idle it offers a check; when a release is found it wears a download glyph, a progress ring while the installer downloads, and a restart glyph once the installer is on disk. Its accessible name says exactly what a press does. A press that downloads or fails gets a toast; a press that installs asks first, because the restart interrupts dictation and agent work. Automatic checks run fifteen seconds after launch and every four minutes, only on the installed Windows app and only while the setting allows, and never install anything on quit. "Check for Updates…" in the tray menu (and the macOS application menu) presses the control from outside the window.

## Where things live

- `src/renderer/src/components/AppShell.tsx` — the Crossing shell and its three layouts (a strip over the room, the sidebar beside the room, a page that owns the window): switch, room, footer links, footer status and the update control slot.
- `src/renderer/src/components/WindowControls.tsx` — the minimize, maximize and close-to-tray buttons, used by the strip, by the drag strip above a room beside the sidebar, and by the top right of a page that owns the window.
- `src/renderer/src/agents/SidebarFrame.tsx` — the sidebar top row and sidebar foot; `PageSidebar.tsx` is the Threads sidebar beside Dictate, History and Help, and `threadIntent.ts` carries a New thread pressed there to the Threads page.
- `src/renderer/src/state/voiceCoordinator.ts` — `useVoiceCoordinatorEnabled()`, the one answer to whether voice is shown at all (ADR-0012).
- `src/renderer/src/state/memoryFeature.ts` — `useMemoryEnabled()`, the one answer to whether memory is shown at all (ADR-0013).
- `src/renderer/src/features/updates/` — the update control, its wording (`updateControlLogic.ts`) and the press-to-toast flow (`useUpdateFlow.ts`); `src/main/updates/updateService.ts` owns the cadence and phases behind it.
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
- `src/renderer/src/agents/ThreadsView.tsx` — the Threads page; `threadFacts.ts` derives rows, groups, states and sentences from agent state; `threadSidebar.css` paints the sidebar, `threadsChrome.css` the page's own window chrome, and `threads.css` the page grid, workspace, pane header, transcript and composer.
- `src/renderer/src/terminals/TerminalWorkspace.tsx` — Terminal mode; `terminalFacts.ts` derives its rows and states; `src/main/terminals/service.ts` owns the terminals and their PTYs; `src/shared/terminalCommands/` maps a provider, model, reasoning and permission choice to the CLI command.
- `docs/agent-control.md` — user-facing behaviour of agent control, including the Threads page.
- `src/main/memory/` — the memory store, its migrations, the policy store, the runtime opener and the packaged probe.
- `src/main/agents/authority.ts` — the `Authority` interface and the risky-action classifier the coordinator consults at dispatch.
- `scripts/memeval/` — SottoMemEval harness, backends, case sets and results.
- `docs/adr/` — decisions, including ADR-0002 on Sotto-owned thread identity and ADR-0003 on the memory store, ADR-0004 on authority in policy records, ADR-0005 on the Codex App Server adapter, ADR-0006 on hosted transcription through OpenRouter, ADR-0012 and ADR-0013 on the voice coordinator and memory being hidden for the beta, and ADR-0016 on Sotto-owned history in an event store with a host and client split.

## Subagents

**Subagent.** A child agent reported by a thread's provider. It belongs to its parent thread and has an observational identity; it is not a Sotto thread or a target for commands.

**Subagent roster.** The thread's retained list of reported subagents, shown in Tools under Agents. It includes finished agents and follows Tools' selected or pinned thread.

**Subagent assignment.** One task given to a subagent, with the result it reported. A reused subagent keeps its identity and earlier tasks; unlike a coordinator assignment, a subagent assignment grants Sotto no authority.

**Last seen working.** A subagent whose last known work has not been confirmed after a disconnect or restart. It is evidence of earlier activity, not a claim that the agent is running now.

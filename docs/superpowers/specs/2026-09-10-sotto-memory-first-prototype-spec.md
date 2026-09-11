# Sotto: Memory-First Voice Development Coordinator

Research and working prototype specification. Version 0.2, September 2026. Version 0.1 was reviewed against primary sources and the current codebase on 2026-09-10 (see `docs/research/2026-09-10-memory-first-spec-review.md`); this version folds in the accepted changes.

North star: Talk to one agent that knows how you work. Sotto manages the other agents for you.

## Changes from 0.1

- The product is Sotto and the wake phrase is "Hey Sotto". Earlier drafts spelled it "Soto".
- Threads are a core Sotto function, not a T3 Code feature. Sotto defines its own thread interface and IDs first, uses the existing T3 Code host as the first implementation while explicit memory is proven, then replaces it with native Codex, Claude and Grok adapters. Memory binds only to Sotto thread IDs so T3 can be removed without touching memory (sections 10, 14, 18).
- v0 is cut to a memory experiment. Inferred preferences, autonomous consolidation, graph memory, Git reflection and broad adapters wait for measured failures (sections 2, 14).
- Authority is a separate enforced model. Repetition never grants permission, and imported or agent-confirmed statements are evidence, not grants (sections 3, 6.1).
- SQLite is the single source of truth for memory. Markdown files are a generated projection. Original transcript bytes are kept separately from normalized trajectories (section 5.3).
- Memory stays on the user's machine. The one consent moment is choosing which model reads imported history during extraction, since a cloud extractor sends one provider's transcripts to another provider (section 8.2).
- Voice budgets are stated as measurable targets derived from the July and August measurements (section 9).
- Voice model testing is a named track: fixtures, metrics and a decision rule for the text-to-speech default (section 9.2).
- Transcription model testing is a named track: MAI-Transcribe-2 benchmarked against the Parakeet plan with a screen-first sequence and a decision rule (section 9.3).
- The benchmark starts with four controlled baselines instead of eight (section 12.4).
- Import cost, model downloads and native-module packaging are budgeted in M0 rather than at release (sections 14, 18).

# 1. Executive Summary

Sotto is a voice-first, provider-independent development coordinator. The user interacts primarily with Sotto rather than managing Claude, Codex, Grok, Cursor, or other coding-agent threads directly. Sotto maintains durable knowledge of the user's working style, workflows, project history, and prior outcomes, then uses that knowledge to create or resume provider sessions and coordinate work.

The first prototype is deliberately narrow. It must prove the central hypothesis: cross-agent memory can make a developer feel that the coordinator genuinely knows how they work, while remaining fast, accurate, inspectable, and resistant to memory pollution.

- Voice is accurate and responsive enough for daily development.

- Basic local thread environments exist for current agents, initially Claude, Codex, and Grok, subject to adapter feasibility.

- Memory is bootstrapped from a conversational questionnaire and optional local agent-history import.

- Sotto recalls relevant preferences, workflows, project facts, and episodes without flooding context.

- Sotto adapts when preferences change and avoids converting one-off instructions into permanent rules.

- The target experience is repeatable: “this thing actually knows how I work.”

# 2. Product Thesis and v0 Scope

A developer's accumulated working relationship should belong to the developer, not to a model, subscription, or coding-agent harness. Sotto owns the persistent relationship, goals, memory, and orchestration. Provider agents own their execution sessions.

## 2.1 Required in v0

- Voice capture, strong speech-to-text, concise text-to-speech, visible transcript, interruption/cancel.

- Coordinator that interprets intent, retrieves memory, chooses/resumes a thread, delegates, and summarizes.

- Sotto-owned threads: a stable thread interface (create, resume, prompt, cancel, status, events) with Sotto thread IDs mapped to provider session IDs and projects. The T3 Code host is the first implementation; native Codex, Claude and Grok adapters replace it within v0.

- Explicit memory first: questionnaire-derived preferences and policies, provenance, retrieval, temporal supersession, and an inspector with edit and delete. One opt-in history importer (Claude) with a reviewed "what Sotto learned" step. Evaluation harness from the start.

- Basic project/repository scope and active project state.

## 2.2 Explicitly deferred

- iOS application.

- Production remote-box orchestration.

- Dependence on T3 Code beyond the scaffolding period. T3 is removed once the native adapters cover create, resume, prompt, cancel, status, questions and permissions.

- Automatically inferred preferences, autonomous consolidation, Git-based reflection, and temporal graph memory until the explicit-memory alpha shows the failures they would fix.

- Codex and Grok history importers until the Claude importer has proven the review flow.

- Broad provider ecosystem.

- Complex autonomous scheduling/background subscriptions.

- Any inferred permission for destructive, sensitive, or production actions.

# 3. Non-Negotiable Principles

- Memory is a system, not a giant prompt or one Markdown file.

- Raw sessions/trajectories are ground truth; learned memory is compressed and revisable.

- Explicit user statements outrank inferred preferences.

- Memory and authority are separate. Permissions are never inferred. Authority lives in policy records with action, resource, scope, expiry and revocation, and is checked at dispatch. Repetition, imported instructions and agent-confirmed claims are evidence, never grants.

- Retrieve dynamically and minimally; most stored memory should not enter most prompts.

- Sotto owns goals and continuity; provider agents own execution sessions.

- Voice latency is a product requirement, not a later optimization.

- Memory must be inspectable, attributable to evidence, editable, and reversible.

- One source of truth. SQLite owns accepted memory; every other representation is generated from it.

- Memory and history stay on the user's machine. Any model call that carries historical data is explicit in code, configuration and the interface.

- Optimize v0 for learning whether the core experience is valuable, not infrastructure completeness.

# 4. Proposed System Architecture

- Desktop shell: voice capture, transcript, Sotto response, project/thread navigation, memory inspection.

- Coordinator service: intent classification, context assembly, workflow/skill routing, provider selection, delegation, result summarization.

- Thread service: Sotto's own thread model and persistence, permission and question routing, recovery after lost acknowledgements or process death, takeover detection when the user resumes a session in the provider's own client, and cancellation.

- Provider adapter layer behind the thread service: discover/auth status, create, resume, prompt, stream events, cancel, transcript/status. Verified routes as of September 2026: Codex through the Codex App Server protocol, Claude through Claude Code's stream-json headless mode, Grok through Grok Build's native ACP stdio agent. The repo already speaks all three for isolated reasoning sessions (`src/main/agents/subscription*.ts`); execution adapters extend those clients with actions allowed. ACP is one adapter option, not the domain model.

- Memory service: ingestion, normalization, extraction, temporal state, retrieval, consolidation, provenance, evaluation hooks.

- Local persistence: structured database/index, agent-readable memory repository, immutable/raw trajectory archive.

- Background workers: history import, reflection, consolidation/defragmentation, indexing, benchmark runs.

# 5. Memory Architecture

Use three representations: raw experience, structured learned memory, and bounded agent-readable context. RAG is a retrieval mechanism, not the memory system itself.

## 5.1 Memory classes

- Explicit preferences: durable instructions directly stated by the user.

- Inferred preferences: repeated behavioral tendencies, stored with lower confidence than explicit statements.

- Workflows: reusable multi-step procedures such as the user's standard benchmark.

- Episodic memories: prior events, outcomes, failures, and notable decisions.

- Project knowledge: facts and decisions scoped to a project/repository.

- Working memory: current goal, decisions, blockers, and next actions; aggressively condensed.

- Skill metadata: compact descriptions of available skills; full instructions loaded only on demand.

## 5.2 Required metadata per learned memory

- Stable ID, type, scope, canonical content.

- Source class: explicit, observed, inferred, imported, or agent-confirmed.

- Confidence, evidence count, importance/utility.

- Created, last-confirmed, last-used, valid-from, valid-to/superseded timestamps.

- Provenance links to source sessions/trajectory records.

- Entities/tags, lexical representation, embedding/search representation.

- State: active, superseded, disputed, temporary, archived.

- Sensitivity/authority class so a preference cannot become a permission.

## 5.3 Storage design to prototype

- Raw archive: original session bytes with content hash, retained locally and never rewritten. Normalized trajectories (Letta Trajectory format or Sotto's own) are a versioned derivation, since normalization drops bookkeeping and truncates tool output.

- Structured store: SQLite is the source of truth for accepted memory, metadata, temporal fields, provenance, Sotto thread and project links, policy records, and benchmark instrumentation. Index and file updates run through a transactional outbox so a crash cannot leave them out of step.

- Retrieval indexes: full-text search plus embeddings/vector index; entity/date/scope filters narrow candidates before semantic ranking.

- Agent-readable repository: focused Markdown files with frontmatter and progressive disclosure, generated from SQLite with revision IDs and atomic replacement. Not bidirectionally edited; human edits go through the inspector's validated change path. Git versioning of this folder is optional and deferred.

- Experimental temporal graph: evaluate Graphiti/Zep-style temporal facts for changing relationships, but do not require graph complexity unless benchmark results justify it.

Starting memory-file categories: system/ for tiny always-relevant context; profile/ for durable working style; workflows/ for reusable procedures; projects/<project>/ for scoped knowledge and lessons; episodes/ for selected high-value summaries; and an index describing available memory. File bodies load only when needed.

# 6. Memory Formation and Consolidation

Memory formation should normally be asynchronous so it does not block the voice path.

- Capture a completed turn/session event.

- Normalize source into a canonical trajectory.

- Extract and classify candidate memories.

- Retrieve related existing memories.

- Classify relationship: new, supporting evidence, contradiction, refinement, temporary exception, or duplicate.

- Apply policy: explicit statements may update durable preference memory; inferred preferences need stronger evidence; permissions are never inferred.

- Write structured memory with provenance and temporal validity.

- Update lexical/vector indexes and relevant agent-readable files.

- Periodically consolidate duplicates, split oversized files, archive stale material, and preserve revision history.

## 6.1 Critical inference rules

- One-off instruction is not automatically a preference.

- Repeated behavior is evidence, not proof.

- A new explicit statement supersedes conflicting inference.

- Temporary exceptions stay scoped. A repeated exception may become a candidate preference for the user to confirm; it never widens authority.

- Contradictions update temporal validity rather than silently deleting history.

- High-impact permissions require explicit configuration or confirmation.

# 7. Retrieval and Context Assembly

- Resolve user, project/repository, active goal, entities, and temporal references.

- Classify intent and likely workflow/skill.

- Search narrow scopes first: session/thread, then workflow/project, then global.

- Apply structured filters for dates, entities, projects, and memory type.

- Run hybrid lexical plus semantic retrieval.

- Re-rank with task relevance, explicit-vs-inferred status, confidence, importance, recency, and evidence.

- Apply a minimum relevance threshold. Retrieving nothing is preferable to injecting misleading context.

- Assemble bounded context and log exactly which memories influenced the response/action.

Do not lock a final token budget before evaluation. Begin with a small Sotto core prompt, compact explicit profile, active project state, one relevant workflow/skill, a handful of high-confidence memories, and recent conversation. Benchmark whether additional retrieved tokens improve outcomes.

# 8. Onboarding and Bootstrap

## 8.1 Conversational questionnaire

- Communication: concise vs detailed; spoken verbosity; progress updates; interruption preference.

- Autonomy: plan-first threshold, architecture-change approval, dependency policy, worktree/branch habits.

- Verification: tests, lint, type checks, screenshots/browser verification, definition of done.

- Git/review: commit/PR expectations and independent review habits.

- Agent preferences by task, including “no preference.”

- Workflow habits: benchmarks, bug triage, research-before-code, implementation, independent review.

- Risk boundaries: actions Sotto must always confirm. Store these as policy, not inferred memory.

- Privacy: which local histories may be analyzed, retention, export, and deletion expectations.

## 8.2 Local history bootstrap

- Detect supported local histories only after user approval. Everything read stays on this machine.

- Extraction is the one consent moment. Before any history is read by a model, show which model will read it, which sources and date range, the estimated cost, and a plain note that using a cloud model sends one provider's transcripts to another provider (tool output and file contents included). A local extraction model needs no consent step. The choice also governs later retrieval and reasoning calls that carry historical text.

- Show discovered sources and require opt-in per source.

- Normalize provider-specific histories into a common trajectory representation.

- Analyze sessions in background/parallel where safe.

- Extract recurring preferences, workflows, project facts, notable episodes, successful strategies, and recurring failure modes.

- Assign confidence based on repetition, consistency, and recency.

- Preserve links to original source sessions.

- Present a concise “What Sotto learned” review with high-confidence items and uncertain/disputed inferences.

- User corrections become explicit memories and outrank prior inference.

- Deleting a source or a memory purges the raw archive copy, normalized trajectory, SQLite rows, indexes, generated files and logs, and blocks re-import of the same content hash.

# 9. Voice Experience Requirements

- Low-latency STT with visible transcript. Streaming partials are a research item, not a v0 requirement; the current dictation path is segmented.

- Targets for a warm short utterance, measured from acoustic end of speech: useful transcript or status feedback p50 at or under 1.2 s and p95 at or under 2 s; memory retrieval p95 at or under 100 ms; hotkey or button stop at or under 150 ms. Intent resolution, delegation and first spoken audio are timed separately, cold and loaded. Baselines: Moonshine inference 185/465/1781 ms for 2/4.4/16.6 s clips (2026-07-28), 650 ms endpoint silence in `voiceCapture.ts`, 450 ms post-speech guard in `voiceSession.ts`.

- Accurate final transcript for coding vocabulary, model names, repository names, commands, and self-corrections.

- Fast acknowledgement path while deeper planning/delegation continues.

- Interrupt/cancel during Sotto speech and delegated work.

- Concise TTS by default; full text remains visible.

- Instrument end-of-speech to first useful feedback, resolved intent, and delegation.

- Do not put memory reflection/consolidation in the synchronous voice path.

- Experiment with speculative retrieval from partial transcripts, but only commit after final intent resolution.

## 9.1 Voice research questions

- Which STT model gives the best accuracy/latency on coding vocabulary and proper nouns?

- Should Sotto maintain a user-specific vocabulary for repository, dependency, model, and teammate names?

- What TTS engine provides natural low-latency speech and clean interruption?

- What acknowledgement can be generated locally/cheaply before deeper reasoning completes?

- How much partial-transcript retrieval can be done speculatively without causing wrong actions?

- What p50/p95 latency thresholds correlate with the interaction feeling immediate?

## 9.2 Voice model testing

Sotto speaks more than it dictates once threads are running, so the text-to-speech side gets the same treatment as transcription: a fixture set, a harness, and a decision rule, before any voice is made the default.

- Incumbents already in the app: Supertonic on-device (ten English voices, 263 MB download, `src/main/agents/speechModels.ts`), the operating system voice, and Grok speech through the xAI API (reply text leaves the machine, $15 per million characters). Challengers come from the research brief in `docs/research/`, split into on-device and hosted.

- Fixtures: 24 replies Sotto actually says, frozen as text. Six acknowledgements of one to five words, six status lines, four permission asks that include a command, four two-sentence summaries, two proper-noun runs (repository, model and dependency names such as sherpa-onnx, Parakeet, OpenRouter, electron-builder), two with times and numbers.

- Metrics per voice: time to first audio p50 and p95, cold and warm, on the Windows PC and the Apple silicon Mac; synthesis time against audio length; stop latency from an interrupt to silence; pronunciation errors on the proper-noun and number fixtures, counted by hand; blind pairwise preference against the current Supertonic default, at least three listeners; CPU or GPU load while local transcription is also running, since both share the machine; download size, licence, and cost per 1,000 replies for hosted voices.

- Decision rule for the on-device default: first audio at or under 300 ms warm on both machines, interrupt to silence at or under 100 ms, no more pronunciation errors than Supertonic on the technical fixtures, and a pairwise win or tie. A hosted voice can only be an opt-in tier, like Grok speech today, and must be judged with network time included.

- Harness lives beside the transcription bench (`scripts/asr-bench/` pattern) so both run from the same fixtures folder and report in the same shape.

## 9.3 Transcription model testing

The transcription plan is Parakeet TDT 0.6B v2 on-device as the standard model, Parakeet v3 for multilingual, and an optional self-hosted server on a LAN GPU box. Before that is locked, benchmark Microsoft MAI-Transcribe-2 against it. Research brief and full protocol: `docs/research/2026-09-10-mai-transcribe-2.md`.

- Comparison set: Parakeet v2 on-device, Parakeet v2 and v3 on the LAN server, MAI-Transcribe-2 through Azure directly and through OpenRouter, and the existing Moonshine baseline. MAI is cloud-only with no public weights, so it can never be the standard model; the question is whether it earns an opt-in tier.

- Fixtures: the seven existing clips in `scripts/asr-bench/fixtures/` plus about 30 human recordings, most of them 2 to 4 s push-to-talk utterances, covering coding vocabulary, model and repository names, self-corrections, numbers, ordinary speech, a noisy microphone and silence controls. Verbatim references are frozen before any run.

- Metrics: normalized WER per fixture and macro mean using the existing `wer.mjs` scorer, proper-noun WER on annotated name spans, p50 and p95 time to full result for 2 s, 3 s and 16 s clips with cold starts separate, failures and retries, stop-to-paste in the real app, and cost per 1,000 dictations.

- Sequence: a cheap screen first, the tiny, short and proper-noun fixtures five times each on both MAI routes, then the full matrix only if short-clip latency is competitive. Thirty runs over the fixture set costs about seven cents per configuration at launch pricing.

- Decision rule: MAI earns an opt-in tier only if it cuts proper-noun WER by at least 25 percent relative and 3 points absolute against the best Parakeet result, with no mean-WER regression, no worse p50 or p95 stop-to-paste on 3 s clips than the route it would replace, at least 99 percent successful requests, and no hallucinated speech on silence. Parakeet stays the standard regardless.

# 10. Thread and Provider Prototype

Threads are a core Sotto function and belong to Sotto, not to any provider or host. The primary UX surfaces goals, status, decisions, and results; full thread detail is one step away. Threads get their own page.

- Thread interface first: create, resume, prompt, cancel, status, events, with a Sotto thread ID that outlives any provider session. Define this before writing any adapter, and bind memory, goals and the queue to Sotto thread IDs only.

- Scaffolding sequence: the existing T3 Code host (`AgentHost`) is the first implementation of the thread interface so memory work can start immediately. Native adapters then replace it one provider at a time, Codex App Server first because it exercises threads, resume, approvals and event streaming, then Claude stream-json, then Grok ACP. T3 is deleted once the third adapter lands; the app never carries two thread models.

- Rebuilt in Sotto as part of the native adapters: thread persistence, permission and question routing into Sotto's queue, recovery after lost acknowledgements and restarts, takeover detection (user resumed the session in the provider's own CLI), and per-protocol cancel and interrupt.

- Initial providers: Codex, Claude, Grok. Local history formats and headless modes were verified on 2026-09-10 (spec review, section B). Pin CLI and adapter versions; resume restores conversation state, not killed processes.

- Use each provider's native protocol where the repo already speaks it. ACP is native only for Grok among the three; Claude and Codex need community adapters that add a layer without adding capability.

- Persist Sotto thread → provider → provider-session ID → project/repository mapping.

- Allow the user to open the underlying transcript when Sotto's summary is insufficient.

- Sotto should answer: what is running, what finished, what needs me, and what happened last time.

# 11. Memory Research Program

Do not choose a memory architecture by vendor benchmark alone. Compare approaches on the same Sotto workload.

- Letta-style context repositories: test file navigation, progressive disclosure, background reflection, Git versioning, and defragmentation.

- Mem0-style extracted memory: test hierarchical extraction and multi-signal retrieval for accuracy, token use, latency, and write cost.

- Graphiti/Zep temporal graph: test whether explicit temporal facts materially improve changing preferences, contradictions, entity relationships, and point-in-time recall.

- Hybrid custom system: SQLite + FTS + vectors + temporal metadata + agent-readable files.

- Trajectory normalization: determine whether Claude, Codex, Grok, and later providers can be normalized into a token-efficient common format.

- Memory extractor research: compare models/prompts for separating durable preference, temporary instruction, workflow, episode, project fact, and non-memory.

- Retrieval-policy research: scope order, thresholds, reranking, context budget, abstention behavior, and harmful-memory suppression.

- Consolidation research: when to merge, split, supersede, archive, or revalidate memories.

- Privacy/locality research: determine exactly what remains local and what content leaves the device during model calls.

# 12. SottoMemEval: Product-Specific Memory Benchmark

General memory benchmarks are useful but insufficient. Sotto needs a benchmark representing months of developer work and natural, underspecified requests.

## 12.1 Dataset design

- Synthetic developer histories spanning roughly 6–12 months plus an opt-in private evaluation corpus from real daily use.

- Multiple projects, agents, changing preferences, repeated workflows, mistakes, one-off exceptions, contradictory instructions, and stale facts.

- Normalized trajectories from several coding-agent harnesses.

- Ground-truth labels for explicit preferences, inferred patterns, temporal validity, workflows, project facts, episodes, and things that should NOT be remembered.

## 12.2 Task categories

- Direct recall: “What did we decide about X?”

- Implicit reference: “Run that benchmark again.”

- Workflow recall: “Use my normal feature workflow.”

- Cross-agent continuity: learn in Claude history and act correctly in Codex.

- Temporal update: “I do not want worktrees anymore.”

- Temporary exception: “Skip screenshots just this once.”

- Contradiction resolution and supersession.

- Project scoping and leakage prevention.

- Premise awareness when the user misremembers history.

- Correct non-recall/abstention when evidence is insufficient.

- Agent choice based on prior outcomes/preferences.

- Recurring failure/gotcha recall.

- Long-horizon retrieval after large volumes of irrelevant sessions.

## 12.3 Core metrics

- Recall accuracy.

- Precision and harmful-memory activation rate.

- Correct abstention/non-recall.

- Temporal adaptation after preference changes.

- Temporary-exception handling.

- Cross-agent transfer quality.

- Workflow/task success, not just QA recall.

- Context tokens injected.

- Retrieval latency p50/p95.

- Memory write/consolidation cost.

- Provenance quality.

- Recovery after explicit user correction.

## 12.4 Required baselines

Start with four controlled comparisons. Hold the reader model, context budget and question set fixed across all of them, and score extraction, retrieval and action separately.

- No memory / recent conversation only.

- Bounded summary of history.

- Simple vector RAG over raw history.

- Structured explicit memory: SQLite + FTS + vectors with temporal fields (the Sotto candidate).

Add one challenger at a time (Letta-style progressive files, Mem0-style extraction, Graphiti-style temporal graph) only when it targets a failure the four above have shown. Reserve held-out cases, adjudicate ambiguous labels by hand, record labeling hours, and require zero observed authority or project-leakage failures.

Do not select the winner on average recall alone. Establish minimum gates for harmful activation, correct abstention, temporal updates, latency, and context size. A slightly lower-recall system may be superior if it is substantially safer, faster, and less distracting.

# 13. Daily-Use Validation

The prototype should become the primary front door for a focused period of real development work. Capture failures, corrections, latency, retrieved memories, and whether Sotto reduces or increases management overhead.

- Intentionally use vague references such as “do that benchmark again,” “use my normal workflow,” and “what happened last time?”

- Periodically change a preference and verify Sotto adapts.

- Issue one-off exceptions and verify they do not become permanent.

- Compare direct provider use versus Sotto-mediated use on time-to-result and user intervention.

- Log every memory used for an action so failures can be diagnosed.

- After sessions, record whether Sotto knew the right thing, retrieved too much, retrieved something harmful, or missed useful memory.

# 14. Prototype Milestones

## M0 — Harness, instrumentation, thread interface

- Sotto thread interface and IDs defined; the T3 Code host is wrapped as its first implementation with no behaviour change.

- Every coordinator turn records timings, retrieved memory IDs, context-token estimate, Sotto thread ID, provider session ID and outcome.

- SottoMemEval skeleton runs end to end with 20 to 30 hand-authored cases covering scope, correction, temporary exceptions and authority.

- Packaging probe: SQLite with FTS and vectors works in a packaged Electron build on Windows x64 and macOS arm64 under the "dependencies stay zod only" rule. Model download sizes, checksums and disk limits are listed.

## M1 — Explicit memory and inspector

- Questionnaire writes explicit preferences and policy records. Policies are separate from memory.

- SQLite, FTS, provenance and temporal supersession in place. Retrieval into the coordinator context with logging.

- Memory inspector shows what Sotto knows, why, and lets the user edit or delete. A saved preference changes behaviour after restart without changing any permission.

- Voice budget instrumentation reports against the section 9 targets.

- Voice model bench (section 9.2) run on the incumbents and the shortlisted challengers; the on-device default is chosen by the decision rule, not by ear alone.

- Transcription bench (section 9.3): the coding-vocabulary fixture set is recorded, the MAI-Transcribe-2 screen is run against Parakeet, and the opt-in tier decision is recorded in docs/perf/.

## M2 — Native threads

- Codex App Server adapter end to end: create, resume, prompt, cancel, status, events, questions and permissions routed into Sotto's queue, recovery and takeover detection.

- Threads page in the app shows what is running, what finished, what needs the user, and what happened last time, for every provider.

- Claude stream-json adapter, then Grok ACP adapter, behind the same interface. T3 Code host removed once all three pass the same integration suite.

## M3 — History import

- Opt-in Claude importer: raw bytes archived by hash, normalized trajectories, candidate preferences, workflows and episodes with provenance, presented for review before anything is accepted.

- Extraction model choice with the consent note from section 8.2. Cost per session estimated before the run, cached by content hash, capped and pausable.

- Codex and Grok importers follow only if the review flow holds up.

## M4 — Retrieval and daily-use alpha

- Hybrid lexical and semantic retrieval with scope order, thresholds and abstention.

- Sotto handles implicit references and recurring workflows during real work. Harmful-memory activation and latency measured continuously.

## M5 — Memory bake-off

- Run the four baselines from section 12.4, then challengers as justified.

- Choose the v1 memory architecture on benchmark plus daily-use evidence.

# 15. Prototype Acceptance Criteria

- A user can complete normal voice-driven coding interactions without routinely dropping into provider UIs.

- Sotto can create/resume real local coding-agent sessions and summarize their state.

- Questionnaire-derived explicit preferences reliably affect behavior.

- Imported history produces useful memories with traceable provenance.

- Sotto correctly handles at least the benchmark categories for implicit recall, preference changes, temporary exceptions, project scoping, and abstention.

- Memory retrieval does not create obvious voice dead air in normal use.

- The memory inspector makes incorrect learning easy to identify and correct.

- No permission or risky-action authority is inferred from historical behavior.

- A documented benchmark comparison supports the selected memory architecture.

- The founder can use Sotto for meaningful daily work long enough to judge whether the “knows me” effect is real.

# 16. Open Research Questions

- What is the best canonical trajectory format for all target providers, and should Sotto adopt/extend Letta Trajectory or define its own schema?

- Should the agent-readable memory repository be source-of-truth, a generated projection of structured memory, or bidirectionally editable?

- How should explicit memory, inferred memory, workflow learning, and project facts use different confidence/update policies?

- Does a temporal graph improve enough cases to justify complexity over temporal columns/relations in SQLite?

- Which embedding model and reranker work best on developer-specific memory?

- How should Sotto represent negative memory: things the user explicitly does not want or approaches that failed?

- How should memory confidence decay or be revalidated over months?

- When should Sotto proactively mention a remembered preference versus silently applying it?

- How should multiple conflicting workflows be selected by project/task context?

- How much raw historical material should remain searchable after it has been summarized?

- Can history import stay entirely local while still using a sufficiently capable extraction model?

- What privacy/export/delete UX is required for users to trust a system holding their professional history?

- What exact voice latency targets produce a feeling of immediacy on the target hardware?

- Which current agents truly support ACP versus requiring provider-specific adapters?

# 17. Implementation Guidance for Implementation Agents

- The codebase audit was done on 2026-09-10 (spec review, section A). Do not rewrite working dictation functionality without evidence.

- Create stable interfaces before selecting memory vendors: TrajectoryStore, MemoryStore, MemoryRetriever, MemoryWriter, ProviderAdapter, ProjectStateStore, and SpeechService.

- Add instrumentation early. Every coordinator turn should record timings, retrieved memory IDs, context-token estimates, provider/session IDs, and outcome.

- Implement the simplest no-memory baseline first, then explicit memory, then history import, then advanced retrieval. Preserve the ability to run A/B comparisons.

- Keep all memory data local by default during prototype work. Make any external model call that includes historical data explicit in code/configuration.

- Write tests for memory policy before optimizing retrieval: one-off exception, explicit supersession, conflicting evidence, project leakage, permission non-inference, and abstention.

- Do not hard-wire Sotto to one provider protocol or host. The thread interface is the domain model; T3 Code, ACP and the native protocols are implementations of it.

- Treat Markdown memory files as progressive agent-readable context, not an excuse to inject the entire repository into prompts.

- Do not begin remote/iOS work until daily-use alpha demonstrates the core memory experience is worth expanding.

# 18. Recommended First Engineering Sprint

- Audit current Sotto codebase and preserve the working dictation path.

- Define the Sotto thread interface and IDs; wrap the existing T3 Code host as the first implementation.

- Define normalized trajectory schema and memory metadata schema.

- Create SQLite schema plus full-text search and provenance tables.

- Create minimal memory repository and index format.

- Build questionnaire v0 and memory inspector v0.

- Build SottoMemEval test harness with 20–30 high-value hand-authored cases before adding sophisticated memory.

- Run the MAI-Transcribe-2 screen from section 9.3 and record the result in docs/perf/.

- Stand up the voice model bench with the 24 spoken-reply fixtures and run it on Supertonic, the system voice and Grok speech to set the baseline.

- Implement explicit-memory retrieval and context logging.

- Build the Codex App Server adapter end to end, then Claude, then Grok, and remove T3.

- Only then begin history import and competing memory backends.

# 19. Research References

These sources should be read by the implementation/research agent before finalizing architecture. Vendor-reported benchmark numbers must be independently reproduced on SottoMemEval.

- Letta — Context Repositories: Git-based memory, progressive disclosure, background reflection, defragmentation, and bootstrap from Claude Code/Codex histories. https://www.letta.com/blog/context-repositories/

- Letta — Trajectory: normalized, token-efficient experience data across coding-agent harnesses. https://www.letta.com/blog/trajectory/

- Letta research index — ongoing work on production memory evaluation, memory models, and continual learning. https://www.letta.com/research/

- Mem0 research — extracted memory and multi-signal retrieval; compare reported LoCoMo/LongMemEval results against Sotto's workload. https://mem0.ai/research

- Zep/Graphiti — temporal context graphs, fact invalidation, hybrid vector/full-text/graph retrieval. https://www.getzep.com/platform/graphiti/

- Graphiti documentation — open-source temporal knowledge graph concepts and incremental updates. https://help.getzep.com/graphiti/getting-started/overview

- LongMemEval-V2 — benchmark focused on experienced agents, workflow knowledge, changing state, gotchas, and premise awareness. https://arxiv.org/abs/2605.12493

- Zed Agent Client Protocol — open standard for agent/client interoperability. https://zed.dev/acp

# 20. Decision Rule

Do not optimize Sotto for remembering the most information. Optimize it for applying the smallest amount of correct, relevant, current knowledge at the right moment. The winning memory architecture is the one that makes Sotto more useful over months of real work without increasing wrong assumptions, latency, context bloat, or user correction burden.

The prototype is successful when the user stops thinking primarily in terms of Claude threads, Codex threads, and Grok threads and instead naturally says: “Sotto, continue what we were doing.”

## Problem Statement

Sotto users can run Codex, Claude Code, and Grok Build threads in their projects, but must leave Sotto to use Devin CLI. That separates Devin's replies, questions, and permissions from the user's existing thread workspace.

Zach has chosen Devin as another **local thread provider**. The first release must preserve Sotto-owned thread identity, explicit permission answers, working-copy behavior, and recoverable prompt delivery. Documentation establishes an ACP integration route; compatibility with Sotto's guarantees has not yet been demonstrated against a live Devin binary.

## Solution

Add Devin to the existing Providers settings and model picker. A user installs Devin CLI and signs in through its native flow, connects it in Sotto, chooses a Devin model, and starts a project-bound thread. Text prompts, streamed replies, activity, questions, permission decisions, interruption, and subsequent turns use the existing Threads experience.

Devin works in the thread's local working copy. Other connected providers remain usable. Sotto retains the thread and any saved history when Devin disconnects, and resumes the same provider session when it reconnects.

Deliver this through a compatibility experiment followed by a dedicated provider adapter. The experiment is an explicit prerequisite: it must establish the required protocol behavior before the feature is represented as usable.

## User Stories

1. As a Sotto user, I want Devin listed beside the existing providers, so that I can connect it in the same place.
2. As a Devin user, I want Sotto to use my native Devin sign-in, so that I do not need another API key in Sotto.
3. As a new user, I want a missing CLI or expired sign-in to tell me what to do, so that I can finish setup without losing my draft.
4. As a user with an incompatible CLI version or account policy, I want an actionable connection error, so that Sotto does not pretend the provider is ready.
5. As a user with several providers, I want connecting or disconnecting Devin to leave the others usable, so that unrelated work continues.
6. As a user creating a thread, I want to choose a model available to my Devin account, so that I know which provider and model will run it.
7. As a user resuming a thread, I want it to keep its original provider and model, so that unavailable settings are reported rather than silently replaced.
8. As a user working in a project, I want Devin to use its shared project folder by default, so that it sees my current files.
9. As a user isolating work, I want to choose a new or existing worktree using Sotto's existing controls, so that Devin works in the intended checkout.
10. As a user opening an empty thread, I want worktree creation to wait until the first send, so that browsing creates no unnecessary checkout.
11. As a user sending a prompt, I want immediate delivery feedback followed by streamed replies, so that I can tell whether Devin received it and is working.
12. As a user preparing another prompt, I want the existing follow-up queue to work, so that I can continue writing while Devin runs.
13. As a user reviewing Devin's work, I want supported command and file activity in the thread, so that I can understand what happened.
14. As a user asked a question, I want to answer it in the thread, so that Devin can continue with my choice.
15. As a user asked for permission, I want to inspect the requested action and explicitly allow or deny it, so that I retain control.
16. As a user deferring a permission, I want skipping, closing a pane, or disconnecting never to count as approval, so that silence grants nothing.
17. As a user stopping work, I want interruption to stop the active turn according to verified native behavior and resolve pending interactions safely, so that the displayed state is trustworthy.
18. As a user restarting Sotto, I want the same thread identity and retained history, so that I can continue where I left off.
19. As a user facing a lost acknowledgement, I want Sotto to reconcile the earlier send without sending it again, so that Devin does not perform duplicate work.
20. As a user whose provider session is missing or locked, I want Sotto to preserve my saved thread and draft and explain the problem, so that it cannot silently replace my session.
21. As a user typing directly in the same native Devin session, I want Sotto to recognize that input and stop automatic follow-ups, so that stale supervision does not compete with me.
22. As a user who disconnects Devin, I want retained threads to stay visible and readable where history was kept, so that disconnecting does not discard my work.
23. As a user with a large archive, I want only needed provider sessions to start, so that connecting Devin does not reopen every thread.
24. As a privacy-conscious user, I want Keep local history to retain its existing meaning, so that Sotto saves no message text when it is off.
25. As a user choosing Devin, I want clear account, billing, and provider-data information, so that I understand the service I am using.
26. As a keyboard user, I want provider setup and thread decisions to follow Sotto's existing focus and Escape behavior, so that I can complete the journey without a mouse.
27. As a Windows or Apple silicon Mac user, I want the local provider verified on my platform, so that advertised support reflects actual behavior.
28. As a user with voice coordination disabled, I want manual Devin threads to work without exposing gated coordination features, so that connecting a provider does not enable them.
29. As a user who explicitly manages a thread when coordination is enabled, I want the same capability and authority checks applied to Devin, so that supervision never answers permissions.
30. As a user encountering an unsupported optional feature, I want its control to remain unavailable, so that Sotto does not imply capabilities it has not verified.

## Implementation Decisions

1. **Begin with a bounded compatibility experiment.** Use the installed CLI in disposable local working folders. Record the exact Devin version, platform, ACP version, advertised capabilities, and account route. Identify Sotto truthfully as the client. Prove authentication, model enumeration and selection, create/prompt/update/cancel, question and permission exchange, loading the same session, delivery reconciliation, and native takeover. Documentation and fixtures alone are insufficient evidence.

2. **Treat required incompatibilities as blockers.** The experiment passes only if explicit permission decisions, durable session identity, authored-message reconciliation, and external-input detection can be implemented without guessing or weakening Sotto's guarantees. Also prove whether client filesystem or terminal execution is required. If a required operation is missing, publish the finding and seek a scoped design decision rather than silently substituting terminal scraping, repeated one-shot execution, an impersonated client, or automatic approval. Optional features may remain unavailable.

3. **Add a dedicated Devin provider adapter.** Implement the existing AgentHost contract and route it through SottoThreadHost and ConfiguredProviderHost. Keep native identifiers and protocol details inside the adapter. Sotto thread IDs remain the only thread identities used by coordination and clients. Existing thread bindings, projects, drafts, and assignments belonging to other providers remain unchanged.

4. **Use the native ACP subprocess connection.** Launch the executable directly, hidden on Windows, through bounded stdin/stdout JSON-RPC. Reuse established framing and process-lifecycle patterns only where they fit. Grok-specific authentication, model metadata, history queries, and question extensions are not a Devin protocol. Keep frame sizes, pending requests, queued output, and stderr consumption bounded. Unknown reverse requests receive a safe unsupported response. No provider payloads or stderr contents reach logs.

5. **Keep authentication native.** The first release requires installation and sign-in outside Sotto, with setup instructions in the existing provider detail. The adapter must establish that the intended native account is used; it must not read or copy credential files, accept keys in the renderer, inherit an unrelated billing credential, or fall back to another account. Authentication failures preserve local work. Sotto does not install or update Devin automatically, purchase credits, or enable overages.

6. **Negotiate and verify compatibility.** Validate protocol capabilities and maintain an explicit tested CLI compatibility policy. Unknown required shapes fail before prompting. The experiment determines the supported baseline; no version is declared supported merely because documentation mentions ACP. A catalog refresh is account-derived and reports unavailable models without replacement.

7. **Keep model selection and permission policy explicit.** The required first-release path selects a model at thread creation and uses the verified approval-required mode. Confirm both before a prompt can be sent or resumed. Existing-thread model/effort changes and additional native permission modes remain unavailable in this scope. Never switch to Smart or Bypass to unblock execution. Native configuration and imported rules must not silently widen the policy represented by Sotto; incompatible precedence produces an actionable error. Preserve the user's global configuration.

8. **Translate requests through existing thread decisions.** Map offered permission choices and supported structured questions to existing request types. Return only the user's valid choice, once, to the correct pending native request. Support one-time Allow and Deny; persistent permission grants are outside this first release. Duplicate, stale, malformed, unsupported, or uncertain answers must not create a new grant. Closing a pane is observational. Interrupt/disconnect never approves outstanding requests. Supervision remains unable to answer permissions under ADR-0004.

9. **Preserve prompt delivery semantics.** Distinguish queued intent, transmission, confirmed native acceptance, and turn completion. A completion response is not assumed to be an initial acknowledgement. Persist dispatch identity before transmission, reconcile it against native evidence, and preserve uncertainty if acceptance cannot be established. Reconnection, retry, and late replies must not resend an ambiguous mutation. Apply equivalent care to session creation and settings confirmation, preventing orphaned duplicate sessions.

10. **Use Sotto's event store and working-copy ownership.** Append observed message changes through the existing history boundary; replay must not duplicate stored messages. Preserve lazy session startup, watched-set behavior, history windows, and safe idle reaping. Session loss never silently starts a replacement. Shared folders and worktrees follow existing Sotto rules, including first-send creation and refusal of moved, replaced, occupied, or otherwise invalid owned checkouts. Native configuration must not redirect the selected working directory.

11. **Prove takeover and process behavior.** Distinguish Sotto-dispatched messages from input authored directly in the same native session. Refresh the target before a guarded follow-up and reject stale input. Determine whether work stops or survives when the ACP process exits and report that outcome accurately; survival is not assumed. Verify multiple threads, cancellation, clean shutdown, process ownership, and pending-request recovery without attaching an answer to a replacement request.

12. **Extend existing provider registration and UI.** Add Devin to provider identity schemas, labels, status aggregation, model namespaces, provider marks, and enabled-provider capacity. Upgrades preserve the existing enabled set; Devin starts disabled. Keep native provider connections independent and avoid coupling this addition to the separate coordinator-account catalog. Reuse existing Providers and Threads surfaces and capability controls, with no redesign.

13. **Keep optional features explicit.** The first release includes text prompts, queued follow-ups, streamed replies, supported activity, questions, permission answers, interrupt, restart recovery, and working copies. Images, a native skills picker, rewind, manual compaction, active-turn steering, advanced slash-command interfaces, and additional permission modes remain unavailable for Devin until separately implemented and verified. A feature supported by an underlying model is not automatically supported by the adapter.

14. **Document privacy before integration.** Record the new provider decision and actual required destinations in an ADR and README before wiring the provider into the app. Distinguish Sotto's storage/logging promises from Devin's own persistence, analytics, and hosted processing. Establish the chosen account's applicable retention/training controls and configuration imports. Sotto adds no telemetry and sends no prompts merely to discover or connect a provider. Preserve Keep local history behavior and existing credential boundaries. An unresolved conflict with the project's privacy rules requires a decision, not an invented opt-out flag.

15. **Keep the local platform scope.** Verify native Windows first and Apple silicon macOS second. WSL path translation and WSL-hosted sessions are outside this scope. If enterprise policy requires a sandbox unavailable on native Windows, explain the incompatibility and leave the provider disconnected rather than disabling that policy. Sotto initiates no cloud handoff or cloud resource creation.

16. **Keep dependencies and feature gates unchanged.** Use existing dependencies and Node builtins; production dependencies remain zod and node-pty. Manual provider use does not enable voice, memory, or supervision. Existing gates and capability checks apply whenever those features are enabled.

17. **Deliver in five stages.** First establish native compatibility and privacy facts. Second record the integration decision and supported behavior. Third implement the adapter and recovery against the shared contract. Fourth wire the existing provider and thread controls. Fifth complete automated gates, native verification, and rendered user-journey checks. Each stage leaves reviewable evidence; a demo conversation does not complete the feature.

## Testing Decisions

- **Primary seam:** test externally visible AgentHost behavior using the existing shared adapter contract and a scripted Devin ACP child process. Extend the existing Sotto thread-identity and WorkspaceHost/event-store integration tests where the guarantee crosses those wrappers. Avoid introducing a parallel provider abstraction or tests coupled to private helper calls.
- **Protocol grounding:** create the fake from verified native shapes. The fixture must validate outbound commands and answers and reproduce delayed/lost acknowledgements, process loss, malformed frames, permission races, and externally authored input. Trigger these conditions deterministically rather than shortening deadlines.
- **Required contract behavior:** create a project/thread, send and stream, queue a follow-up, answer questions, explicitly allow/deny, skip without granting, interrupt, recover the same thread after restart, reconcile an ambiguous send without replay, recognize takeover, reject stale follow-ups, start lazily, reap only eligible idle sessions, and append history without duplication. Required guarantees are not skipped to make a green suite.
- **Additional integration coverage:** duplicate and late permission answers; loss during creation or prompt dispatch; missing/locked native sessions; restored history and history disabled; repeated identical prompts distinguished by dispatch identity; two simultaneous Devin threads; another provider remaining usable; invalid working-copy bindings; configuration precedence and authentication failures.
- **Electron seam:** exercise installation/sign-in guidance, connect/disconnect, account-derived model selection, thread creation, streamed output, permission/question handling, interruption, reconnect, and readable retained history through the real preload boundary with the scripted provider. Check that unsupported controls remain unavailable and existing providers still work.
- **Native evidence:** run an explicit opt-in live suite with an installed, authenticated CLI and authorized account usage on native Windows and Apple silicon macOS. Use synthetic prompts and harmless edits in disposable folders. Capture sanitized shapes and stable event names, not raw prompt/protocol logs or keys. Verify permission rejection prevents the edit and approval allows only the intended request. A fixture pass is not a native compatibility claim.
- **Visual and accessibility evidence:** inspect affected settings, model selection, transcript, and pending decisions at 1600×1000, 1280×800, and 820×560; dark/light, reduced motion, keyboard focus, Escape, accessible names, contrast, and overflow. Use the existing design gate without regenerating baselines unless the appearance intentionally changes.
- **Completion:** pass the current documented CI gates with the CI worker cap, relevant built Electron tests, and the two-axis standards/spec review. Record native versions, actual platform checks, screenshots, and any limitations in the verification note. The feature remains incomplete if a required platform or recovery guarantee is unverified.

## Out of Scope

- Devin Cloud sessions, handoff controls, cloud relay, remote working copies, and cloud resource management.
- Using Devin as Sotto's reasoning coordinator, personal-chat provider, speech provider, or transcription provider.
- A dedicated Devin terminal launcher, embedded terminal UI, or redesign of Providers and Threads.
- WSL integration, new platform targets, CLI installation/update management, and Sotto-managed Devin credentials.
- Importing unrelated existing Devin sessions or relabelling other providers' threads.
- Images, native skills browsing, advanced slash commands, rewind, manual compaction, active-turn steering, model/effort changes after creation, and expanded permission modes for Devin.
- Automatic permission answers, new authority semantics, a generic ACP framework, and new production dependencies.

## Further Notes

This specification reflects Zach's decision to start with a local thread provider. The present work is specification only: it does not install Devin, authenticate an account, run inference, or implement the feature.

As of the research performed on September 19, 2026, no Devin executable was found on the current PATH and no live compatibility check has been run. The official command reference documents the ACP subprocess interface, but exact capabilities and recovery behavior remain experiment outcomes. The implementation must not confuse protocol-level facilities with Devin support.

Cognition documents CLI-related usage analytics; current general data controls require account-specific review. These facts make privacy verification part of the initial experiment and ADR, not proof that a compliant configuration is already known.

Prior art: the existing Codex, Claude, and Grok adapter contracts; Sotto-owned identity (ADR-0002); user permission authority (ADR-0004); independent provider connections (ADR-0008); voice/memory gates (ADR-0012/0013); working copies (ADR-0014); restored history/cursors (ADR-0015); and the event store with lazy sessions (ADR-0016). Preserve these decisions; amend an ADR explicitly before accepting a contradiction.

Primary references:
- [Devin CLI commands and ACP](https://docs.devin.ai/cli/reference/commands)
- [Devin in Zed](https://docs.devin.ai/cli/acp/zed)
- [Devin permissions](https://docs.devin.ai/cli/reference/permissions)
- [Devin CLI controls and analytics](https://docs.devin.ai/cli/enterprise/controls)
- [Cognition data controls](https://docs.devin.ai/admin/security)
- [Devin sandbox requirements](https://docs.devin.ai/cli/sandbox)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn)

Planning estimate: 1–2 engineering days for the initial compatibility experiment; approximately 1–2 engineering weeks in total for the local provider if required behavior is supported. These are estimates, not commitments or measured results.

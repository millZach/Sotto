# 2. Sotto owns thread identity

## Status

Accepted — 2026-09-10.

## Context

Agent control was built against the local T3 Code host. Assignments, queue items and drafts referred to threads by the ID the host reported, which for discovered threads was T3's own thread ID. The memory-first spec (`docs/superpowers/specs/2026-09-10-sotto-memory-first-prototype-spec.md`, v0.2, section 10) makes threads a core Sotto function: memory, goals and the queue must bind to an identity that outlives any provider session, because T3 is scaffolding that native Codex, Claude and Grok adapters will replace, and because a provider session can be lost, resumed or re-created while the user's relationship with the thread continues.

Constraints:

- No visible change in behaviour while T3 is the only provider.
- Existing agent control, recovery and end-to-end tests must pass unchanged. Those tests address threads by fixed IDs through the fake host.
- Production dependencies stay exactly `['zod']`, so persistence uses the existing atomic JSON store.

## Decision

**Sotto mints a UUID for every thread and that UUID is the only thread identity outside the provider adapter.** `SottoThreadHost` implements the existing `AgentHost` interface, delegates to a provider adapter, rewrites every snapshot so thread IDs are Sotto thread IDs, and translates commands back to provider session IDs. `AgentControl` is unchanged; it never learns a provider session ID.

**Bindings are persisted in a thread registry.** `threads.json` in the user data folder holds one record per thread: Sotto thread ID, provider, provider session ID, project ID and creation time. The in-memory map is authoritative and writes are coalesced. Async host paths flush the registry before returning so a binding is on disk before the coordinator can persist an assignment that refers to it. Provider events that arrive before the registry has loaded are dropped rather than allowed to mint IDs the disk would contradict. Duplicate rows on disk are dropped on load, first wins, instead of treating the file as corrupt. The registry never deletes bindings.

**The first run adopts existing IDs.** Installs that predate the registry saved provider session IDs as thread IDs in `agents.json`. When `agents.json` already refers to threads (assignments, queue items, selection, draft or outbox) and `threads.json` does not exist, discovered threads are bound with the provider's own ID as their Sotto thread ID, so assignments, drafts and queue items keep resolving after the upgrade. Threads Sotto creates, threads discovered once the registry file exists, and every thread on a fresh install get fresh UUIDs.

**Threads Sotto creates keep the ID the coordinator chose.** For `create-thread` the coordinator's UUID becomes the Sotto thread ID, a fresh UUID is reserved as the provider session ID, and the provider receives only the session ID. Outbox reconciliation therefore keeps working against Sotto IDs.

**The `AgentHost` interface is the thread interface.** Its verbs map onto the spec's create, resume, prompt, cancel, status and events (see `CONTEXT.md`). It was kept rather than renamed so every existing adapter and test stays valid. The end-to-end fake, `E2EAgentHost`, speaks Sotto IDs directly and is used unwrapped in tests; a provider-facing fake with its own session IDs exercises the translation layer in unit tests.

## Consequences

- Native adapters implement `AgentHost` against their own session IDs and are wrapped by `SottoThreadHost` with a different provider string. No coordinator change is needed to add or remove a provider.
- Provider session IDs are available to later features (open the underlying transcript, import history) through the registry, without exposing them in renderer state.
- A binding written after a crash window could be lost, which would give a discovered thread a new Sotto ID on next start and orphan an assignment. The flush-before-return rule makes this window small; a durable fix belongs to the SQLite persistence work. A corrupt `threads.json` is backed up and replaced by an empty registry, which re-mints every discovered thread; that is the same loss and gets the same fix.
- Project IDs in bindings are still the provider's project IDs. Sotto-owned project identity is a later change.
- The renderer still labels the connection "T3 Code". That is presentation, not identity, and changes with the native adapters.

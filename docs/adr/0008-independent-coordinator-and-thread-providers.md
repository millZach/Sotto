# Independent coordinator and thread providers

Accepted September 12, 2026 following the provider-settings correction to ticket #24. Sotto's coordinator account, model and enablement control reasoning and supervision; installed thread providers have independent connections, and a new thread's model chooses its provider. This supersedes the single active-provider lifecycle in ADR-0005: a composite host aggregates catalogs and routes existing Sotto thread IDs through their durable bindings, with per-provider connection and capability checks.

Model IDs and additional providers' project IDs are namespaced to prevent collisions. The native provider selected before this upgrade retains its original public project IDs, with that choice persisted once in `provider-project-identity.json`; renaming those IDs would orphan existing project memories and permission policies. Other providers cannot inherit those scopes, even when native IDs or folders coincide. A global folder-based project registry would require a broader identity and authority migration, so it is deferred.

Provider connection and discovery operations run outside the shared coordinator command queue, including startup reconnect. A slow or failed connection must not delay another provider's thread submission. Thread mutations keep their ordering, permission checks and outbox recovery. An uncertain auxiliary folder registration is recorded separately before dispatch, so retrying a cross-provider thread creation cannot replay registration or pretend a thread was already submitted.

The Providers settings use the supplied T3 list/detail reference, with Configuration and Models tabs in Sotto's Crossing style. Configure agents contains the coordinator settings. The [T3 source study](../research/2026-09-12-native-thread-source-study.md) remains the protocol and UI provenance.

## Amendment: new threads inherit Agents (September 21, 2026)

Zach chose one default after a saved Grok thread override repeatedly won over the Claude Opus agent selected in Settings. New threads now inherit the native subscription and model in Settings > Agents; an empty model choice uses that account's reported default. This supersedes an independently configurable default for new threads, while preserving independent provider connections and explicit per-thread model choices.

An unavailable or not-yet-discovered inherited model stays selected, with creation waiting for that model or an explicit per-thread choice. It never silently switches to another native provider. If Agents uses no account or a hosted API, there is no corresponding native thread agent: the ready primary thread provider, then another ready native model, remains the starting choice. Hosted reasoning is not repurposed as a thread provider.

The old serialized defaultModelId field is accepted for compatibility but ignored for new-thread selection. Its controls are removed from Providers and the legacy agent configuration surface. Existing threads, restored creation choices, and model choices the user makes in an open dialog keep their selected models. No live settings need to be rewritten to resolve an old override.

# Effort levels run lowest first, and a Grok thread starts on Grok's flagged default

Accepted September 22, 2026, in the fix for issue #223. Grok reports a model's reasoning effort levels highest first (`xhigh, high, medium, low` from Grok 1.0.5), and both Grok adapters passed that order through. Every effort control reads a model's levels least to most thorough and treats the last as the highest level (ADR-0019), so the slider ran backwards and Low wore the highest-level outline. Fixing it meant deciding where the order is set, and the same change moved what a new Grok thread starts on. Both are recorded here because they were decided, not followed.

## Decision

**A model's levels run least to most thorough, and the adapter puts them that way.** `orderReasoningEfforts` in `src/shared/reasoningEfforts.ts` is called wherever a provider's catalog becomes Sotto's: both Grok routes, both Codex routes and the Claude Code subscription route. It returns the provider's ids verbatim and drops a repeat, because each id goes back to the provider unchanged. It turns the whole list round only when the levels it knows (none, minimal, low, medium, high, xhigh or extrahigh, max) run highest first. It does not sort, so a level Sotto does not know, such as GPT-6 Astra's Ultra after Max, keeps its place beside its neighbours. No renderer control sorts for itself. The order is set at the adapter rather than in `ConfiguredProviderHost.aggregate` or the renderer, because personal chats, the subscription account path and the E2E host all bypass `aggregate`, and a renderer-only fix would leave the terminal, Providers settings and coordinator lists backwards. ADR-0002 is unchanged: the adapter still owns the provider's ids.

**A Grok thread's default is the level Grok flags as its default.** Grok marks one level `default: true` and also reports `_meta.reasoningEffort`, the level the connection's session is on now. The thread adapter runs against the user's own Grok home, where that session level follows whatever the user set in Grok's own settings. The adapter takes the flagged level as the model's `defaultReasoningEffort` and uses the session level only when nothing is flagged. The card's **Default** button then means what it means on Codex and Claude Code, the model's own level, and not a setting another application holds.

**A thread always starts on a level Sotto names.** The New thread and New terminal dialogs and the workspace path already fill in the model's default. The Agents view's new-thread form and a coordinator dispatch send no level, so the Grok adapter fills in the model's default there, sends it to Grok and records it. Otherwise Grok would run at the user's Grok setting while the chip showed the flagged default.

**The subscription route keeps its order.** `subscriptionGrok.ts` starts its session in an isolated Grok home, where the session level and the flagged default agree, so it still prefers the session level.

## Consequences

- A user who lowered Grok's effort in Grok's own settings gets new Sotto Grok threads on Grok's flagged default, High for grok-4.6, unless they choose another level in Sotto. The README says so where it describes the effort chip. Sotto does not read the user's Grok settings as a preference. If that turns out to be wanted, the fix is to read it on purpose and show it as the chosen level, not to let the session level stand in for the default.
- A Grok thread created without a level now records one, so its reloads check that Grok confirms it, as they already did for a thread created with a level.
- The order rule knows eight names. A provider that reports fewer than two of them gives no direction, and its list is shown as it came.

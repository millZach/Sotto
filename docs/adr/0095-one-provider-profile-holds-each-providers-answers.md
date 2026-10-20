# One provider profile holds each provider's answers

## Status

Accepted on October 20, 2026, as the first stage of the provider-parity plan, a study of October 19, 2026 of what a Claude Code thread can do that the other providers' threads cannot. Zach decided that a Codex thread gets the compaction recommendation, that a Muse thread gets it only if Muse says how full its context is, and that Grok Build, Devin and OpenCode get none. It amends the September 12, 2026 threads discussion (`docs/threads-product-discussion.md`), which kept T3's Claude-only recommendation.

## Context

Sotto asked "is this provider X?" in several places, each with its own list: which providers write short text and which take Sotto's tool servers (`src/shared/agents.ts`), which Watcher runs on (`src/shared/workerRoles.ts`, and a second copy in `src/renderer/src/watcher/watcherProviders.ts`), which skill sigils a composer takes (`composerSkills.ts`), and which thread is offered the compaction recommendation under the composer (`ThreadCompaction.tsx`, `thread.providerId === 'claude'`). Adding a provider meant finding each list. The last one also held back a recommendation Codex and Muse could act on: both compact on request and both say how full a thread's context is, but only a Claude thread was ever told its context was large.

## Decision

**1. One record per provider.** A **provider profile** (CONTEXT.md) is what Sotto knows about one provider that does not change from thread to thread. `PROVIDER_PROFILES` in `src/shared/providerProfile.ts` holds one for every provider ID, typed `Record<ProviderId, ProviderProfile>`, so a new ID is a type error there until it has one. It holds whether the provider writes short text, takes Sotto's tool servers, runs Watcher, which skill sigils its composer takes, whether it compacts, and whether it says how full a thread's context is. Main and the renderer read it; the lists it replaced are gone or derived from it. A provider this build does not know, as a newer host may send, has no profile and gets nothing it has not said it does, as before.

**2. What is moved, not changed.** Every provider gives the same answers it gave before for short text, tools, Watcher and skill sigils. Watcher's providers are named in the provider list's order, which is the order `watcherProviderSchema` and every sentence about Watcher already used. The skill sigils are only moved: Codex still takes `$` alone, and Devin, Muse and OpenCode still have no skills; this decision gives none of them more.

**3. A profile answer that a capability also gives must agree with it.** An adapter's `capabilities` say what its connected client can do now; the profile says what Sotto offers that provider before a client says anything. Where both name the same thing, compaction today, the adapter contract (`tests/integration/adapterContract.ts`) holds them equal for every adapter. Each fixture names the provider it speaks for, so the contract can look the profile up.

**4. The compaction recommendation follows the profile, not a name.** The recommendation under the composer is offered when the thread's provider compacts and says how full its context is, the thread's own capability allows compaction, and its usage meets the rules it always had: 100,000 tokens or more of context, no change to that figure for 70 minutes, a usage model that is the thread's own, nothing running or waiting, not dismissed. Claude Code's threads are offered it exactly as before. Codex reports context through its usage ledger and compacts with `thread/compact/start`, so its threads are offered it too. Muse reports context with `session/contextUsage` and compacts, so its threads are offered it once Muse has sent one; the token counts Muse sends after it now keep the time the context was reported, which they used to drop. Grok Build, Devin and OpenCode cannot compact and are never offered it.

## Consequences

- Adding a provider is one profile, and the type checker names it as missing. The contract fails for an adapter whose compaction capability and profile disagree.
- The 100,000-token and 70-minute rules were tuned for Claude. Codex and Muse use them unchanged; if they read badly there, they become profile answers.
- A Muse client that never sends `session/contextUsage` leaves its threads without the recommendation, which is the same as before.
- After a compaction, Claude Code's usage records the smaller context at once. Codex and Muse record it only when they next report usage, so until then the recommendation could return for a thread just compacted. Not checked on a live client.
- Compacting and saying how full the context is are two profile answers, though every provider gives both the same today: one is what a provider does when asked, the other what it tells Sotto unasked.
- `watcherProviderSchema` in `src/shared/watcher.ts` stays a written list, since a schema is read before any profile; a unit test holds it equal to the providers whose profile runs Watcher.
- Not moved: lists that are already one `Record` keyed by provider (labels, marks, sign-in and install guides), the host-setup provider list in `src/main/hosts/hostSetupThreads.ts`, and checks that are a single use, such as which provider reads its own usage quota. They can join the profile when a second reader needs them.

## Proof

Unit tests of the profile: one for every provider, the answers each provider gave before for short text, tools, Watcher and sigils, nothing for an unknown provider, and Watcher's providers matching `watcherProviderSchema`. Unit tests of the recommendation: Claude Code's boundary and dismissal as before, Codex and Muse offered at the same boundary and not without a context figure or with another model's usage, and Grok Build, Devin, OpenCode and a thread naming no provider never offered it. An integration test over the fake Muse client keeps the context's time across the token counts that follow it. The adapter contract's profile case passes for Codex, Claude Code, Grok Build, Devin, Muse and OpenCode.

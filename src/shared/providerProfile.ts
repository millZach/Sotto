import { providerIdSchema, type ProviderId } from './providerIds'

/** How a written skill mention starts: `$name` for every provider with skills, and the native `/name` where one takes it. */
export type SkillSigil = '$' | '/'

/**
 * What Sotto knows about one provider that does not change from thread to thread: the per-provider answers every
 * part of Sotto asks, held in one record so a new provider is one entry here (ADR-0095). What a connected client
 * says it can do now is its adapter's `capabilities`; where a profile answer and a capability name the same thing,
 * the adapter contract holds them equal.
 */
export interface ProviderProfile {
  /** It writes Sotto's short text, the title, branch name and Git drafts, in a side call (ADR-0026). */
  readonly writesShortText: boolean
  /** It takes Sotto's tool servers. A Devin thread also needs its host to say it gives them (`threadTakesSottoTools`). */
  readonly takesSottoTools: boolean
  /** Watcher runs on it (ADR-0073, ADR-0079), so Orchestrating's model may be one of its own. */
  readonly runsWatcher: boolean
  /** How a skill mention may start in its composer. */
  readonly skillSigils: readonly SkillSigil[]
  /** It folds a thread's context on request (`compact-thread`). The adapter's `compact` capability says the same. */
  readonly compacts: boolean
  /** It says how full a thread's context is (`usage.contextUsed`), which the compaction recommendation reads. */
  readonly reportsContext: boolean
}

/**
 * Every provider's profile. The `Record` makes a new provider ID a type error here until it has one.
 *
 * Why a provider writes no short text is said at `providerWritesShortText`. Devin cannot host Watcher's tools, and
 * OpenCode's approvals have not been read for it. Codex reads only `$name`; Claude Code and Grok Build also take their
 * native `/name`. Grok Build, Devin and OpenCode cannot compact, and none of the three says how full its context is.
 * Compacting and reporting context are kept apart: one is what the provider does when asked, the other what it tells
 * Sotto unasked, and the compaction recommendation needs both.
 */
export const PROVIDER_PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
  codex: { writesShortText: true, takesSottoTools: true, runsWatcher: true, skillSigils: ['$'], compacts: true, reportsContext: true },
  claude: { writesShortText: true, takesSottoTools: true, runsWatcher: true, skillSigils: ['$', '/'], compacts: true, reportsContext: true },
  grok: { writesShortText: true, takesSottoTools: true, runsWatcher: true, skillSigils: ['$', '/'], compacts: false, reportsContext: false },
  devin: { writesShortText: false, takesSottoTools: true, runsWatcher: false, skillSigils: ['$'], compacts: false, reportsContext: false },
  muse: { writesShortText: false, takesSottoTools: true, runsWatcher: true, skillSigils: ['$'], compacts: true, reportsContext: true },
  opencode: { writesShortText: true, takesSottoTools: true, runsWatcher: false, skillSigils: ['$'], compacts: false, reportsContext: false },
}

/**
 * A provider's profile, or undefined for a thread that names no provider or a provider ID this build does not know,
 * such as one a newer host sent. Callers decide what an unknown provider gets; most get nothing it has not said it does.
 */
export function providerProfile(providerId: string | undefined): ProviderProfile | undefined {
  return providerId !== undefined && Object.hasOwn(PROVIDER_PROFILES, providerId) ? PROVIDER_PROFILES[providerId as ProviderId] : undefined
}

/** The providers Watcher runs on, in the provider list's order: Codex, Claude Code, Grok Build, Muse. */
export function watcherProviderIds(): ProviderId[] {
  return providerIdSchema.options.filter(id => providerProfile(id)?.runsWatcher === true)
}

/**
 * Whether Sotto may recommend compacting this provider's threads: it can compact and says how full a thread's
 * context is. The thread's own usage, its connection and its work still decide whether the recommendation shows.
 */
export function providerRecommendsCompaction(providerId: string | undefined): boolean {
  const profile = providerProfile(providerId)
  return profile?.compacts === true && profile.reportsContext
}

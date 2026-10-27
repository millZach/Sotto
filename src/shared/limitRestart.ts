import { z } from 'zod'
import type { ProviderId } from './providerIds'

/**
 * Restarting stopped threads (ADR-0144, an Owl feature): when a provider's usage limit stops a thread that was working,
 * Sotto restarts it once the limit resets, and when Sotto itself closes on a working thread, it restarts it when Sotto
 * opens again. Each restart is one note from Sotto, the same words on every provider, tagged "Restarted"; it answers and
 * approves nothing. Watcher goes first when its own provider stopped it, and hears which threads were restarted.
 */

/** The Owl list's ID for the feature (`owlFeatures.ts`). */
export const RESTART_STOPPED_FEATURE = 'restart-stopped-threads'

/** The note a thread gets when the limit that stopped it resets. `{provider}` is the provider's own name. */
export function limitRestartNote(provider: string): string {
  return `${provider}’s usage limit has reset. Your last turn stopped at the limit partway through, and any command or tool it was running stopped too, so its result may be missing. Check where things stand, then carry on.`
}
/** How every limit restart note begins, for telling one from other text a wake-up record already marks as Sotto's. */
export const LIMIT_RESTART_NOTE_TAIL = 'usage limit has reset. Your last turn stopped at the limit partway through'
/**
 * Whether a message Sotto's own record has already marked as a wake-up is a limit restart note. The note opens the wake-up
 * it is part of, after the provider's name, so it is told by how the text starts; text alone never makes a message Sotto's.
 */
export function isLimitRestartNoteText(text: string): boolean {
  const start = text.trimStart(), at = start.indexOf(`’s ${LIMIT_RESTART_NOTE_TAIL}`)
  return at > 0 && at <= 64 && !start.slice(0, at).includes('\n')
}

/** How many limit restarts in a row one thread gets before it waits for the user, as the resume note has. */
export const LIMIT_RESTARTS_IN_A_ROW_MAX = 3
/** How long after the reset Sotto waits before restarting, so a provider's own clock a little behind ours has caught up. */
export const LIMIT_RESTART_GRACE_MS = 60_000
/** A reset further away than this is not believed: the thread waits for the user, as for a provider that said no time. */
export const LIMIT_RESTART_HORIZON_MS = 8 * 24 * 60 * 60_000

/**
 * A thread's scheduled restart, on its snapshot while one stands. `at` is when Sotto restarts it, absent when its provider
 * did not say when its limit resets, so Sotto will not restart it on its own. The host's coordinator sets and clears it;
 * absent otherwise, from stable and from hosts that predate it.
 */
export const scheduledRestartSchema = z.object({
  /** The provider whose limit stopped the thread. */
  provider: z.string().min(1).max(64),
  /** When the thread was stopped at the limit. */
  stoppedAt: z.iso.datetime(),
  /** When the limit resets, as the stop named it; Sotto restarts the thread a grace after. Absent when the provider did not say. */
  at: z.iso.datetime().optional(),
}).strict()
export type ScheduledRestart = z.infer<typeof scheduledRestartSchema>

/** The limit restart's news as the follow-up queue keeps it: which provider, when it stopped, which restart this is. */
export const limitRestartNewsSchema = z.object({
  source: z.literal('limit-restart'),
  provider: z.string().min(1).max(64),
  since: z.iso.datetime(),
  restarts: z.number().int().min(1).max(LIMIT_RESTARTS_IN_A_ROW_MAX),
}).strict()
export type LimitRestartNews = z.infer<typeof limitRestartNewsSchema>

/**
 * A usage-limit stop as an adapter reports it on the failed turn (`AgentThread['lastTurn']['limitStop']`): when the limit
 * resets, as an instant, absent when the provider did not say. Only a usage limit is reported: a spending limit never resets
 * on its own, so it schedules nothing. Set only while the feature is on; absent from stable and from older hosts.
 */
export const turnLimitStopSchema = z.object({ resetsAt: z.iso.datetime().optional() }).strict()
export type TurnLimitStop = z.infer<typeof turnLimitStopSchema>

/** A usage-limit stop as the coordinator reads it from a thread's failed turn: the provider, and the reset when it said one. */
export interface LimitStopReport {
  readonly provider: ProviderId
  /** When the limit resets, as an instant. Absent when the provider did not say. */
  readonly resetsAt?: string
}

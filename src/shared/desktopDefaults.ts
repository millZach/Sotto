import { z } from 'zod'
import { agentRuntimeModeSchema, type AgentRuntimeMode } from './agents'
import { parseWorkerRoleChoices, WORKER_ROLE_IDS, type WorkerRoleChoices } from './workerRoles'

/**
 * Desktop defaults (CONTEXT.md, #1310, Owl `cross-machine-work`): the user's new-thread default and worker roles as the
 * desktop holds them, which the desktop sends a host that runs delegation for its own threads when it connects and
 * whenever either changes. They are settings, never a key or a grant. A thread on that host that delegates is held to the
 * new-thread default they carry, and its kind of work starts on the worker roles they carry. A host never told holds every
 * delegated start to Ask for approval, and a host's own stored new-thread default never applies (ADR-0074).
 *
 * `newThreadRuntimeMode` is null when the desktop's default is the provider's own, which delegation reads as Ask for
 * approval. `workerRoles` is absent when the desktop's worker roles are off; the host then uses the roles' defaults. Roles
 * are read leniently, a row at a time, so a newer desktop's role an older host does not know costs only that row.
 */
export const desktopDefaultsSchema = z.object({
  newThreadRuntimeMode: agentRuntimeModeSchema.nullable(),
  workerRoles: z.record(z.string().max(64), z.unknown()).refine(rows => Object.keys(rows).length <= WORKER_ROLE_IDS.length * 4).optional(),
}).strict()
export type DesktopDefaultsInput = z.infer<typeof desktopDefaultsSchema>
export interface DesktopDefaults {
  readonly newThreadRuntimeMode: AgentRuntimeMode | null
  readonly workerRoles?: WorkerRoleChoices
}
/** The defaults as a host keeps them: lenient roles, and only what it knows. */
export function readDesktopDefaults(input: DesktopDefaultsInput): DesktopDefaults {
  return { newThreadRuntimeMode: input.newThreadRuntimeMode, ...(input.workerRoles ? { workerRoles: parseWorkerRoleChoices(input.workerRoles) } : {}) }
}
/** What a host answers when it has kept a desktop's defaults: when it took them. */
export const desktopDefaultsReceiptSchema = z.object({ receivedAt: z.iso.datetime() })
export type DesktopDefaultsReceipt = z.infer<typeof desktopDefaultsReceiptSchema>

/**
 * Why a host holds a delegated thread to Ask for approval when the desktop's new-thread default is wider: it was never
 * told the default, or the desktop that told it may not answer there (no `remote-answer` grant, ADR-0025).
 */
export type HostCeilingHold = 'not-told' | 'no-answer-grant' | 'answers-revoked'
/** The sentence that says so, for a refusal, a receipt and a listing. */
export const HOST_CEILING_HOLD_WORDS: Record<HostCeilingHold, string> = {
  'not-told': 'This machine has not been told your new-thread default yet, so a thread delegated here starts on Ask for approval until Sotto\'s desktop connects to it.',
  'no-answer-grant': 'This machine does not let your desktop answer permission requests here, so a thread delegated here starts on Ask for approval. To give it more, let your desktop answer permission requests on this machine first.',
  'answers-revoked': 'This machine no longer lets your desktop answer permission requests here, so a thread delegated here starts on Ask for approval.',
}

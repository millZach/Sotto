import { z } from 'zod'
import { providerIdSchema } from './providerIds'
import { workerKindSchema } from './workerRoles'

/**
 * A machine's checks as the window shows them (#1312, fourth part, Zach's pick C): the check running there first, then the
 * ones waiting, in the order asked. Only the machine's panel and a check's row in Tools › Agents show them; a card shows no
 * queue line. Main takes a queue's view only when it changes, never on the update path, and a host sends its own only to
 * a desktop whose hello accepts `check-queue-views`. Ids, whose check it is, and the few words that name a check whose
 * thread is not made yet; never a brief, a reply or a log. A check's install state is its thread's own
 * (`worktree.check.install`), which the window already holds once the thread is made. Owl only (`cross-machine-work`).
 */
/** The most checks one machine's view lists. Past it, the rest still wait; the panel names the ones it has. */
export const CHECK_QUEUE_VIEW_MAX = 100
/** The longest name a waiting check carries, cut to fit, as Watcher's and delegation's titles are. */
export const CHECK_QUEUE_TITLE_MAX = 512
const id = z.string().min(1).max(512)

export const checkQueueEntrySchema = z.object({
  /** The check's place in its machine's queue, by the ticket it took there. */
  id: z.string().min(1).max(128),
  /** Watcher's start, or a thread's delegation; absent where its owner has not said yet. */
  whose: z.enum(['watcher', 'thread']).optional(),
  /** The check's own thread, by the window's ID for it, once admission has named it. It is made only when its turn comes. */
  thread: id.optional(),
  /** The thread that asked for it, for a thread's check, by the window's ID for it. */
  by: id.optional(),
  /** The name it was asked for under, which a waiting check's thread does not carry yet. */
  title: z.string().min(1).max(CHECK_QUEUE_TITLE_MAX).optional(),
  /** The kind of work a thread's check was asked for, which names it when it was given no title. */
  work: workerKindSchema.optional(),
  /** The provider its thread starts on, once admission has chosen it; dropped where this side does not know the provider. */
  provider: providerIdSchema.optional().catch(undefined),
}).strict()
export type CheckQueueEntry = z.infer<typeof checkQueueEntrySchema>
/** One machine's queue, the running check first. */
export const checkQueueSchema = z.array(checkQueueEntrySchema).max(CHECK_QUEUE_VIEW_MAX)

/** One machine's queue as the window reads it: This computer's, or a connected host's that sends its own. */
export const machineChecksSchema = z.object({
  /** The machine, by host ID, as the machines line names it. */
  hostId: z.string().min(1).max(128),
  thisComputer: z.boolean(),
  /** Its checks, the running one first. */
  checks: checkQueueSchema,
}).strict()
export type MachineChecks = z.infer<typeof machineChecksSchema>
export const checkQueuesViewSchema = z.object({ machines: z.array(machineChecksSchema).max(256) }).strict()
export type CheckQueuesView = z.infer<typeof checkQueuesViewSchema>

/**
 * The window reads every machine's queue once, and main sends the whole view again whenever one changes. Registered only
 * while Watcher and Work across machines are both on, as the machines line is.
 */
export const CHECK_QUEUES_READ = 'sotto:checks:read'
export const CHECK_QUEUES_CHANGED = 'sotto:checks:changed'

/** What the window's preload offers of the queues, only where main registered them. */
export interface CheckQueuesBridge {
  read(): Promise<CheckQueuesView>
  onChanged(listener: (view: CheckQueuesView) => void): () => void
}

/** How many checks wait behind the running one: what the machines line says after a machine's working count. */
export function checksWaiting(checks: readonly CheckQueueEntry[] | undefined): number {
  return Math.max(0, (checks?.length ?? 0) - 1)
}

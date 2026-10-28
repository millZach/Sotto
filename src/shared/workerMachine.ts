import { z } from 'zod'
import { hostOsFamilySchema, type HostOsFamily } from './hostFacts'

/**
 * Where new workers start (#1032, Owl `cross-machine-work`): the machine a new worker starts on when the request that
 * starts it names none. `this-computer`, the default, starts it where Sotto always has, so nothing moves until the user
 * chooses. `watcher` leaves the machine to Watcher's judgement. Any other value is a connected machine's saved host ID.
 * A host ID that is no longer saved, or a machine not connected now, starts the worker on This computer instead, and the
 * receipt says why.
 */
export const WORKER_MACHINE_CHOICES = ['watcher', 'this-computer'] as const
export const workerMachineSettingSchema = z.union([z.enum(WORKER_MACHINE_CHOICES), z.uuid()])
export type WorkerMachineSetting = z.infer<typeof workerMachineSettingSchema>
export const DEFAULT_WORKER_MACHINE: WorkerMachineSetting = 'this-computer'
/** The machine a setting names, or undefined for This computer and for Watcher's own choice. */
export const workerMachineHostId = (setting: WorkerMachineSetting): string | undefined =>
  setting === 'watcher' || setting === 'this-computer' ? undefined : setting

/** A system a start may name instead of a machine (#1312's choice, built with #1032), matched against host facts. */
export const workerSystemSchema = hostOsFamilySchema
export type WorkerSystem = HostOsFamily
/** Each system as a sentence names it: "a Mac", "No Linux machine is connected". */
export const WORKER_SYSTEM_WORDS: Record<WorkerSystem, { readonly name: string; readonly one: string; readonly a: string }> = {
  windows: { name: 'Windows', one: 'Windows machine', a: 'a Windows machine' },
  macos: { name: 'macOS', one: 'Mac', a: 'a Mac' },
  linux: { name: 'Linux', one: 'Linux machine', a: 'a Linux machine' },
}

/**
 * How Watcher's `list_machines` says where new workers start: `machine` names the machine the setting chose, by host ID
 * and name, `this-computer` is the default, and `watcher` leaves it to Watcher.
 */
export const newWorkersStartSchema = z.object({ choice: z.enum(['watcher', 'this-computer', 'machine']),
  hostId: z.string().min(1).max(512).optional(), name: z.string().min(1).max(200).optional() }).strict()
export type NewWorkersStart = z.infer<typeof newWorkersStartSchema>

/**
 * Where a start was placed, as its receipt records it: the machine, by host ID and name, whether that is somewhere other
 * than where new workers start and, when it is, that machine's name (`defaultName`, absent when it is no longer saved), and
 * Sotto's sentence saying why when it placed it itself (a default machine not connected). `setUp` is there when the machine
 * had no copy of the project and Sotto gave it one (#1690): how, the folder, and whether the copy is up to date.
 */
export const workerPlacementReceiptSchema = z.object({ hostId: z.string().min(1).max(512), name: z.string().min(1).max(200),
  awayFromDefault: z.boolean(), defaultName: z.string().min(1).max(200).optional(), note: z.string().min(1).max(2_000).optional(),
  setUp: z.object({ how: z.enum(['added', 'cloned']), path: z.string().min(1).max(4_096), current: z.boolean(),
    // The fetched default branch a new worktree starts from when the checkout itself was left behind (#1690).
    startsFrom: z.string().min(1).max(255).optional() }).strict().optional() }).strict()
export type WorkerPlacementReceipt = z.infer<typeof workerPlacementReceiptSchema>

/**
 * The GitHub repository each of a machine's projects is a copy of, by its `origin` remote (#1032), so a start can find the
 * same project on another machine. What the optional host feature `project-origins` answers: the repository's host,
 * owner and name, never a path or a remote URL, and null for a project without a GitHub origin. Read leniently, as host
 * facts are, so a later host's additions still read on an older desktop.
 */
export const PROJECT_ORIGINS_MAX = 1_000
export const projectRepositorySchema = z.object({ host: z.string().min(1).max(253), owner: z.string().min(1).max(256), name: z.string().min(1).max(256) })
export const projectOriginsSchema = z.object({
  projects: z.array(z.object({ projectId: z.string().min(1).max(512), repository: projectRepositorySchema.nullable().catch(null) })).max(PROJECT_ORIGINS_MAX),
})
export type ProjectOrigins = z.infer<typeof projectOriginsSchema>

/**
 * Setting up a copy of a project on a machine that has none (#1690), as the optional host feature `project-setup` asks it:
 * the GitHub repository the start's project is a copy of, and the project's title, which the copy is added under.
 */
/**
 * The repository a setup names becomes a folder name and an HTTPS address on the host, so it is held to what a GitHub
 * remote can say (`parseGitHubRemote`): a host name that says GitHub, with no port or credentials, and an owner and a
 * name that are single path segments, never `.` or `..`.
 */
const segment = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u).refine(value => value !== '.' && value !== '..')
export const projectSetupRepositorySchema = z.object({ host: z.string().min(1).max(253).regex(/^[a-z0-9.-]*github[a-z0-9.-]*$/u), owner: segment, name: segment }).strict()
export const projectSetupRequestSchema = z.object({ repository: projectSetupRepositorySchema, title: z.string().min(1).max(512) }).strict()
export type ProjectSetupRequest = z.infer<typeof projectSetupRequestSchema>
/**
 * What setting up a copy did. `added`: a clone already in the machine's usual projects folder became a project, brought up
 * to date when nothing stood in the way. `cloned`: Sotto cloned the repository there. `current` says whether the copy is at
 * its default branch's newest commit on GitHub, and `reason` why not, as the end of a sentence ("it has uncommitted
 * changes"). `fetched` names `origin`'s default branch when a copy left behind was fetched all the same, so a new worktree
 * can start from what was fetched without moving the checkout. A refusal says in `message`, in plain words, what happened
 * and what to do; nothing was started and nothing of the user's removed. Read leniently, as project origins are, so a later
 * host's additions still read.
 */
export const projectSetupResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projectId: z.string().min(1).max(6_144), title: z.string().min(1).max(512), path: z.string().min(1).max(4_096),
    how: z.enum(['added', 'cloned']), current: z.boolean(), reason: z.string().min(1).max(500).optional().catch(undefined),
    fetched: z.string().min(1).max(255).optional().catch(undefined) }),
  z.object({ ok: z.literal(false), message: z.string().min(1).max(2_000) }),
])
export type ProjectSetupResult = z.infer<typeof projectSetupResultSchema>

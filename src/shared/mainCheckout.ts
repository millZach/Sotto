import { z } from 'zod'

/**
 * Keep main up to date (ADR-0142): every 15 minutes and after a pull request merges, the desktop fetches each of its
 * projects' checkouts and fast-forwards the default branch there when nothing of the user's is in the way. What it could
 * not do, and an update that changed a lockfile, reach the window through this bridge for the project row to say. An Owl
 * feature: the window has the bridge only while the startup answers turn `keep-main-current` on.
 */
export const MAIN_CHECKOUT_READ = 'sotto:main-checkout:read'
export const MAIN_CHECKOUT_CHANGES = 'sotto:main-checkout:changes'
export const MAIN_CHECKOUT_COMMAND = 'sotto:main-checkout:command'
export const MAIN_CHECKOUT_CHANGED = 'sotto:main-checkout:changed'
export const MAIN_CHECKOUT_RENDERER_ARGUMENT = '--sotto-keep-main-current'

/** How often every project is checked (Zach's pick, October 23, 2026); a merge checks its repository at once. */
export const MAIN_CHECKOUT_INTERVAL_MS = 15 * 60_000
/** How many files Show changes lists before it says how many more there are. */
export const MAIN_CHECKOUT_FILES_MAX = 8

const projectId = z.string().min(1).max(256)
const path = z.string().min(1).max(4_096)

/**
 * Why the default branch was left behind, when it was. `changes`: tracked files have local changes. `untracked`: a file
 * Git does not track would be overwritten by an incoming one. `in-progress`: a merge, rebase, cherry-pick or revert is
 * under way. `branch`: another branch, or a detached HEAD (null), is checked out. `diverged`: the default branch has
 * commits of its own that the remote's lacks, so it cannot move forward without a merge.
 */
export const mainCheckoutBlockSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('changes') }).strict(),
  z.object({ reason: z.literal('untracked') }).strict(),
  z.object({ reason: z.literal('in-progress'), operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']) }).strict(),
  z.object({ reason: z.literal('branch'), checkedOut: z.string().min(1).max(256).nullable() }).strict(),
  z.object({ reason: z.literal('diverged'), ahead: z.number().int().positive() }).strict(),
])
export type MainCheckoutBlock = z.infer<typeof mainCheckoutBlockSchema>

/** One project's line. A project with nothing to say has none. */
export const projectMainCheckoutSchema = z.object({
  projectId,
  /** The project's default branch, as the remote names it. */
  branch: z.string().min(1).max(256),
  /** How many commits the remote's default branch has that the local one lacks. */
  behind: z.number().int().nonnegative(),
  blocked: mainCheckoutBlockSchema.nullable(),
  /** The lockfiles the last update changed, until the user dismisses them or the next update replaces them. */
  dependencies: z.array(path).min(1).max(MAIN_CHECKOUT_FILES_MAX).nullable(),
}).strict()
export type ProjectMainCheckout = z.infer<typeof projectMainCheckoutSchema>

export const mainCheckoutStateSchema = z.object({ projects: z.array(projectMainCheckoutSchema).max(1_000) }).strict()
export type MainCheckoutState = z.infer<typeof mainCheckoutStateSchema>

/** What Show changes lists: the files in the way, or the commits only this computer has. */
export const mainCheckoutChangesSchema = z.object({
  items: z.array(z.object({ kind: z.enum(['modified', 'added', 'deleted', 'renamed', 'conflict', 'untracked', 'commit']), text: z.string().min(1).max(4_096) }).strict())
    .max(MAIN_CHECKOUT_FILES_MAX),
  more: z.number().int().nonnegative(),
}).strict()
export type MainCheckoutChanges = z.infer<typeof mainCheckoutChangesSchema>

export const mainCheckoutCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dismiss-dependencies'), projectId }).strict(),
  z.object({ type: z.literal('open-folder'), projectId }).strict(),
])
export type MainCheckoutCommand = z.infer<typeof mainCheckoutCommandSchema>

export interface MainCheckoutBridge {
  read(): Promise<MainCheckoutState>
  changes(projectId: string): Promise<MainCheckoutChanges>
  command(command: MainCheckoutCommand): Promise<MainCheckoutState>
  onChanged(listener: (state: MainCheckoutState) => void): () => void
}

/** The lockfiles whose change means the project's dependencies changed: npm, Yarn, pnpm and Bun, at any depth. */
export const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'] as const

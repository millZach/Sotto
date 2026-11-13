import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { AgentProject, AgentThread } from '../../shared/agents'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'

const grantSchema = z.object({ threadId: z.string().min(1).max(200), accountId: z.uuid(), at: z.iso.datetime() }).strict()
const fileSchema = z.object({ version: z.literal(1), grants: z.array(z.unknown()) })
/** One thread's leave to read one mail account, and when the user gave it. */
export type MailGrant = z.infer<typeof grantSchema>

/**
 * Whether a thread is open, as a mail grant means it: Sotto holds it, it is not archived, and it is not settled,
 * neither the thread nor its project. Settle is what the user presses to put work aside (CONTEXT.md, Settled), and a
 * grant ends there, so a thread restored later asks again.
 */
export function mailThreadOpen(snapshot: {
  readonly threads: readonly Pick<AgentThread, 'id' | 'projectId' | 'settledAt' | 'settledOverride' | 'archivedAt' | 'workspaceSettledAt'>[]
  readonly projects: readonly Pick<AgentProject, 'id' | 'workspaceSettledAt'>[]
}, threadId: string): boolean {
  const thread = snapshot.threads.find(item => item.id === threadId)
  if (!thread || isThreadClosed(thread)) return false
  return !isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))
}

/** More than anyone gives. Past it the oldest grant goes, and its thread asks again. */
const GRANTS_MAX = 500
/** How often, at most, the grants look at their threads while threads are changing. */
const CHECK_EVERY_MS = 2_000

/**
 * Mail grants (ADR-0205, decision 8): which threads the user has let read which mail accounts. A thread's first read
 * of a mail account waits on a card, and the user's yes is kept here, for that thread and that account, until the
 * user stops it, the thread is settled, archived or deleted, or the account is removed. It covers searching and
 * reading and nothing else. Only the user's answer on that card makes one.
 *
 * One small file in Sotto's data folder, so a thread does not ask again after Sotto restarts. It holds no mail and
 * no address: a thread's ID, an account's ID and a time. A file that cannot be read is no grants, so every thread
 * asks again; that errs towards asking.
 *
 * A grant that ends is gone from memory at once, whether or not the file could be written, and the file is written
 * again later. The one end that waits for the file is the user's own Stop, so it is never told a grant has ended
 * that a restart would bring back.
 */
export class MailGrants {
  private readonly path: string
  private grants: MailGrant[] | undefined
  private queue: Promise<unknown> = Promise.resolve()
  /** The file is behind what is held here. */
  private behind = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  /** Accounts being forgotten, and how many times over. None of their grants is honoured, from the moment that was asked. */
  private readonly forgetting = new Map<string, number>()
  /** How many times each account has been forgotten in this run: which copy of it is held now. */
  private readonly generations = new Map<string, number>()
  constructor(directory: string, private readonly options: {
    /** Whether a thread is still open: not settled, archived or gone. */
    readonly open: (threadId: string) => boolean
    readonly now?: () => Date
    readonly checkEveryMs?: number
  }) {
    this.path = join(directory, 'plugin-mail-grants.json')
  }

  /** Whether the thread may read the account without asking. A thread that is no longer open holds no grant. */
  has(threadId: string, accountId: string): Promise<boolean> {
    return this.inTurn(async () => {
      if (this.forgetting.has(accountId)) return false
      const grants = await this.load()
      if (!grants.some(grant => grant.threadId === threadId && grant.accountId === accountId)) return false
      if (this.isOpen(threadId)) return true
      await this.keep(grants.filter(grant => grant.threadId !== threadId))
      return false
    })
  }

  /**
   * Whether a thread is open, as a grant means it. This is the one test: the grant, the card that asks for it and
   * the read that follows a yes all go by it, so none outlasts the others. A thread that cannot be read is not open.
   */
  open(threadId: string): boolean {
    return this.isOpen(threadId)
  }

  /**
   * Which copy of an account is held now. It changes each time the account is forgotten, so an account that goes and
   * comes back under the same ID, as a host's copy can, is not taken for the one before. A card remembers the copy it
   * asked about, and its yes is for that copy alone.
   */
  generation(accountId: string): number {
    return this.generations.get(accountId) ?? 0
  }

  /**
   * Keeps the user's yes, and says whether it was kept. It holds for this run of Sotto even where the file could not
   * be written. A thread that is no longer open is given none, and neither is a yes that was asked for about another
   * copy of the account than the one held now (`generation`, as it stood when the card went up).
   */
  grant(threadId: string, accountId: string, generation?: number): Promise<boolean> {
    return this.inTurn(async () => {
      if (!this.isOpen(threadId)) return false
      if (generation !== undefined && this.generation(accountId) !== generation) return false
      const grants = await this.load()
      if (grants.some(grant => grant.threadId === threadId && grant.accountId === accountId)) return true
      await this.keep([...grants, { threadId, accountId, at: (this.options.now?.() ?? new Date()).toISOString() }].slice(-GRANTS_MAX))
      return true
    })
  }

  /**
   * The user's Stop: the thread asks again before it next reads the account. False when the file could not be
   * written; the grant then stands, so what the user is told is true after a restart too.
   */
  stop(threadId: string, accountId: string): Promise<boolean> {
    return this.inTurn(async () => {
      const grants = await this.load()
      const next = grants.filter(grant => grant.threadId !== threadId || grant.accountId !== accountId)
      // A grant already gone from here may still be in a file that could not be written then, so the file is
      // written before this says the grant has ended.
      if (next.length === grants.length && !this.behind) return true
      try { await this.write(next) } catch { return false }
      return true
    })
  }

  /** Deleted threads take their grants with them. */
  forgetThreads(threadIds: readonly string[]): Promise<void> {
    const gone = new Set(threadIds)
    return this.drop(grant => gone.has(grant.threadId))
  }

  /**
   * A removed account takes its grants with it, at once: a read that asked whether it may before this was called,
   * and is answered after, is told no. On a host a copy that is let go can be sent again under the same ID a moment
   * later, and a read that began for the old one must not go by its grant.
   */
  forgetAccount(accountId: string): Promise<void> {
    this.forgetting.set(accountId, (this.forgetting.get(accountId) ?? 0) + 1)
    // A card that is up for this account asked about the copy before: its yes is no longer for what is held.
    this.generations.set(accountId, this.generation(accountId) + 1)
    return this.drop(grant => grant.accountId === accountId).finally(() => {
      const left = (this.forgetting.get(accountId) ?? 1) - 1
      if (left > 0) this.forgetting.set(accountId, left); else this.forgetting.delete(accountId)
    })
  }

  list(): Promise<MailGrant[]> {
    return this.inTurn(async () => [...await this.load()])
  }

  /**
   * Told that some thread may have changed, which the coordinator's every publication is. With no grant held this
   * costs a comparison. With some, the grants look at their threads a moment later, and no more often than that: a
   * settled thread's grant ends, so a thread reopened later asks again.
   */
  noticed(): void {
    if (this.closed || this.timer || (this.grants !== undefined && this.grants.length === 0 && !this.behind)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.endClosed().catch(() => undefined)
    }, this.options.checkEveryMs ?? CHECK_EVERY_MS)
    this.timer.unref?.()
  }

  /** Ends the grants of threads that are no longer open, and writes the file where it is behind. */
  endClosed(): Promise<void> {
    return this.inTurn(async () => {
      const grants = await this.load()
      const open = grants.filter(grant => this.isOpen(grant.threadId))
      if (open.length !== grants.length || this.behind) await this.keep(open)
    })
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** A thread that cannot be read is not taken for open. */
  private isOpen(threadId: string): boolean {
    try { return this.options.open(threadId) } catch { return false }
  }

  private drop(gone: (grant: MailGrant) => boolean): Promise<void> {
    return this.inTurn(async () => {
      const grants = await this.load()
      const next = grants.filter(grant => !gone(grant))
      if (next.length !== grants.length) await this.keep(next)
    })
  }

  /** Takes the grants as they now are, and writes them. A write that fails is tried again when threads next change. */
  private async keep(grants: MailGrant[]): Promise<void> {
    this.grants = grants
    try { await this.write(grants) } catch { this.behind = true }
  }

  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const run = this.queue.catch(() => undefined).then(change)
    this.queue = run
    return run
  }

  private async load(): Promise<MailGrant[]> {
    if (this.grants) return this.grants
    let grants: MailGrant[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      if (parsed.success) grants = parsed.data.grants.flatMap(entry => { const grant = grantSchema.safeParse(entry); return grant.success ? [grant.data] : [] })
    } catch { /* No file, or one that cannot be read: no grants, and every thread asks again. */ }
    this.grants = grants
    return grants
  }

  private async write(grants: MailGrant[]): Promise<void> {
    const next = `${this.path}.next`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, grants }), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
    this.grants = grants
    this.behind = false
  }
}

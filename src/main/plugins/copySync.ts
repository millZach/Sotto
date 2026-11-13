import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { HeldPluginAccountCopy, PluginAccountCopy, PluginAccountCopyReceipt, PluginAccountCopyRemoved } from '../../shared/pluginAccountCopies'
import type { PluginAccount, PluginAccountCopyState, PluginCopiesView } from '../../shared/plugins'
import { PluginSecretLocked } from './accounts'

/** A connected host as the copies reach it: its identity, and the three requests where it lists `plugin-account-copies`. */
export interface CopyTarget {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsPluginAccountCopies?: boolean | undefined
    keepPluginAccountCopy?(copy: PluginAccountCopy): Promise<PluginAccountCopyReceipt>
    removePluginAccountCopy?(accountId: string): Promise<PluginAccountCopyRemoved>
    pluginAccountCopies?(): Promise<HeldPluginAccountCopy[]>
  }
}
/** A computer the user paired as a host, as this computer saved it: its own ID here, its name, and the host's identity once it has connected. */
export interface CopyComputer { readonly id: string; readonly name: string; readonly hostId?: string | undefined; readonly connected: boolean }
export type CopySyncEvent = 'plugin-account-copies-reconciled' | 'plugin-account-copies-failed' | 'plugin-account-copy-choices-not-saved'

const choicesSchema = z.object({
  version: z.literal(1), copyNew: z.boolean(),
  /** Each account's choice for each computer, by the computer's ID here. One not listed yet follows `copyNew` when it is first met. */
  choices: z.record(z.uuid(), z.record(z.string().min(1).max(512), z.boolean())),
}).strict()
type Choices = z.infer<typeof choicesSchema>

const RETRY_AFTER_MS = 2_000
const RETRY_AFTER_MAX_MS = 60_000

const sameProjects = (one: readonly string[] | null | undefined, other: readonly string[] | null): boolean =>
  one === other || (!!one && !!other && one.length === other.length && one.every((id, index) => id === other[index]))
/**
 * Whether an account may have a copy anywhere else. One kept to chosen projects may not (Zach, November 12, 2026): a
 * project is a folder on this computer, which another computer does not have, so its secret stays here.
 */
const mayBeCopied = (account: PluginAccount): boolean => account.projects === null
/** Whether a host holds an account as it is here. A host that does not say what it holds of it is not taken to. */
const holdsAsHere = (held: HeldPluginAccountCopy, account: PluginAccount): boolean =>
  held.savedAt === account.savedAt && held.name === account.name && held.signedInAs === account.signedInAs && held.on === account.on && held.projects !== undefined && sameProjects(held.projects, account.projects)

/**
 * Sends account copies (ADR-0205, amending ADR-0025): each plugin account the user chose to keep on a paired host, to
 * that host, over the connection this desktop holds to it. A copy lets the host's threads use the account while this
 * computer is off.
 *
 * It works by making each host agree with this computer whenever the two meet. On every connection, and whenever an
 * account or a choice changes here, it asks the host which of this desktop's copies it holds, sends each wanted account
 * the host lacks or holds differently, and tells it to let go of each one that is no longer wanted. So a removal made
 * while a host was away reaches it when it next connects, without a list of removals to keep.
 *
 * A secret is read from the credential store only to be sent, to a host that lists `plugin-account-copies` and no
 * other, and is never logged: what happened is said in stable event names. Nothing here reads a secret back.
 */
export class PluginAccountCopySync {
  private readonly path: string
  private kept: Choices | undefined
  private writing: Promise<unknown> = Promise.resolve()
  /** What each connected host answered for each account, by the host's identity. */
  private readonly states = new Map<string, Map<string, PluginAccountCopyState>>()
  private readonly reconciling = new Map<string, Promise<void>>()
  /** Hosts to look at again once the look under way ends: something changed while it ran. */
  private readonly again = new Set<string>()
  private readonly retries = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly failures: number }>()
  /** Hosts that connected before this computer had saved them, as a host being added does: looked at once they are saved. */
  private readonly unsaved = new Set<string>()
  private closed = false

  constructor(directory: string, private readonly options: {
    readonly accounts: { list(): Promise<readonly PluginAccount[]>; secret(id: string): string }
    /** The computers saved as hosts, read in place. */
    readonly computers: () => readonly CopyComputer[]
    /** The remote hosts connected now, read in place. */
    readonly connections: () => Iterable<CopyTarget>
    /** Told when what the page shows of copies may have changed. */
    readonly changed?: () => void
    readonly log?: (event: CopySyncEvent) => void
    readonly retryAfterMs?: number
  }) {
    this.path = join(directory, 'plugin-account-copy-choices.json')
  }

  /** A host connected, new or again: it is made to agree with this computer. */
  connected(target: CopyTarget): void { this.reconcile(target) }

  /** An account was added, changed or removed here: every connected host is made to agree again. */
  accountsChanged(): void {
    for (const target of this.options.connections()) this.reconcile(target)
    this.options.changed?.()
  }

  /**
   * The saved hosts changed: one connected or left, or a host just added was saved. A host is handed its connection
   * a moment before it is saved, so one that was not saved when it connected is looked at now.
   */
  computersChanged(): void {
    if (this.unsaved.size > 0) {
      const saved = this.options.computers()
      for (const target of this.options.connections()) {
        if (!this.unsaved.has(target.hostId) || !saved.some(computer => computer.hostId === target.hostId)) continue
        this.unsaved.delete(target.hostId)
        this.reconcile(target)
      }
    }
    this.options.changed?.()
  }

  /** Whether a new account, or a newly paired computer, starts with a copy. */
  async setCopyNew(copyNew: boolean): Promise<void> {
    await this.save({ ...await this.choices(), copyNew })
    this.options.changed?.()
  }

  /** The user's choice for one account on one computer. Off, the host is told to let its copy go. */
  async setCopy(accountId: string, computerId: string, on: boolean): Promise<void> {
    const choices = await this.choices()
    await this.save({ ...choices, choices: { ...choices.choices, [accountId]: { ...choices.choices[accountId], [computerId]: on } } })
    this.accountsChanged()
  }

  /** What Settings › Plugins shows: the computers, the default for new copies, and where each account's copy stands. */
  async view(): Promise<PluginCopiesView> {
    const computers = this.options.computers()
    const accounts = await this.options.accounts.list()
    const choices = await this.settled(accounts, computers)
    return {
      copyNew: choices.copyNew,
      computers: computers.map(computer => ({ id: computer.id, name: computer.name, connected: computer.connected })),
      copies: accounts.flatMap(account => computers.map(computer => {
        const wanted = choices.choices[account.id]?.[computer.id] ?? choices.copyNew
        // A copy that is wanted waits until its host has answered for it: away, or connected and being asked.
        const state: PluginAccountCopyState = !mayBeCopied(account) ? 'here-only' : !wanted ? 'off' : !computer.connected || !computer.hostId ? 'waiting' : this.states.get(computer.hostId)?.get(account.id) ?? 'waiting'
        return { accountId: account.id, computerId: computer.id, state }
      })),
    }
  }

  close(): void {
    this.closed = true
    for (const retry of this.retries.values()) clearTimeout(retry.timer)
    this.retries.clear()
  }

  /** Settles once every look at a host started so far has ended; for tests and for closing. */
  async idle(): Promise<void> {
    while (this.reconciling.size > 0) await Promise.allSettled([...this.reconciling.values()])
    await this.writing.catch(() => undefined)
  }

  /** One look at a host at a time. A change that arrives while one runs is seen by another look straight after it. */
  private reconcile(target: CopyTarget): void {
    if (this.closed || target.kind !== 'remote') return
    if (this.reconciling.has(target.hostId)) { this.again.add(target.hostId); return }
    const run = this.agree(target).then(() => { this.options.log?.('plugin-account-copies-reconciled'); this.clearRetry(target.hostId) }, () => {
      this.options.log?.('plugin-account-copies-failed')
      this.retry(target.hostId)
    }).finally(() => {
      this.reconciling.delete(target.hostId)
      this.options.changed?.()
      if (!this.again.delete(target.hostId)) return
      // The host as it is connected now, which may be a newer connection than the one this look used.
      for (const current of this.options.connections()) if (current.hostId === target.hostId) { this.reconcile(current); return }
    })
    this.reconciling.set(target.hostId, run)
  }

  private async agree(target: CopyTarget): Promise<void> {
    const computer = this.options.computers().find(entry => entry.hostId === target.hostId)
    // A host this computer has not saved is not one of the user's own paired hosts to copy to. One being added is
    // saved a moment after it connects, and is looked at then.
    if (!computer) { this.unsaved.add(target.hostId); return }
    this.unsaved.delete(target.hostId)
    const accounts = await this.options.accounts.list()
    const choices = await this.settled(accounts, this.options.computers())
    const wanted = accounts.filter(account => mayBeCopied(account) && (choices.choices[account.id]?.[computer.id] ?? choices.copyNew))
    const states = new Map<string, PluginAccountCopyState>()
    this.states.set(target.hostId, states)
    const { service } = target
    // An older or stable host lists no such feature, and is asked nothing and sent nothing.
    if (service.supportsPluginAccountCopies !== true || !service.pluginAccountCopies || !service.keepPluginAccountCopy || !service.removePluginAccountCopy) {
      for (const account of wanted) states.set(account.id, 'too-old')
      return
    }
    const held = await service.pluginAccountCopies()
    let failed = false
    for (const account of wanted) {
      const there = held.find(copy => copy.id === account.id)
      if (there && holdsAsHere(there, account)) { states.set(account.id, 'kept'); continue }
      let secret: string
      try { secret = this.options.accounts.secret(account.id) } catch (error) { states.set(account.id, error instanceof PluginSecretLocked ? 'locked' : 'failed'); failed = true; continue }
      // An account whose secret is gone here is not an account any longer, and nothing of it is sent.
      if (!secret) { states.set(account.id, 'failed'); continue }
      try {
        const receipt = await service.keepPluginAccountCopy({ account: { ...account }, secret })
        states.set(account.id, receipt.kept ? 'kept' : receipt.problem === 'store' ? 'no-key' : receipt.problem === 'limit' ? 'full' : receipt.problem)
      } catch { states.set(account.id, 'failed'); failed = true }
    }
    // What the host holds of this desktop's and is no longer wanted: an account removed here, a copy switched off, or
    // an account since kept to chosen projects.
    for (const copy of held) {
      if (wanted.some(account => account.id === copy.id)) continue
      try { await service.removePluginAccountCopy(copy.id) } catch { failed = true }
    }
    if (failed) throw new Error('PLUGIN_ACCOUNT_COPIES_NOT_AGREED')
  }

  /** After a look that failed, the host is looked at again later if it is still connected then, as things stand then. */
  private retry(hostId: string): void {
    if (this.closed) return
    const failures = (this.retries.get(hostId)?.failures ?? 0) + 1
    this.clearRetry(hostId)
    const wait = Math.min(RETRY_AFTER_MAX_MS, (this.options.retryAfterMs ?? RETRY_AFTER_MS) * 2 ** (failures - 1))
    const timer = setTimeout(() => {
      if (this.retries.get(hostId)?.timer !== timer || this.closed) return
      for (const target of this.options.connections()) if (target.hostId === hostId) { this.reconcile(target); return }
      // Not connected now: its next connection looks at it.
      this.retries.delete(hostId)
    }, wait)
    timer.unref?.()
    this.retries.set(hostId, { timer, failures })
  }
  private clearRetry(hostId: string): void {
    const retry = this.retries.get(hostId)
    if (retry) clearTimeout(retry.timer)
    this.retries.delete(hostId)
  }

  /**
   * The choices, with each account's choice for each computer written down the first time the two are met: it follows
   * the default as it stood then, so turning the default off later stops no copy already made, and turning it on later
   * starts none the user did not ask for. Choices for accounts that are gone are dropped.
   */
  private async settled(accounts: readonly PluginAccount[], computers: readonly CopyComputer[]): Promise<Choices> {
    const choices = await this.choices()
    const next: Record<string, Record<string, boolean>> = {}
    let changed = Object.keys(choices.choices).some(id => !accounts.some(account => account.id === id))
    for (const account of accounts) {
      const mine = { ...choices.choices[account.id] }
      for (const computer of computers) if (mine[computer.id] === undefined) { mine[computer.id] = choices.copyNew; changed = true }
      next[account.id] = mine
    }
    if (!changed) return choices
    const settled = { ...choices, choices: next }
    // A choice that could not be written down is still followed for now, and is settled again next time.
    await this.save(settled).catch(() => this.options.log?.('plugin-account-copy-choices-not-saved'))
    return this.kept ?? settled
  }

  /** Only a file that is not there yet means nothing was chosen. One that cannot be read copies nothing, rather than everything. */
  private async choices(): Promise<Choices> {
    if (this.kept) return this.kept
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.kept = { version: 1, copyNew: true, choices: {} })
      throw error
    }
    return (this.kept = choicesSchema.parse(JSON.parse(text)))
  }

  private save(choices: Choices): Promise<void> {
    const run = this.writing.catch(() => undefined).then(async () => {
      const next = `${this.path}.next`
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(next, JSON.stringify(choices), { mode: 0o600 })
        await rename(next, this.path)
      } catch (error) {
        await rm(next, { force: true })
        throw error
      }
      this.kept = choices
    })
    this.writing = run
    return run
  }
}

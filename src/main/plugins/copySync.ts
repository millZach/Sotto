import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { HeldPluginAccountCopy, PluginAccountCopy, PluginAccountCopyReceipt, PluginAccountCopyRemoved } from '../../shared/pluginAccountCopies'
import type { PluginAccount, PluginAccountCopyLeaving, PluginAccountCopyState, PluginCopiesView } from '../../shared/plugins'
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
/** Whether the user's choices ask for a copy of an account on a computer. */
const chosen = (choices: Choices, accountId: string, computerId: string): boolean => choices.choices[accountId]?.[computerId] ?? choices.copyNew
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
  /**
   * What each host last answered for each account whose copy is wanted, by the host's identity. Emptied when the host
   * connects again, for what it holds may have changed while it was away.
   */
  private readonly states = new Map<string, Map<string, PluginAccountCopyState>>()
  /**
   * What each host is known to hold of an account whose copy is not wanted. `gone`: it did not list the account, or
   * answered its removal. `there`: it listed it and has not answered its removal. `cannot`: it keeps no account copies
   * now, so it can say nothing of one it was sent before. An account not here is one the host has not been asked of.
   */
  private readonly unwanted = new Map<string, Map<string, 'gone' | 'there' | 'cannot'>>()
  private readonly reconciling = new Map<string, Promise<void>>()
  /** Hosts to look at again once the look under way ends: something changed while it ran. */
  private readonly again = new Set<string>()
  private readonly retries = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly failures: number }>()
  /** Hosts that connected before this computer had saved them, as a host being added does: looked at once they are saved. */
  private readonly unsaved = new Set<string>()
  /**
   * Counts every change to an account or a choice, as it is asked for. A look at a host that began before the newest
   * one sends no secret: what it read may no longer be what the user wants, and a copy sent cannot be unsent.
   */
  private revision = 0
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

  /** A host connected, new or again: it is made to agree with this computer. What it answered before is forgotten. */
  connected(target: CopyTarget): void {
    this.states.delete(target.hostId)
    this.unwanted.delete(target.hostId)
    this.reconcile(target)
  }

  /** An account was added, changed or removed here: every connected host is made to agree again. */
  accountsChanged(): void {
    this.revision += 1
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
    await this.change(choices => ({ ...choices, copyNew }))
    this.options.changed?.()
  }

  /** The user's choice for one account on one computer. Off, the host is told to let its copy go. */
  async setCopy(accountId: string, computerId: string, on: boolean): Promise<void> {
    // Counted before it is written down: a look at a host that is under way must not send what this may be stopping.
    this.revision += 1
    // Every host is looked at again whether or not the choice could be written down: a look this stopped part way
    // must not be the last one, or what it left unsent would stay unsent.
    try { await this.change(choices => ({ ...choices, choices: { ...choices.choices, [accountId]: { ...choices.choices[accountId], [computerId]: on } } })) } finally { this.accountsChanged() }
  }

  /** What Settings › Plugins shows: the computers, the default for new copies, and where each account's copy stands. */
  async view(): Promise<PluginCopiesView> {
    const computers = this.options.computers()
    const accounts = await this.options.accounts.list()
    // Choices that cannot be read are said to be so. The page still shows what each computer is known to hold.
    const choices = await this.settled(accounts, computers).catch(() => undefined)
    return {
      copyNew: choices?.copyNew ?? false, readable: choices !== undefined,
      computers: computers.map(computer => ({ id: computer.id, name: computer.name, connected: computer.connected })),
      copies: accounts.flatMap(account => computers.map(computer => {
        const answered = computer.hostId ? this.states.get(computer.hostId)?.get(account.id) : undefined
        // Without the choices nothing is sent and nothing of this account is taken back: what the computer last said.
        if (mayBeCopied(account) && !choices) return { accountId: account.id, computerId: computer.id, state: computer.connected && answered === 'kept' ? 'kept' as const : 'no-record' as const, leaving: 'no' as const }
        if (mayBeCopied(account) && chosen(choices!, account.id, computer.id)) {
          // A copy that is wanted waits until its host has answered for it: away, or connected and being asked.
          const state: PluginAccountCopyState = !computer.connected || answered === undefined ? 'waiting' : answered
          return { accountId: account.id, computerId: computer.id, state, leaving: 'no' as const }
        }
        // No copy is wanted. Whether the host holds none is the host's to say. One that has never connected holds
        // nothing of this computer's. One that is away is told when it is back. One that is here is being told to let
        // go of a copy it is known to hold, was last seen keeping or has listed; otherwise it is still being asked.
        const known = computer.hostId ? this.unwanted.get(computer.hostId)?.get(account.id) : undefined
        const leaving: PluginAccountCopyLeaving = !computer.hostId || known === 'gone' ? 'no' : !computer.connected ? 'away'
          : known === 'cannot' ? 'cannot' : known === 'there' || answered === 'kept' ? 'now' : 'asking'
        return { accountId: account.id, computerId: computer.id, state: mayBeCopied(account) ? 'off' as const : 'here-only' as const, leaving }
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
    // What this look reads is what the user wanted when it began. Every change since is counted, and seen below.
    const revision = this.revision
    const accounts = await this.options.accounts.list()
    // Choices that cannot be read, as a file a newer Sotto wrote cannot, send nothing. They must not stop a copy being
    // taken back: an account removed here, or kept to chosen projects, has no copy whatever the choices say.
    let choices: Choices | undefined
    let unreadable: unknown
    try { choices = await this.settled(accounts, this.options.computers()) } catch (error) { unreadable = error }
    const read = choices
    const wanted = read ? accounts.filter(account => mayBeCopied(account) && chosen(read, account.id, computer.id)) : []
    /** Without the choices, the copy of an account that may be copied is neither sent nor taken back. */
    const unsure = read ? [] : accounts.filter(mayBeCopied)
    let states = this.states.get(target.hostId)
    if (!states) { states = new Map(); this.states.set(target.hostId, states) }
    let unwanted = this.unwanted.get(target.hostId)
    if (!unwanted) { unwanted = new Map(); this.unwanted.set(target.hostId, unwanted) }
    for (const known of [states, unwanted]) for (const id of known.keys()) if (!accounts.some(account => account.id === id)) known.delete(id)
    const { service } = target
    // An older or stable host lists no such feature, and is asked nothing and sent nothing. It cannot say what it
    // holds either: a host that kept copies and now runs a build that does not still has what it was sent.
    if (service.supportsPluginAccountCopies !== true || !service.pluginAccountCopies || !service.keepPluginAccountCopy || !service.removePluginAccountCopy) {
      for (const account of accounts) {
        states.delete(account.id); unwanted.delete(account.id)
        if (wanted.includes(account)) states.set(account.id, 'too-old'); else if (!unsure.includes(account)) unwanted.set(account.id, 'cannot')
      }
      if (unreadable) throw unreadable
      return
    }
    let held: HeldPluginAccountCopy[]
    // A host that does not answer, or will not answer this desktop, is not known to hold what it was last seen to: a
    // wanted copy is said not to have been sent, and is tried again.
    try { held = await service.pluginAccountCopies() } catch (error) { for (const account of wanted) states.set(account.id, 'failed'); throw error }
    let failed = false
    // First, what the host holds of this desktop's and is no longer wanted: an account removed here, a copy switched
    // off, or an account since kept to chosen projects. It goes before anything is sent, so a host holding as many
    // accounts as a plugin takes has room for the copy that replaces one. Taking a copy back is always safe: one asked
    // for again while this look ran is sent by the look that change asked for. An account is marked as having no copy
    // there only once the host has said so, by not listing it or by answering its removal.
    const stillThere = new Set<string>()
    for (const copy of held) {
      if (wanted.some(account => account.id === copy.id) || unsure.some(account => account.id === copy.id)) continue
      try { await service.removePluginAccountCopy(copy.id) } catch { stillThere.add(copy.id); failed = true }
    }
    for (const account of accounts) {
      if (wanted.includes(account)) continue
      states.delete(account.id); unwanted.delete(account.id)
      if (!unsure.includes(account)) unwanted.set(account.id, stillThere.has(account.id) ? 'there' : 'gone')
      else if (held.some(copy => copy.id === account.id)) states.set(account.id, 'kept')
    }
    for (const account of wanted) {
      unwanted.delete(account.id)
      const there = held.find(copy => copy.id === account.id)
      if (there && holdsAsHere(there, account)) { states.set(account.id, 'kept'); continue }
      // The account is read again, and nothing may have been asked for since this look began: an account narrowed or
      // a copy switched off while the host was answering is not sent, for a copy sent cannot be unsent. The change
      // that stopped it has already asked for another look, which sends what is still wanted. Nothing below waits
      // between this check and the send.
      const now = (await this.options.accounts.list()).find(entry => entry.id === account.id)
      if (this.revision !== revision || !now || !mayBeCopied(now)) return
      states.set(account.id, 'waiting')
      let secret: string
      try { secret = this.options.accounts.secret(account.id) } catch (error) { states.set(account.id, error instanceof PluginSecretLocked ? 'locked' : 'failed'); failed = true; continue }
      // An account whose secret is gone here is not an account any longer, and nothing of it is sent.
      if (!secret) { states.set(account.id, 'failed'); continue }
      try {
        const receipt = await service.keepPluginAccountCopy({ account: { ...now }, secret })
        states.set(account.id, receipt.kept ? 'kept' : receipt.problem === 'store' ? 'no-key' : receipt.problem === 'limit' ? 'full' : receipt.problem)
      } catch { states.set(account.id, 'failed'); failed = true }
    }
    // The choices are still unreadable: said so, and looked at again later.
    if (unreadable) throw unreadable
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
    const settle = (choices: Choices): Choices | null => {
      const next: Record<string, Record<string, boolean>> = {}
      let changed = Object.keys(choices.choices).some(id => !accounts.some(account => account.id === id))
      for (const account of accounts) {
        const mine = { ...choices.choices[account.id] }
        for (const computer of computers) if (mine[computer.id] === undefined) { mine[computer.id] = choices.copyNew; changed = true }
        next[account.id] = mine
      }
      return changed ? { ...choices, choices: next } : null
    }
    // A choice being written down is waited for: one that stops a copy is counted before it is written, and a look
    // that began after the count must not read the choices as they stood before it.
    await this.writing.catch(() => undefined)
    // Choices that cannot be read copy nothing, and say so by failing here.
    const read = await this.choices()
    if (!settle(read)) return read
    try { return await this.change(settle) } catch {
      // A choice that could not be written down is still followed for now, and is settled again next time.
      this.options.log?.('plugin-account-copy-choices-not-saved')
      const choices = await this.choices()
      return settle(choices) ?? choices
    }
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

  /**
   * One change to the choices at a time, each worked out from the choices as the change before it left them. Two
   * choices made a moment apart would otherwise both start from the same file, and the second would undo the first.
   * A change that changes nothing writes nothing.
   */
  private change(next: (choices: Choices) => Choices | null): Promise<Choices> {
    const run = this.writing.catch(() => undefined).then(async () => {
      const choices = await this.choices()
      const changed = next(choices)
      if (!changed) return choices
      const file = `${this.path}.next`
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(file, JSON.stringify(changed), { mode: 0o600 })
        await rename(file, this.path)
      } catch (error) {
        await rm(file, { force: true })
        throw error
      }
      this.kept = changed
      return changed
    })
    this.writing = run
    return run
  }
}

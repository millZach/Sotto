import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  PLUGIN_ACCOUNTS_MAX, pluginAccountSchema, type AccountPluginId, type PluginAccount, type PluginAccountAdd, type PluginAccountProblem,
  type PluginAccountRemove, type PluginAccountReplace, type PluginAccountResult, type PluginAccountUpdate,
} from '../../shared/plugins'

const fileSchema = z.object({ version: z.literal(1), accounts: z.array(z.unknown()) })

/** The part of the credential store plugin accounts use: this computer's, or a headless host's own. */
export interface PluginCredentials {
  has(slot: string): boolean
  /** The secret in a slot, or an empty string. Throws while the credential store cannot be read. */
  get(slot: string): string
  /** Keeps a secret in a slot; an empty value removes it. */
  set(slot: string, value: string): Promise<void>
}

/** What a service said of a secret it was asked about: good, with its own name for the account, refused, or not asked. */
export type SecretCheck = { readonly ok: true; readonly signedInAs: string | null } | { readonly ok: false; readonly problem: 'refused' | 'unreachable' | 'busy' }

/** The credential store could not hand over a secret it holds: it is locked, or cannot be read right now. */
export class PluginSecretLocked extends Error {}
/** The record of accounts could not be read. Nothing is changed while that is so, so no account is written over. */
export class PluginAccountsUnreadable extends Error {}

/** The slot an account's secret is kept in: one each, named by Sotto's own ID for the account. */
export const pluginAccountSlot = (id: string): string => `plugin:${id}`

/**
 * Plugin accounts (ADR-0205, decision 3): each is a name the user gave, the plugin it signs in to, and a secret in the
 * credential store in a slot of its own. The record of accounts is one small file in Sotto's data folder and never
 * holds a secret; nothing here hands one to a window, a log or an agent. A secret is checked with its service before
 * it is kept, and a secret that cannot be kept leaves no account behind. Changes run whole, one after another, and each
 * is ordered so that what the user is told is true whichever write fails: a refused change leaves the secret in use
 * as it was, and a removed account never keeps a secret.
 */
export class PluginAccounts {
  private readonly path: string
  private accounts: PluginAccount[] | undefined
  private queue: Promise<unknown> = Promise.resolve()
  constructor(directory: string, private readonly options: {
    readonly credentials: PluginCredentials
    /** Asks a plugin's service whether a secret is good. */
    readonly check: (plugin: AccountPluginId, secret: string) => Promise<SecretCheck>
    readonly now?: () => Date
  }) {
    this.path = join(directory, 'plugin-accounts.json')
  }

  /** The accounts, in the order they were added. */
  list(): Promise<PluginAccount[]> {
    return this.inTurn(async () => [...await this.load()])
  }

  /**
   * The account a thread's agent named, by plugin and name, or the plugin's only account when it names none. With
   * `admits`, only the accounts the asking thread may use are looked among (decision 9), as if the others were not
   * there: `withheld` says the plugin has accounts and none of them is for this thread.
   */
  async find(plugin: AccountPluginId, name: string | undefined, admits?: (account: PluginAccount) => boolean): Promise<PluginAccount | 'none' | 'withheld' | 'ambiguous' | 'unknown'> {
    const all = (await this.list()).filter(account => account.plugin === plugin)
    const mine = admits ? all.filter(admits) : all
    if (mine.length === 0) return all.length === 0 ? 'none' : 'withheld'
    if (name === undefined) return mine.length === 1 ? mine[0]! : 'ambiguous'
    return mine.find(account => sameName(account.name, name)) ?? 'unknown'
  }

  /**
   * An account's secret, for the adapter that makes its calls. Empty when the account holds none. A secret that is
   * there but cannot be read, as when the credential store is locked, is not the same thing and throws.
   */
  secret(id: string): string {
    const slot = pluginAccountSlot(id)
    if (!this.options.credentials.has(slot)) return ''
    try { return this.options.credentials.get(slot) } catch { throw new PluginSecretLocked() }
  }

  add(request: PluginAccountAdd): Promise<PluginAccountResult> {
    return this.inTurn(async () => {
      const accounts = await this.loadOrNull()
      if (!accounts) return refusal('store')
      const mine = accounts.filter(account => account.plugin === request.plugin)
      if (mine.some(account => sameName(account.name, request.name))) return refusal('name-taken')
      if (mine.length >= PLUGIN_ACCOUNTS_MAX) return refusal('limit')
      const checked = await this.options.check(request.plugin, request.secret)
      if (!checked.ok) return refusal(checked.problem)
      const account: PluginAccount = { id: randomUUID(), plugin: request.plugin, name: request.name, savedAt: this.now(), signedInAs: checked.signedInAs, on: true, projects: null }
      const slot = pluginAccountSlot(account.id)
      try {
        await this.options.credentials.set(slot, request.secret)
        await this.write([...accounts, account])
      } catch {
        // A secret with no account to find it by is not left behind.
        await this.options.credentials.set(slot, '').catch(() => undefined)
        return refusal('store')
      }
      return { ok: true, accounts: [...accounts, account] }
    })
  }

  replace(request: PluginAccountReplace): Promise<PluginAccountResult> {
    return this.inTurn(async () => {
      const accounts = await this.loadOrNull()
      if (!accounts) return refusal('store')
      const account = accounts.find(entry => entry.id === request.id)
      if (!account) return refusal('gone')
      const checked = await this.options.check(account.plugin, request.secret)
      if (!checked.ok) return refusal(checked.problem)
      const next = accounts.map(entry => entry.id === account.id ? { ...entry, savedAt: this.now(), signedInAs: checked.signedInAs } : entry)
      // The day and the name are written first and the secret last, so a refusal always means the saved secret is
      // still the one in use: a failed first write changed nothing, and a failed second leaves the old secret.
      try { await this.write(next) } catch { return refusal('store') }
      try { await this.options.credentials.set(pluginAccountSlot(account.id), request.secret) } catch {
        await this.write(accounts).catch(() => { this.accounts = accounts })
        return refusal('store')
      }
      return { ok: true, accounts: next }
    })
  }

  /**
   * Deletes the secret first: until that is done nothing has changed, and once it is done the account is gone,
   * whether or not the record of accounts could be written, since an account without its secret is never listed.
   */
  remove(request: PluginAccountRemove): Promise<PluginAccountResult> {
    return this.inTurn(async () => {
      const accounts = await this.loadOrNull()
      if (!accounts) return refusal('store')
      if (!accounts.some(entry => entry.id === request.id)) return refusal('gone')
      const next = accounts.filter(entry => entry.id !== request.id)
      try { await this.options.credentials.set(pluginAccountSlot(request.id), '') } catch { return refusal('store') }
      await this.write(next).catch(() => { this.accounts = next })
      return { ok: true, accounts: next }
    })
  }

  /**
   * Changes which threads may use an account: its switch, the projects it is kept to, or both. Only the record of
   * accounts is written; the secret is not touched. A change that cannot be written changes nothing.
   */
  update(request: PluginAccountUpdate): Promise<PluginAccountResult> {
    return this.inTurn(async () => {
      const accounts = await this.loadOrNull()
      if (!accounts) return refusal('store')
      if (!accounts.some(entry => entry.id === request.id)) return refusal('gone')
      const next = accounts.map(entry => entry.id !== request.id ? entry : {
        ...entry, ...(request.on === undefined ? {} : { on: request.on }),
        // Each project once, in the order given.
        ...(request.projects === undefined ? {} : { projects: request.projects === null ? null : [...new Set(request.projects)] }),
      })
      try { await this.write(next) } catch { return refusal('store') }
      return { ok: true, accounts: next }
    })
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }

  /** Runs one change after every change before it, whether those succeeded or not. */
  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const run = this.queue.catch(() => undefined).then(change)
    this.queue = run
    return run
  }

  /** The accounts, or null while their record cannot be read. */
  private loadOrNull(): Promise<PluginAccount[] | null> { return this.load().catch(() => null) }

  /**
   * Reads the record of accounts once. Only a file that is not there yet means no accounts: one that cannot be read
   * or made sense of throws and is asked for again next time, so a passing failure is never taken for an empty
   * record and written over.
   */
  private async load(): Promise<PluginAccount[]> {
    if (this.accounts) return this.accounts
    let accounts: PluginAccount[] = []
    let text: string | null
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PluginAccountsUnreadable()
      text = null
    }
    if (text !== null) {
      let parsed: ReturnType<typeof fileSchema.safeParse>
      try { parsed = fileSchema.safeParse(JSON.parse(text)) } catch { throw new PluginAccountsUnreadable() }
      if (!parsed.success) throw new PluginAccountsUnreadable()
      accounts = parsed.data.accounts.flatMap(entry => { const account = pluginAccountSchema.safeParse(entry); return account.success ? [account.data] : [] })
    }
    // An account whose secret is gone cannot be used and is not shown as saved.
    this.accounts = accounts.filter(account => this.options.credentials.has(pluginAccountSlot(account.id)))
    return this.accounts
  }

  /** Writes the accounts whole and only then takes them as kept, so a failed write leaves what was kept as it was. */
  private async write(accounts: PluginAccount[]): Promise<void> {
    const next = `${this.path}.next`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, accounts }), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
    this.accounts = accounts
  }
}

const refusal = (problem: PluginAccountProblem): PluginAccountResult => ({ ok: false, problem })
/** Names are told apart the way a person reads them: without regard to case or the spaces around them. */
const sameName = (one: string, other: string): boolean => one.trim().toLocaleLowerCase() === other.trim().toLocaleLowerCase()

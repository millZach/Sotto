import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  PLUGIN_ACCOUNTS_MAX, pluginAccountSchema, type AccountPluginId, type PluginAccount, type PluginAccountAdd, type PluginAccountProblem,
  type PluginAccountRemove, type PluginAccountReplace, type PluginAccountResult,
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
export type SecretCheck = { readonly ok: true; readonly signedInAs: string | null } | { readonly ok: false; readonly problem: 'refused' | 'unreachable' }

/** The slot an account's secret is kept in: one each, named by Sotto's own ID for the account. */
export const pluginAccountSlot = (id: string): string => `plugin:${id}`

/**
 * Plugin accounts (ADR-0205, decision 3): each is a name the user gave, the plugin it signs in to, and a secret in the
 * credential store in a slot of its own. The record of accounts is one small file in Sotto's data folder and never
 * holds a secret; nothing here hands one to a window, a log or an agent. A secret is checked with its service before
 * it is kept, and a secret that cannot be kept leaves no account behind. Changes run whole, one after another.
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

  /** The account a thread's agent named, by plugin and name, or the plugin's only account when it names none. */
  async find(plugin: AccountPluginId, name: string | undefined): Promise<PluginAccount | 'none' | 'ambiguous' | 'unknown'> {
    const mine = (await this.list()).filter(account => account.plugin === plugin)
    if (mine.length === 0) return 'none'
    if (name === undefined) return mine.length === 1 ? mine[0]! : 'ambiguous'
    return mine.find(account => sameName(account.name, name)) ?? 'unknown'
  }

  /** An account's secret, for the adapter that makes its calls. Empty when it is gone or cannot be read. */
  secret(id: string): string {
    try { return this.options.credentials.get(pluginAccountSlot(id)) } catch { return '' }
  }

  add(request: PluginAccountAdd): Promise<PluginAccountResult> {
    return this.inTurn(async () => {
      const accounts = await this.load()
      const mine = accounts.filter(account => account.plugin === request.plugin)
      if (mine.some(account => sameName(account.name, request.name))) return refusal('name-taken')
      if (mine.length >= PLUGIN_ACCOUNTS_MAX) return refusal('limit')
      const checked = await this.options.check(request.plugin, request.secret)
      if (!checked.ok) return refusal(checked.problem)
      const account: PluginAccount = { id: randomUUID(), plugin: request.plugin, name: request.name, savedAt: this.now(), signedInAs: checked.signedInAs }
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
      const accounts = await this.load()
      const account = accounts.find(entry => entry.id === request.id)
      if (!account) return refusal('gone')
      const checked = await this.options.check(account.plugin, request.secret)
      if (!checked.ok) return refusal(checked.problem)
      const next = accounts.map(entry => entry.id === account.id ? { ...entry, savedAt: this.now(), signedInAs: checked.signedInAs } : entry)
      try {
        await this.options.credentials.set(pluginAccountSlot(account.id), request.secret)
        await this.write(next)
      } catch { return refusal('store') }
      return { ok: true, accounts: next }
    })
  }

  /** Deletes the secret first, so an account that could not be removed whole never keeps a secret nobody can see. */
  remove(request: PluginAccountRemove): Promise<PluginAccountResult> {
    return this.inTurn(async () => {
      const accounts = await this.load()
      if (!accounts.some(entry => entry.id === request.id)) return refusal('gone')
      const next = accounts.filter(entry => entry.id !== request.id)
      try {
        await this.options.credentials.set(pluginAccountSlot(request.id), '')
        await this.write(next)
      } catch { return refusal('store') }
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

  private async load(): Promise<PluginAccount[]> {
    if (this.accounts) return this.accounts
    let accounts: PluginAccount[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      if (parsed.success) accounts = parsed.data.accounts.flatMap(entry => { const account = pluginAccountSchema.safeParse(entry); return account.success ? [account.data] : [] })
    } catch { /* No file yet, or one that cannot be read: no accounts. */ }
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

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { DESKTOP_CLIENT_ID_MAX } from '../../shared/desktopClients'
import type { HeldPluginAccountCopy, PluginAccountCopy, PluginAccountCopyReceipt, PluginAccountCopyRemoved, PluginAccountCopyStore } from '../../shared/pluginAccountCopies'
import { PluginAccounts, type PluginCredentials } from './accounts'

/** Which desktop sent each copy, by the account's ID. Kept beside the record of accounts and never sent to anyone. */
const sendersSchema = z.object({ version: z.literal(1), senders: z.record(z.uuid(), z.string().min(1).max(DESKTOP_CLIENT_ID_MAX)) }).strict()
type Senders = Readonly<Record<string, string>>

/**
 * A headless host's account copies (ADR-0205, amending ADR-0025): the plugin accounts a desktop sent, each under that
 * desktop's own ID for it, with its secret in the host's encrypted credential file. They are kept as the host's own
 * plugin accounts are, in the same record and the same slots, so the host's threads use a copy as a desktop's threads
 * use an account.
 *
 * A copy belongs to the desktop that sent it. Only that desktop is told of it, may replace it or may let it go, and
 * when that desktop is revoked its copies and their secrets are deleted. A host may record more than one desktop, and
 * one of them cannot read which accounts another sent, put its own secret under another's account, or remove it.
 *
 * A secret comes in and never goes out: `list` hands back which accounts are held and the day each secret was saved,
 * and nothing here reads a secret back for a client. The desktop checked the secret with its service before it kept
 * it, so the host asks no service anything. A host started without a key file cannot keep a secret; it says `store`
 * and keeps nothing.
 */
export function hostPluginAccountCopies(directory: string, credentials: PluginCredentials, now: () => Date = () => new Date()): PluginAccountCopyStore {
  const accounts = new PluginAccounts(directory, {
    credentials,
    // A host adds no account of its own, so nothing is ever asked of a service from here.
    check: async () => ({ ok: false, problem: 'unreachable' }),
  })
  const path = join(directory, 'plugin-account-copy-senders.json')
  /** Only a file that is not there yet means no copies. One that cannot be read throws, so nobody is taken for a copy's sender by mistake. */
  const read = async (): Promise<Senders> => {
    let text: string
    try { text = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    return sendersSchema.parse(JSON.parse(text)).senders
  }
  const write = async (senders: Senders): Promise<void> => {
    const next = `${path}.next`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, senders }), { mode: 0o600 })
      await rename(next, path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
  }
  const without = (senders: Senders, ...ids: readonly string[]): Senders => Object.fromEntries(Object.entries(senders).filter(([id]) => !ids.includes(id)))
  /** Each change runs whole, after every change before it, so the accounts and who sent them are never read half changed. */
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <Result>(change: () => Promise<Result>): Promise<Result> => {
    const run = queue.catch(() => undefined).then(change)
    queue = run
    return run
  }
  return {
    keep: (copy: PluginAccountCopy, clientId: string): Promise<PluginAccountCopyReceipt> => inTurn(async () => {
      let senders: Senders
      try { senders = await read() } catch { return { kept: false, problem: 'store' } }
      const id = copy.account.id
      const sender = senders[id]
      // A new copy is put under its sender's name before it is kept, so there is never a copy nobody sent.
      if (sender === undefined) { try { await write({ ...senders, [id]: clientId }) } catch { return { kept: false, problem: 'store' } } }
      // An account is this desktop's to replace, or to take a name from, only when this desktop sent it.
      const kept = await accounts.adopt(copy.account, copy.secret, held => senders[held.id] === clientId)
      if (!kept.kept) {
        if (sender === undefined) await write(senders).catch(() => undefined)
        return { kept: false, problem: kept.problem }
      }
      // A stale copy of the same name, taken over by this one, is gone with its secret: nobody sent it any longer.
      if (kept.replaced) await write(without({ ...senders, [id]: clientId }, kept.replaced)).catch(() => undefined)
      return { kept: true, keptAt: now().toISOString() }
    }),
    remove: (id: string, clientId: string): Promise<PluginAccountCopyRemoved> => inTurn(async () => {
      const senders = await read()
      const held = (await accounts.list()).some(account => account.id === id)
      // A copy the host does not hold is already gone, which is what was asked for. Another desktop's is not this one's to remove.
      if (!held) return { removed: true }
      if (senders[id] !== clientId) return { removed: false }
      const result = await accounts.remove({ id })
      if (!result.ok && result.problem !== 'gone') throw new Error('PLUGIN_ACCOUNT_COPY_NOT_REMOVED')
      await write(without(senders, id)).catch(() => undefined)
      return { removed: true }
    }),
    list: (clientId: string): Promise<HeldPluginAccountCopy[]> => inTurn(async () => {
      const senders = await read()
      return (await accounts.list()).filter(account => senders[account.id] === clientId).map(account => ({ id: account.id, plugin: account.plugin, savedAt: account.savedAt }))
    }),
    forgetDesktop: (clientId: string): Promise<void> => inTurn(async () => {
      const senders = await read()
      const gone: string[] = []
      for (const [id, sender] of Object.entries(senders)) {
        if (sender !== clientId) continue
        const result = await accounts.remove({ id })
        // A copy whose secret could not be deleted keeps its sender, so the next revocation or removal finds it again.
        if (result.ok || result.problem === 'gone') gone.push(id)
      }
      if (gone.length > 0) await write(without(senders, ...gone))
    }),
  }
}

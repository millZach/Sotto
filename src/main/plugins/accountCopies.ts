import type { HeldPluginAccountCopy, PluginAccountCopy, PluginAccountCopyReceipt, PluginAccountCopyRemoved, PluginAccountCopyStore } from '../../shared/pluginAccountCopies'
import { PluginAccounts, type PluginCredentials } from './accounts'

/**
 * A headless host's account copies (ADR-0205, amending ADR-0025): the plugin accounts its desktop sent, each under the
 * desktop's own ID for it, with its secret in the host's encrypted credential file. They are kept as the host's own
 * plugin accounts are, in the same record and the same slots, so the host's threads use a copy as a desktop's threads
 * use an account.
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
  return {
    async keep(copy: PluginAccountCopy): Promise<PluginAccountCopyReceipt> {
      const kept = await accounts.adopt(copy.account, copy.secret)
      return kept.kept ? { kept: true, keptAt: now().toISOString() } : { kept: false, problem: kept.problem }
    },
    async remove(id: string): Promise<PluginAccountCopyRemoved> {
      const result = await accounts.remove({ id })
      // A copy the host does not hold is already gone, which is what was asked for. Only a copy it could not delete is not.
      if (result.ok || result.problem === 'gone') return { removed: true }
      throw new Error('PLUGIN_ACCOUNT_COPY_NOT_REMOVED')
    },
    async list(): Promise<HeldPluginAccountCopy[]> {
      return (await accounts.list()).map(account => ({ id: account.id, plugin: account.plugin, savedAt: account.savedAt }))
    },
  }
}

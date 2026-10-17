import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerIdSchema, type ProviderId } from '../../shared/agents'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { findGrokExecutable } from './grokRpc'
import { findDevinExecutable } from './devinRpc'
import { findMuseExecutable } from './museRpc'

/** Which native thread clients are on this machine. Presence only: no sign-in and no session. */
export async function detectInstalledProviders(options: { museEnabled?: boolean } = {}): Promise<ProviderId[]> {
  const claude = new ClaudeSubscriptionClient(join(tmpdir(), 'sotto-provider-detect'))
  // One finder per provider, so a new provider is a type error here until Sotto knows where to look for its client.
  const finders: Readonly<Record<ProviderId, () => Promise<unknown>>> = {
    codex: findCodexExecutable, claude: () => claude.findExecutable(), grok: findGrokExecutable, devin: findDevinExecutable,
    muse: async () => options.museEnabled === true ? findMuseExecutable() : undefined,
  }
  const ids = providerIdSchema.options
  const found = await Promise.all(ids.map(id => finders[id]()))
  return ids.filter((_id, index) => Boolean(found[index]))
}

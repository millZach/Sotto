import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerIdSchema, type ProviderId } from '../../shared/agents'
import { heldProvidersOption, type HeldProviders } from '../../shared/heldProviders'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { findGrokExecutable } from './grokRpc'
import { findDevinExecutable } from './devinRpc'
import { findMuseExecutable } from './museRpc'
import { findOpenCodeExecutable } from './opencodeServer'
import { findCursorExecutable } from './cursorRpc'
import { findPiExecutable } from './piRpc'
import { findAntigravityExecutable } from './antigravityLookup'
import { managedAntigravityExecutable } from './antigravityInstall'
import { findHermesExecutable } from './hermesRpc'
import { findDeepSeekExecutable } from './deepseekRpc'

/**
 * Which native thread clients are on this machine. Presence only: no sign-in and no session. A provider held to Owl on
 * this run is not looked for at all.
 */
export async function detectInstalledProviders(options: { heldProviders?: HeldProviders; directory?: string } = {}): Promise<ProviderId[]> {
  const { directory } = options
  const held = heldProvidersOption(options)
  const claude = new ClaudeSubscriptionClient(join(tmpdir(), 'sotto-provider-detect'))
  // One finder per provider, so a new provider is a type error here until Sotto knows where to look for its client.
  const finders: Readonly<Record<ProviderId, () => Promise<unknown>>> = {
    codex: findCodexExecutable, claude: () => claude.findExecutable(), grok: findGrokExecutable, devin: findDevinExecutable,
    muse: findMuseExecutable, opencode: findOpenCodeExecutable,
    cursor: findCursorExecutable,
    deepseek: findDeepSeekExecutable,
    hermes: findHermesExecutable,
    pi: findPiExecutable,
    // The `agy` Sotto downloaded counts as installed (the research note, "Launch").
    antigravity: () => findAntigravityExecutable(process.env, directory ? { managed: () => managedAntigravityExecutable(directory) } : {}),
  }
  const ids = providerIdSchema.options.filter(id => !held.has(id))
  const found = await Promise.all(ids.map(id => finders[id]()))
  return ids.filter((_id, index) => Boolean(found[index]))
}

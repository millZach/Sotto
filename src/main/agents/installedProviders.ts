import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/agents'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { findGrokExecutable } from './grokRpc'
import { findDevinExecutable } from './devinRpc'

/** Which native thread clients are on this machine. Presence only: no sign-in and no session. */
export async function detectInstalledProviders(): Promise<ProviderId[]> {
  const claude = new ClaudeSubscriptionClient(join(tmpdir(), 'sotto-provider-detect'))
  const [codex, claudeExecutable, grok, devin] = await Promise.all([
    findCodexExecutable(), claude.findExecutable(), findGrokExecutable(), findDevinExecutable(),
  ])
  const installed: ProviderId[] = []
  if (codex) installed.push('codex')
  if (claudeExecutable) installed.push('claude')
  if (grok) installed.push('grok')
  if (devin) installed.push('devin')
  return installed
}

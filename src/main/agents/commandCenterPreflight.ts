import type { ProviderId } from '../../shared/agents'
import type { CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal } from './commandCenterProfile'
import { assertCodexCommandCenterPreflight } from './commandCenterCodexProfile'
import { preflightClaudeCommandCenter } from './commandCenterClaudeProfile'
import { preflightGrokCommandCenter } from './commandCenterGrokProfile'

/** Local draft settings have no native command to validate them, so main checks the same preflight first. */
export function preflightCommandCenterConfiguration(profile: CommandCenterLaunchProfile, provider: ProviderId | undefined,
  version: string, modelId: string): void {
  if (provider === 'codex') return assertCodexCommandCenterPreflight(profile, version, modelId)
  if (provider === 'claude') return preflightClaudeCommandCenter(profile, version, process.platform, modelId)
  if (provider === 'grok') return preflightGrokCommandCenter(profile, version, modelId)
  throw new CommandCenterProfileRefusal('This provider cannot host the command center. Choose a verified command-center profile.')
}

import type { ProviderId } from '../../shared/agents'
import type { CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal } from './commandCenterProfile'
import { assertCodexCommandCenterPreflight } from './commandCenterCodexProfile'
import { preflightClaudeCommandCenter } from './commandCenterClaudeProfile'
import { preflightGrokCommandCenterConfiguration } from './commandCenterGrokProfile'
import type { CommandCenterAdmission } from './commandCenterAdmission'

/** Local draft settings have no native command to validate them, so main checks the same preflight first. */
export function preflightCommandCenterConfiguration(profile: CommandCenterLaunchProfile, provider: ProviderId | undefined,
  version: string, modelId: string, admissions?: readonly CommandCenterAdmission[]): void {
  if (provider === 'codex') return assertCodexCommandCenterPreflight(profile, version, modelId, process.platform, admissions)
  if (provider === 'claude') return preflightClaudeCommandCenter(profile, version, process.platform, modelId, admissions)
  if (provider === 'grok') return preflightGrokCommandCenterConfiguration(profile, version, modelId, process.platform, admissions)
  throw new CommandCenterProfileRefusal('This provider cannot host the command center. Nothing was sent. Use an ordinary thread, or choose an admitted command-center provider.')
}

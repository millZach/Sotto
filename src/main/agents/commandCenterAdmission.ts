import { clientVersionOf, compareClientVersions } from './clientVersions'
import { CommandCenterProfileRefusal } from './commandCenterProfile'

/** A reviewed live check on one provider/client/platform, with its retained evidence. */
export interface CommandCenterAdmission {
  readonly provider: 'codex' | 'claude' | 'grok'
  readonly platform: 'win32' | 'darwin'
  readonly version: string
  readonly build?: string
  readonly verificationNote: string
}

/** Only a source change after a live check may add an entry. Production never supplies an override. */
const reviewedAdmissions: readonly CommandCenterAdmission[] = []
export const COMMAND_CENTER_ADMISSIONS: readonly CommandCenterAdmission[] = Object.freeze(reviewedAdmissions.map(entry => Object.freeze(entry)))

export function assertCommandCenterAdmission(provider: CommandCenterAdmission['provider'], reportedVersion: string,
  platform: NodeJS.Platform, admissions: readonly CommandCenterAdmission[] = COMMAND_CENTER_ADMISSIONS, build?: string): void {
  const version = clientVersionOf(reportedVersion)
  const readable = /^\d+\.\d+\.\d+$/u.test(version)
  const entries = admissions.filter(entry => entry.provider === provider && entry.platform === platform
    && /^\d+\.\d+\.\d+$/u.test(entry.version) && entry.verificationNote.trim().length > 0)
  const admitted = readable && entries.some(entry => provider === 'grok'
    ? version === entry.version && !!entry.build && entry.build === build
    : compareClientVersions(version, entry.version) >= 0)
  if (admitted) return
  const label = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Grok Build'
  const client = readable ? `${label} ${version}` : `${label} on this computer`
  const place = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'this platform'
  const checked = entries.length ? `Sotto has checked ${entries.map(entry => `${entry.version}${entry.build ? ` (build ${entry.build})` : ''}`).join(', ')}.`
    : `Sotto has not checked this provider on ${place} yet.`
  throw new CommandCenterProfileRefusal(`The command center isn't available on ${client} yet. ${checked} Nothing was sent. Use an ordinary thread, or check for a Sotto update.`)
}

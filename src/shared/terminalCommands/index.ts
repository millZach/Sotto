import type { ProviderId } from '../agents'
import { claudeCommand } from './claude'
import { codexCommand } from './codex'
import { grokCommand } from './grok'
import type { ProviderCommandOptions, TerminalPermission } from './options'

export type { ProviderCommandOptions, TerminalPermission } from './options'

export const TERMINAL_PERMISSIONS: readonly TerminalPermission[] = ['ask', 'edits', 'everything']
export const TERMINAL_PERMISSION_LABELS: Readonly<Record<TerminalPermission, string>> = {
  ask: 'Ask for approval', edits: 'Allow edits', everything: 'Allow everything',
}

export interface TerminalLaunchOptions extends ProviderCommandOptions {
  /** Null opens a plain shell. */
  readonly provider: ProviderId | null
}

const COMMANDS: Readonly<Record<ProviderId, (options: ProviderCommandOptions) => string[]>> = { claude: claudeCommand, codex: codexCommand, grok: grokCommand }

/** The CLI and its flags for a launch; empty when there is no provider, since the shell alone is the command. */
export function providerCommand(launch: TerminalLaunchOptions): string[] {
  return launch.provider === null ? [] : COMMANDS[launch.provider](launch)
}

/** One line of the command as the user would type it. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(token => /[\s"]/u.test(token) ? `"${token.replace(/"/gu, '\\"')}"` : token).join(' ')
}

/** The CLI's model name from Sotto's public model ID (`native:<provider>:model:<encoded>`); other IDs pass through. */
export function nativeModelName(modelId: string): string | null {
  if (!modelId) return null
  const match = /^native:(?:codex|claude|grok):model:(.+)$/u.exec(modelId)
  if (!match) return modelId
  try { return decodeURIComponent(match[1]!) } catch { return match[1]! }
}

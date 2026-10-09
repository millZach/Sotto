import type { CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal, validateCommandCenterProfile } from './commandCenterProfile'

/** Flags inspected locally; control shapes are pinned by claude-agent-sdk 0.3.270. */
export const CLAUDE_COMMAND_CENTER_CLIENT_VERSION = '2.1.296'
export const CLAUDE_COMMAND_CENTER_SDK_VERSION = '0.3.270'
export const CLAUDE_COMMAND_CENTER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * This is a parent policy, not an administrator policy. The SDK filters it to restrictive keys,
 * and an administrator may discard it. Supplying it is therefore never compatibility proof.
 * disableSideloadFlags is intentionally absent: it would also reject our HTTP --mcp-config.
 */
export const claudeCommandCenterManagedPolicy = Object.freeze({
  disableAllHooks: true,
  disableCommandPluginSources: true,
  disableSkillShellExecution: true,
  disableClaudeAiConnectors: true,
  disableBundledSkills: true,
  disableWorkflows: true,
  disableAgentView: true,
  disableRemoteControl: true,
  enableArtifact: false,
})

/** Launch restrictions, independent of ordinary permission preferences and scoped tool servers. */
export function claudeCommandCenterArguments(profile: CommandCenterLaunchProfile): string[] {
  validateCommandCenterProfile(profile)
  return ['--tools', CLAUDE_COMMAND_CENTER_QUESTION_TOOL, '--strict-mcp-config', '--safe-mode', '--restricted',
    '--setting-sources', '', '--disable-slash-commands', '--no-chrome',
    '--managed-settings', JSON.stringify(claudeCommandCenterManagedPolicy),
    '--permission-mode', 'manual', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    '--allowedTools', ...profile.toolNames.map(name => `mcp__${profile.server.name}__${name}`)]
}

/** One supplied server; neither inherited settings nor Sotto's other scoped servers enter this file. */
export function claudeCommandCenterMcpConfig(profile: CommandCenterLaunchProfile): Record<string, unknown> {
  validateCommandCenterProfile(profile)
  const { server } = profile
  return { mcpServers: { [server.name]: { type: server.type, url: server.url,
    headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } } }
}

/**
 * No platform/model compatibility proof has been admitted yet. In particular, SDK resolveSettings
 * explicitly does not execute policyHelper and reads cached remote policy; the CLI may resolve a
 * different administrator tier before initialize. Reading a tool list afterward cannot undo an
 * executable startup hook. Do not replace this refusal with a version check or synthetic wire field.
 */
export function preflightClaudeCommandCenter(profile: CommandCenterLaunchProfile, version: string,
  platform: NodeJS.Platform, model: string): never {
  validateCommandCenterProfile(profile)
  if (!version.includes(CLAUDE_COMMAND_CENTER_CLIENT_VERSION) || !model || !['win32', 'darwin', 'linux'].includes(platform)) {
    throw new CommandCenterProfileRefusal('Sotto cannot verify Claude Code’s startup policy and complete tool list for this client, model and platform. Nothing was sent. Choose a verified command-center provider or check for a Sotto update.')
  }
  throw new CommandCenterProfileRefusal('Sotto cannot verify Claude Code’s startup policy and complete tool list before this client and model run. Nothing was sent. Choose a verified command-center provider or check for a Sotto update.')
}

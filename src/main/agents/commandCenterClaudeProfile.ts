import type { CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal, validateCommandCenterProfile } from './commandCenterProfile'
import { assertCommandCenterAdmission, type CommandCenterAdmission } from './commandCenterAdmission'
import { object, type ClaudeFrame } from './claudeProtocol'

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
  return ['--tools', CLAUDE_COMMAND_CENTER_QUESTION_TOOL, '--strict-mcp-config', '--restricted',
    '--setting-sources', '', '--disable-slash-commands', '--safe-mode', '--no-chrome',
    '--managed-settings', JSON.stringify(claudeCommandCenterManagedPolicy),
    '--settings', JSON.stringify({ enabledPlugins: Object.fromEntries(['sec-default', 'agents-md', 'telemetry', 'plugin-authoring'].map(name => [`${name}@builtin`, false])) }),
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

/** The reviewed live check admits a platform and version floor; reports still gate each process. */
export function preflightClaudeCommandCenter(profile: CommandCenterLaunchProfile, version: string,
  platform: NodeJS.Platform, model: string, admissions?: readonly CommandCenterAdmission[]): void {
  validateCommandCenterProfile(profile)
  assertCommandCenterAdmission('claude', version, platform, admissions)
  if (!model) throw claudeCommandCenterReportRefusal('did not report a model')
}

export function claudeCommandCenterReportRefusal(detail: string, promptSent = false): CommandCenterProfileRefusal {
  return new CommandCenterProfileRefusal(`Claude Code ${detail}, so Sotto stopped the command center and its tools. ${promptSent ? 'The first message reached Claude Code. Nothing else was sent.' : 'Nothing was sent.'} Use an ordinary thread, or check for a Sotto update.`)
}

const empty = (value: unknown): boolean => Array.isArray(value) && value.length === 0
const exactNames = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value)
  && value.length === expected.length && new Set(value).size === value.length
  && value.every(name => typeof name === 'string' && expected.includes(name))

const builtInAgents = ['claude', 'Explore', 'general-purpose', 'Plan'] as const
const onlyBuiltInAgents = (value: unknown): boolean => Array.isArray(value)
  && value.every(agent => { const name = typeof agent === 'string' ? agent : object(agent)?.name
    return typeof name === 'string' && builtInAgents.includes(name as typeof builtInAgents[number]) })

/** initialize reports customization catalogs, but neither the complete native tools nor MCP tools. */
export function assertClaudeCommandCenterInitializeReport(report: ClaudeFrame, platform: NodeJS.Platform,
  admissions?: readonly CommandCenterAdmission[]): void {
  if (!empty(report.commands) || !onlyBuiltInAgents(report.agents)) {
    throw claudeCommandCenterReportRefusal('reported commands or agents outside its read-only profile, or an unreadable startup report')
  }
  // 2.1.296's boolean hooks_applied acknowledges initialization; it is not a hook inventory.
  // If a later report supplies an inventory, no user/project hook may be present.
  if ('hooks_applied' in report && typeof report.hooks_applied !== 'boolean'
    && !empty(report.hooks_applied) && !(object(report.hooks_applied) && Object.keys(object(report.hooks_applied)!).length === 0)) {
    throw claudeCommandCenterReportRefusal('reported hooks outside its read-only profile, or an unreadable hook report')
  }
  // Installed 2.1.296 reports these; the older pinned SDK type does not yet name them.
  if ('current_permission_mode' in report && report.current_permission_mode !== 'default') {
    throw claudeCommandCenterReportRefusal('reported a permission mode outside its read-only profile')
  }
  if ('claude_code_version' in report) {
    if (typeof report.claude_code_version !== 'string') throw claudeCommandCenterReportRefusal('did not provide a readable startup client version')
    assertCommandCenterAdmission('claude', report.claude_code_version, platform, admissions)
  }
}

/** Native get_settings reads the actual cascade; policySettings are the trusted administrator tier. */
export function assertClaudeCommandCenterSettingsReport(report: ClaudeFrame): string {
  const applied = object(report.applied)
  if (!object(report.effective) || !Array.isArray(report.sources) || typeof applied?.model !== 'string' || !applied.model
    || report.errors !== undefined && !empty(report.errors)) {
    throw claudeCommandCenterReportRefusal('did not provide a readable startup settings report')
  }
  for (const source of report.sources) {
    const entry = object(source), settings = object(entry?.settings)
    if (!settings || !['policySettings', 'flagSettings'].includes(String(entry?.source))
      || entry?.source !== 'policySettings' && settings.hooks !== undefined) {
      throw claudeCommandCenterReportRefusal('reported a settings source outside its read-only profile')
    }
  }
  return applied.model
}

/** This is the client's real first-turn system/init inventory, checked before any other turn frame. */
export function assertClaudeCommandCenterStartupReport(profile: CommandCenterLaunchProfile, frame: ClaudeFrame,
  model: string | undefined, platform: NodeJS.Platform, admissions?: readonly CommandCenterAdmission[], promptSent = false): void {
  const refusal = (detail: string): CommandCenterProfileRefusal => claudeCommandCenterReportRefusal(detail, promptSent)
  if (frame.type !== 'system' || frame.subtype !== 'init' || typeof frame.claude_code_version !== 'string') {
    throw refusal('did not provide a readable startup tool report')
  }
  try { assertCommandCenterAdmission('claude', frame.claude_code_version, platform, admissions) }
  catch (error) {
    if (promptSent && error instanceof CommandCenterProfileRefusal) {
      throw new CommandCenterProfileRefusal(error.message.replace('Nothing was sent.', 'The first message reached Claude Code. Nothing else was sent.'))
    }
    throw error
  }
  const expected = [CLAUDE_COMMAND_CENTER_QUESTION_TOOL, ...profile.toolNames.map(name => `mcp__${profile.server.name}__${name}`)]
  if (!exactNames(frame.tools, expected)) throw refusal('reported tools outside its read-only profile, or omitted a supplied tool')
  if (!Array.isArray(frame.mcp_servers) || frame.mcp_servers.length !== 1
    || object(frame.mcp_servers[0])?.name !== profile.server.name || object(frame.mcp_servers[0])?.status !== 'connected') {
    throw refusal('reported an unavailable or extra tool server')
  }
  if (frame.permissionMode !== 'default' || typeof frame.model !== 'string' || !frame.model || model && frame.model !== model) {
    throw refusal('reported a permission mode or model outside its read-only profile')
  }
  if (!empty(frame.slash_commands) || !empty(frame.skills) || !empty(frame.plugins)
    || frame.agents !== undefined && !onlyBuiltInAgents(frame.agents)
    || frame.terminal_slash_commands !== undefined && !empty(frame.terminal_slash_commands)
    || frame.plugin_errors !== undefined && !empty(frame.plugin_errors)
    || frame.mcp_server_errors !== undefined && !empty(frame.mcp_server_errors)) {
    throw refusal('reported customization outside its read-only profile, or an unreadable startup inventory')
  }
}

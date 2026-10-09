import type { CommandCenterLaunchProfile } from './host'
import { CommandCenterProfileRefusal, validateCommandCenterProfile } from './commandCenterProfile'

export const COMMAND_CENTER_CODEX_VERSION = '0.162.0'
export const commandCenterCodexPolicy = Object.freeze({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' })

/** Configuration shapes checked against rust-v0.162.0/core/config.schema.json. No legacy no-op skill flag. */
export function commandCenterCodexConfig(profile: CommandCenterLaunchProfile): Record<string, unknown> {
  validateCommandCenterProfile(profile)
  return {
    model_provider: 'openai', sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'user',
    'features.shell_tool': false, 'features.unified_exec': false, 'features.multi_agent': false,
    'features.multi_agent_v2.enabled': false, 'agents.enabled': false, 'features.apps': false, 'features.hooks': false,
    'features.plugins': false, 'features.plugin_hooks': false, 'features.remote_plugin': false,
    'features.browser_use': false, 'features.browser_use_external': false, 'features.computer_use': false,
    'features.js_repl': false, 'features.code_mode.enabled': false, 'features.code_mode_host.enabled': false,
    'features.image_generation': false, 'features.imagegenext': false, 'features.view_image': false,
    'features.goals': false, 'features.memories': false, 'features.memory_tool': false,
    'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
    'skills.bundled.enabled': false, 'skills.include_instructions': false,
    'features.default_mode_request_user_input': true, web_search: 'disabled', notify: [],
    mcp_servers: { sotto_threads: { url: profile.server.url,
      http_headers: Object.fromEntries(profile.server.headers.map(header => [header.name, header.value])),
      enabled_tools: [...profile.toolNames], default_tools_approval_mode: 'prompt',
      tools: Object.fromEntries(profile.toolNames.map(name => [name, { approval_mode: 'approve' }])),
    } },
  }
}

/** CLI overrides use TOML, including tables. JSON objects are not TOML tables. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(', ')} }`
  return JSON.stringify(value)
}
export function commandCenterCodexArguments(profile: CommandCenterLaunchProfile): string[] {
  return ['app-server', '--stdio', '--strict-config', ...Object.entries(commandCenterCodexConfig(profile)).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])]
}

/** Refuse before startup: config/read + MCP status are not a complete native tool/customization inventory. */
export function assertCodexCommandCenterPreflight(profile: CommandCenterLaunchProfile, version: string, modelId: string,
  platform: NodeJS.Platform = process.platform): never {
  validateCommandCenterProfile(profile)
  if (!version.includes(`/${COMMAND_CENTER_CODEX_VERSION}`) && version !== COMMAND_CENTER_CODEX_VERSION) {
    throw new CommandCenterProfileRefusal('This Codex version has no verified command-center profile. Nothing was sent. Use an ordinary thread until its read-only profile is verified.')
  }
  if (!modelId || !['win32', 'darwin', 'linux'].includes(platform)) {
    throw new CommandCenterProfileRefusal('This Codex model or platform has no verified command-center profile. Nothing was sent.')
  }
  // 0.162.0 removed tools.view_image; features.view_image is supported. Skills include_instructions only hides
  // instructions, and orchestrator.skills.enabled is explicitly a no-op. Do not advertise either as isolation.
  throw new CommandCenterProfileRefusal('Sotto cannot yet prove Codex’s complete toolset and startup customization are restricted for the command center. Nothing was sent. Use an ordinary thread until this combination is verified.')
}

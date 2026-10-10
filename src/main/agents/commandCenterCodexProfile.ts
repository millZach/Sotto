import type { CommandCenterLaunchProfile } from './host'
import { z } from 'zod'
import { assertCommandCenterAdmission, type CommandCenterAdmission } from './commandCenterAdmission'
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

/** Admission supplies the native-tool proof that app-server cannot report. */
export function assertCodexCommandCenterPreflight(profile: CommandCenterLaunchProfile, version: string, modelId: string,
  platform: NodeJS.Platform = process.platform, admissions?: readonly CommandCenterAdmission[]): void {
  validateCommandCenterProfile(profile)
  assertCommandCenterAdmission('codex', version, platform, admissions)
  if (!modelId) throw new CommandCenterProfileRefusal('The command center has no available Codex model. Nothing was sent. Choose a model, or use an ordinary thread.')
}

export const CODEX_COMMAND_CENTER_REPORT_FAILURE = 'Codex did not report the command center’s required settings and tools. Its session and tools were stopped. Nothing was sent. Use an ordinary thread, or check for a Sotto update.'

const configReport = z.object({ config: z.record(z.string(), z.unknown()) })
const serverReport = z.object({ name: z.string(), tools: z.record(z.string(), z.object({ name: z.string() })) })
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const valueAt = (config: Record<string, unknown>, key: string): unknown => key.split('.').reduce<unknown>((value, part) => record(value)?.[part], config)
const sameNames = (actual: readonly string[], expected: readonly string[]): boolean => actual.length === expected.length
  && new Set(actual).size === actual.length && expected.every(name => actual.includes(name))

/** config/read's effective nested config and every page of mcpServerStatus/list. Never persisted or logged. */
export function assertCodexCommandCenterStartupReport(profile: CommandCenterLaunchProfile, configResponse: unknown, statuses: unknown): void {
  validateCommandCenterProfile(profile)
  const config = configReport.safeParse(configResponse)
  const servers = z.array(serverReport).safeParse(statuses)
  const fail = (): never => { throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE) }
  if (!config.success || !servers.success) fail()
  const effective = config.data!.config
  // Only verify fields the client reports. Its native tool catalog is absent; the live check supplies that proof.
  for (const [key, expected] of Object.entries(commandCenterCodexConfig(profile))) {
    if (key === 'mcp_servers') continue
    if (JSON.stringify(valueAt(effective, key)) !== JSON.stringify(expected)) fail()
  }
  const configured = record(effective.mcp_servers)
  if (!configured || !sameNames(Object.keys(configured), ['sotto_threads'])) fail()
  const supplied = record(configured!.sotto_threads)
  if (!supplied || supplied.url !== profile.server.url || supplied.default_tools_approval_mode !== 'prompt'
    || !Array.isArray(supplied.enabled_tools) || !sameNames(supplied.enabled_tools as string[], profile.toolNames)) fail()
  const headers = record(supplied!.http_headers)
  if (!headers || !sameNames(Object.keys(headers), profile.server.headers.map(header => header.name))
    || profile.server.headers.some(header => headers[header.name] !== header.value)) fail()
  const tools = record(supplied!.tools)
  if (!tools || !sameNames(Object.keys(tools), profile.toolNames)
    || profile.toolNames.some(name => record(tools[name])?.approval_mode !== 'approve' || record(tools[name])?.enabled === false)) fail()
  if (supplied!.enabled === false || servers.data!.length !== 1 || servers.data![0]!.name !== 'sotto_threads') fail()
  const names = Object.values(servers.data![0]!.tools).map(tool => tool.name.replace(/^mcp__sotto_threads__/u, ''))
  if (!sameNames(names, profile.toolNames)) fail()
}

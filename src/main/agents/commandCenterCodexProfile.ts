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
    'features.remote_control': false, 'features.tool_suggest': false,
    'features.plugins': false, 'features.plugin_hooks': false, 'features.remote_plugin': false,
    'features.browser_use': false, 'features.browser_use_external': false, 'features.computer_use': false,
    'features.js_repl': false, 'features.code_mode.enabled': false, 'features.code_mode_host.enabled': false,
    'features.image_generation': false, 'features.imagegenext': false, 'features.view_image': false,
    'features.goals': false, 'features.memories': false, 'features.memory_tool': false,
    'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
    'apps._default.enabled': false,
    'skills.bundled.enabled': false, 'skills.include_instructions': false,
    'features.default_mode_request_user_input': true, web_search: 'disabled', notify: [],
    mcp_servers: { sotto_threads: { url: profile.server.url, enabled: true, omit_tools_from: ['deferred', 'code_mode'],
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
export function commandCenterCodexArguments(profile: CommandCenterLaunchProfile, inherited: Record<string, unknown> = {}): string[] {
  const config = commandCenterCodexConfig(profile)
  return ['app-server', '--stdio', '--strict-config', ...Object.entries({ ...config, ...inherited, mcp_servers: { ...record(inherited.mcp_servers), ...record(config.mcp_servers) } }).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])]
}

/** Read names through the client, never the user's files. CLI tables merge, so disable each entry. */
export function commandCenterCodexInheritedConfig(response: unknown): Record<string, unknown> {
  const parsed = configReport.safeParse(response)
  if (!parsed.success) throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE)
  const servers = record(parsed.data.config.mcp_servers)
  if (!servers) throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE)
  const config = parsed.data.config
  if (hasInheritedTransport(record(servers.sotto_threads))) throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE)
  const overrides: Record<string, unknown> = { mcp_servers: Object.fromEntries(Object.keys(servers).filter(name => name !== 'sotto_threads')
    .map(name => [name, { enabled: false }])) }
  for (const key of ['apps', 'plugins']) {
    const table = config[key]
    if (table !== undefined && table !== null && !record(table)) throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE)
    overrides[key] = Object.fromEntries(Object.keys(record(table) ?? {}).map(name => [name, { enabled: false }]))
  }
  const skills = record(config.skills)?.config
  if (skills !== undefined && (!Array.isArray(skills) || skills.some(skill => !record(skill)))) throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE)
  overrides['skills.config'] = (skills as Record<string, unknown>[] | undefined ?? []).map(skill => ({ ...skill, enabled: false }))
  return overrides
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
const serverReport = z.object({ name: z.string(), tools: z.record(z.string(), z.object({ name: z.string() })), runtimeStatus: z.string().nullable().optional(), resources: z.array(z.unknown()).optional(), resourceTemplates: z.array(z.unknown()).optional() })
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
// Never let an inherited command or credential helper extend Sotto's supplied HTTP transport.
const hasInheritedTransport = (server: Record<string, unknown> | undefined): boolean => !!server && ['command', 'args', 'cwd', 'env', 'env_vars', 'env_http_headers', 'http_headers_helper', 'bearer_token_env_var', 'auth', 'oauth', 'oauth_resource'].some(key => {
  const value = server[key]
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0) && (!record(value) || Object.keys(record(value)!).length > 0)
})
const valueAt = (config: Record<string, unknown>, key: string): unknown => key.split('.').reduce<unknown>((value, part) => record(value)?.[part], config)
const sameNames = (actual: readonly string[], expected: readonly string[]): boolean => actual.length === expected.length
  && new Set(actual).size === actual.length && expected.every(name => actual.includes(name))

/** Check configuration before asking MCP discovery to activate a server. Never persisted or logged. */
export function assertCodexCommandCenterConfigReport(profile: CommandCenterLaunchProfile, configResponse: unknown): Record<string, unknown> {
  validateCommandCenterProfile(profile)
  const config = configReport.safeParse(configResponse)
  const fail = (): never => { throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE) }
  if (!config.success) fail()
  const effective = config.data!.config
  // Only verify fields the client reports. Its native tool catalog is absent; the live check supplies that proof.
  for (const [key, expected] of Object.entries(commandCenterCodexConfig(profile))) {
    if (key === 'mcp_servers') continue
    if (JSON.stringify(valueAt(effective, key)) !== JSON.stringify(expected)) fail()
  }
  const configured = record(effective.mcp_servers)
  if (!configured || !Object.hasOwn(configured, 'sotto_threads')
    || Object.entries(configured).some(([name, value]) => name !== 'sotto_threads' && record(value)?.enabled !== false)) fail()
  const supplied = record(configured!.sotto_threads)
  if (!supplied || hasInheritedTransport(supplied) || supplied.enabled !== true || !Array.isArray(supplied.omit_tools_from) || !sameNames(supplied.omit_tools_from as string[], ['deferred', 'code_mode']) || supplied.url !== profile.server.url || supplied.default_tools_approval_mode !== 'prompt'
    || !Array.isArray(supplied.enabled_tools) || !sameNames(supplied.enabled_tools as string[], profile.toolNames)) fail()
  const headers = record(supplied!.http_headers)
  if (!headers || !sameNames(Object.keys(headers), profile.server.headers.map(header => header.name))
    || profile.server.headers.some(header => headers[header.name] !== header.value)) fail()
  const tools = record(supplied!.tools)
  if (!tools || !sameNames(Object.keys(tools), profile.toolNames)
    || profile.toolNames.some(name => record(tools[name])?.approval_mode !== 'approve' || record(tools[name])?.enabled === false)) fail()
  for (const key of ['apps', 'plugins']) {
    const entries = effective[key]
    if (entries !== undefined && entries !== null && (!record(entries) || Object.values(record(entries)!).some(entry => record(entry)?.enabled !== false))) fail()
  }
  const skillEntries = record(effective.skills)?.config
  if (skillEntries !== undefined && (!Array.isArray(skillEntries) || skillEntries.some(entry => record(entry)?.enabled !== false))) fail()
  return effective
}

/** The real effective configuration and every page of MCP status, checked again before turn work. */
export function assertCodexCommandCenterStartupReport(profile: CommandCenterLaunchProfile, configResponse: unknown, statuses: unknown): void {
  const effective = assertCodexCommandCenterConfigReport(profile, configResponse)
  const servers = z.array(serverReport).safeParse(statuses)
  const fail = (): never => { throw new CommandCenterProfileRefusal(CODEX_COMMAND_CENTER_REPORT_FAILURE) }
  if (!servers.success) fail()
  const configured = record(effective.mcp_servers)!
  const suppliedStatuses = servers.data!.filter(server => server.name === 'sotto_threads')
  if (suppliedStatuses.length !== 1 || new Set(servers.data!.map(server => server.name)).size !== servers.data!.length) fail()
  for (const server of servers.data!) {
    if (server.name === 'sotto_threads') continue
    if (record(configured![server.name])?.enabled !== false || Object.keys(server.tools).length
      || server.runtimeStatus !== null && server.runtimeStatus !== 'disabled'
      || server.resources?.length || server.resourceTemplates?.length) fail()
  }
  const names = Object.values(suppliedStatuses[0]!.tools).map(tool => tool.name.replace(/^mcp__sotto_threads__/u, ''))
  if (!sameNames(names, profile.toolNames)) fail()
}

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { CommandCenterLaunchProfile } from './host'
import { assertCommandCenterAdmission, COMMAND_CENTER_ADMISSIONS, type CommandCenterAdmission } from './commandCenterAdmission'
import { CommandCenterProfileRefusal, validateCommandCenterProfile } from './commandCenterProfile'
import { grokEnvironment } from './grokRpc'
import { grokToolAdmission, type GrokPending } from './grokRequests'
import { clientVersionOf } from './clientVersions'

/** Read from this machine's version/help output, without starting an account session. */
export const GROK_COMMAND_CENTER_INSPECTED_VERSION = '1.0.50'
export const GROK_COMMAND_CENTER_INSPECTED_BUILD = 'c58f321264ba'
/** Profile and ToolConfig shapes in the official source linked by the approved plan. */
export const GROK_COMMAND_CENTER_PROFILE_SOURCE = '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8'
export const GROK_COMMAND_CENTER_NATIVE_TOOLS = ['GrokBuild:search_tool', 'GrokBuild:use_tool'] as const

/**
 * Explicit ToolConfig avoids the native `tools` name filter's unknown-name/full-toolset fallback.
 * These are configuration requests, not proof of what a model-selected harness actually offers.
 */
export function grokCommandCenterMeta(profile: CommandCenterLaunchProfile) {
  validateCommandCenterProfile(profile)
  return {
    yoloMode: false, autoMode: false,
    agentProfile: {
      name: 'sotto-command-center',
      description: `Sotto command center. Its only MCP tools are ${profile.toolNames.map(name => `${profile.server.name}__${name}`).join(', ')}.`,
      toolConfig: { tools: GROK_COMMAND_CENTER_NATIVE_TOOLS.map(id => ({ id, params: null, name_override: null, params_name_overrides: null })) },
      injectDefaultTools: false, discoverSkills: false, inheritSkills: false, skills: [], agentsMd: false,
      permissionMode: 'dontAsk', mcpInheritance: 'none', mcpServers: [], hooks: {}, memory: null,
    },
  }
}

/** Config isolation preserves only the provider-owned authentication path; credentials are never read. */
export function grokCommandCenterEnvironment(userDataDirectory: string, threadId: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!isAbsolute(userDataDirectory)) throw new CommandCenterProfileRefusal('The command center needs a Sotto-owned configuration folder. Nothing was sent.')
  const nativeHome = environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(homedir(), '.grok')
  const authPath = environment.GROK_AUTH_PATH && isAbsolute(environment.GROK_AUTH_PATH) ? environment.GROK_AUTH_PATH : join(nativeHome, 'auth.json')
  const key = createHash('sha256').update(threadId).digest('hex')
  const env: NodeJS.ProcessEnv = { ...grokEnvironment(environment), GROK_HOME: join(userDataDirectory, 'command-center', 'grok', key), GROK_AUTH_PATH: authPath,
    GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_WRITE_FILE: '0', GROK_WEB_FETCH: '0', GROK_LSP_TOOLS: '0',
    GROK_MANAGED_MCPS_ENABLED: '0', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0', GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0' }
  for (const vendor of ['CURSOR', 'CLAUDE']) for (const feature of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) env[`GROK_${vendor}_${feature}_ENABLED`] = '0'
  return env
}

/** The flags are accepted by 1.0.50's installed help; neither permission mode nor callbacks prove isolation. */
export function grokCommandCenterArguments(): string[] {
  return ['--no-subagents', '--disable-web-search', '--permission-mode', 'dontAsk', 'agent', '--no-leader', 'stdio']
}

/** Every new/cold-load/turn/settings path must pass this check before starting or using a process. */
export function preflightGrokCommandCenter(profile: CommandCenterLaunchProfile, version: string, _modelId: string | undefined, platform: NodeJS.Platform = process.platform,
  admissions?: readonly CommandCenterAdmission[], build?: string): void {
  validateCommandCenterProfile(profile)
  // ACP does not report its tools or harness. Only a live-checked exact version and build can admit it.
  assertCommandCenterAdmission('grok', version, platform, admissions, build)
}

/** Preliminary workspace admission only. The adapter checks the actual build before a session exists. */
export function preflightGrokCommandCenterConfiguration(profile: CommandCenterLaunchProfile, version: string, modelId: string | undefined,
  platform: NodeJS.Platform = process.platform, admissions: readonly CommandCenterAdmission[] = COMMAND_CENTER_ADMISSIONS): void {
  const entry = admissions.find(admission => admission.provider === 'grok' && admission.platform === platform && admission.version === clientVersionOf(version))
  preflightGrokCommandCenter(profile, version, modelId, platform, admissions, entry?.build)
}

/** The installed CLI's version output carries the build that ACP's agentVersion omits. */
export function grokCommandCenterVersion(output: string): { version: string; build: string } | undefined {
  const match = /^(?:grok(?:-build)?\s+)?(\d+\.\d+\.\d+)\s+\(([a-f0-9]{10,40})\)\s*$/iu.exec(output.trim())
  return match ? { version: match[1]!, build: match[2]!.toLowerCase() } : undefined
}

/** Admission is exact to the supplied endpoint's server and names, never the global tool definitions. */
export function grokCommandCenterAdmission(pending: GrokPending, profile: CommandCenterLaunchProfile): unknown {
  validateCommandCenterProfile(profile)
  return grokToolAdmission(pending, profile.server.name, profile.toolNames)
}

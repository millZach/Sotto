import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { withCliPath } from './cliLookup'
import { DEVIN_CLI_VERSION, DevinRefusal } from './devinRpc'

// This is Sotto's approval policy, not Devin's similarly named Ask mode. The profile is what decides:
// the pinned compatibility experiment shows an ask standing whatever conversation mode Devin is in, with
// `accept-edits` and even `bypass` still sending session/request_permission, and an allow removing the ask
// (docs/verification/devin-permission-modes.md). So what Devin may do unasked is written here, in a file
// Sotto owns and reads back, and never inferred from what a provider mode says it means (ADR-0022).
const EDITS = ['edit', 'write', 'Write(**)', 'Write(/**)']
const ACTIONS = ['exec', 'Fetch(*)', 'mcp__*']

/** What a thread's profile lets Devin do unasked; everything else is asked, every time. */
export type DevinAllowance = 'nothing' | 'edits' | 'everything'
/**
 * A written, confirmed profile and what it allows. They travel as one value because a profile checked
 * against the wrong allowance is exactly the mistake the readback exists to catch.
 */
export interface DevinProfile { readonly path: string; readonly allows: DevinAllowance }

const permissionsFor = (allows: DevinAllowance): { allow: string[]; deny: string[]; ask: string[] } => ({
  allow: allows === 'everything' ? [...EDITS, ...ACTIONS] : allows === 'edits' ? [...EDITS] : [],
  deny: [],
  ask: allows === 'everything' ? [] : allows === 'edits' ? [...ACTIONS] : [...EDITS, ...ACTIONS],
})

// The profile's own version, in its file name. Version 2 adds `otel`: an owned profile is never rewritten (a changed
// one is refused), so changing what it says means a new file. Version 1 files are left where they are, unused.
const PROFILE_VERSION = 2
// `version` below is Devin's own config schema version, not the profile's.
const policyFor = (allows: DevinAllowance): Record<string, unknown> => ({
  version: 1,
  permissions: permissionsFor(allows),
  read_config_from: { agents_standard: false, cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false },
  hooks: {}, mcpServers: {}, auto_update: false, subagents_enabled: false,
  // OpenTelemetry export, from Devin CLI 3000.11.1. Off, so the promise does not rest on no endpoint being set.
  // The pinned 3000.10.31 accepts the key and drops it from its readback.
  otel: { enabled: false },
})
// 3000.11.3 reads `otel` back with every field filled in with its default. It reports the pinned `enabled: false`,
// but has also been seen reporting its own default, `enabled: true`, while the profile pins it off. Both are accepted,
// as is the profile's own block exactly as written, because none of them can export: export needs an endpoint in this
// block, Sotto passes Devin no OTEL_* variable (devinEnvironment), and Devin's documentation says a variable cannot
// start export without one. Anything else, any endpoint, header or attribute included, is refused.
const otelDefaults = {
  endpoint: null, logs_endpoint: null, metrics_endpoint: null, headers: {}, logs_headers: {}, metrics_headers: {},
  resource_attributes: {}, timeout_ms: null, log_export_interval_ms: null, metric_export_interval_ms: null,
  disable_user_prompt_logging: false, disable_tool_logging: false,
}
const otelWithoutExport = [{ enabled: false }, { enabled: false, ...otelDefaults }, { enabled: true, ...otelDefaults }]
const otelExportsNothing = (value: unknown): boolean => otelWithoutExport.some(shape => isDeepStrictEqual(value, shape))
// Native config/read expands the user profile with defaults. Only these known
// fields may accompany the exact owned settings; routing and execution defaults
// must remain unchanged. On-disk profiles still accept no extra fields at all.
const normalizedRoutes: Record<string, unknown> = {
  proxy: { mode: 'system', url: null, no_proxy: null },
  devin: { org_id: null },
  shell: { setup_complete: false, startup_messages_remaining: 10, exec_shell: null },
  sandbox: { allowed_domains: [], denied_domains: [], network_mode: 'full', excluded: { allow: [], ask: [], deny: [] } },
  disabled_tools: [], keymap: {},
}
const presentationFields = new Set(['theme_mode', 'theme_auto_detect', 'pty_for_noninteractive_exec', 'skip_home_directory_warning',
  'show_path', 'include_gitignored_files', 'respect_gitignore', 'attribution', 'unicode_mode', 'legacy_terminal', 'disable_osc',
  'skip_workspace_trust', 'notify', 'mouse_capture', 'show_hints'])

/** How a readback compares with the owned profile. `newer` is a top-level block Sotto has never checked. */
type Readback = 'matches' | 'differs' | 'telemetry' | 'newer'

function compareNormalizedProfile(config: Record<string, unknown>, policy: Record<string, unknown>): Readback {
  if (!Object.entries(policy).every(([key, value]) => key === 'otel' || isDeepStrictEqual(config[key], value))) return 'differs'
  // A CLI older than the block drops it; a newer one must read it back as exporting nothing.
  if (Object.hasOwn(config, 'otel') && !otelExportsNothing(config.otel)) return 'telemetry'
  let unknown = false
  for (const [key, value] of Object.entries(config)) {
    if (Object.hasOwn(policy, key)) continue
    if (Object.hasOwn(normalizedRoutes, key)) { if (!isDeepStrictEqual(value, normalizedRoutes[key])) return 'differs' }
    else if (key === 'agent') {
      const agent = object(value)
      if (!agent || !isDeepStrictEqual(Object.keys(agent).sort(), ['model', 'preferred_family_models', 'show_history_on_continue', 'thinking', 'model_mixture', 'compaction_threshold_tokens', 'codex_tools'].sort())
        || agent.model !== null || !isDeepStrictEqual(agent.preferred_family_models, {}) || agent.model_mixture !== null
        || agent.compaction_threshold_tokens !== null || agent.codex_tools !== false || typeof agent.show_history_on_continue !== 'boolean') return 'differs'
      const thinking = object(agent.thinking)
      if (!thinking || Object.keys(thinking).length !== 1 || typeof thinking.mode !== 'string') return 'differs'
    } else if (presentationFields.has(key)) { if (value !== null && !['string', 'boolean'].includes(typeof value)) return 'differs' }
    else unknown = true
  }
  // Judged last, so a block Sotto knows that reads back wrong is reported as that rather than as a newer version.
  return unknown ? 'newer' : 'matches'
}

const preparing = new Map<string, Promise<void>>()
const nativeFiles = ['config.json', 'config.local.json', 'hooks.v1.json', 'mcp_config.json', 'mcp_config.local.json']

function nativeConfigDirectory(): string {
  return process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'devin')
    : join(homedir(), '.config', 'devin')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function rejectExisting(path: string): Promise<void> {
  try { await lstat(path) } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw new Error('Sotto could not check Devin configuration. Your thread is kept. Check folder access and reconnect Devin.', { cause: error })
  }
  throw new Error('This folder or Devin installation has native configuration that Sotto cannot safely combine with its approval policy. Your thread is kept. Use a folder without native Devin configuration.')
}

/** Presence-only checks: native MCP files can contain secrets, so never read them. */
export async function assertDevinWorkingDirectory(cwd?: string, configDirectory = nativeConfigDirectory()): Promise<void> {
  for (const name of ['hooks.v1.json']) await rejectExisting(join(configDirectory, name))
  if (!cwd) return
  if (!isAbsolute(cwd)) throw new Error('Devin needs an absolute working folder. Your thread is kept.')
  // Devin resolves `.devin` from the working folder upwards, never below it, so
  // those are the only places a native file can reach the session Sotto starts.
  // The pinned descendant experiment records the evidence; a folder's size and
  // its linked directories no longer decide whether a thread may run.
  let directory = await realpath(cwd)
  while (true) {
    for (const name of nativeFiles) await rejectExisting(join(directory, '.devin', name))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

/** The file an allowance is written to. One file each, so a thread's file says what it was allowed. */
export function devinPolicyPath(userDataDirectory: string, allows: DevinAllowance): string {
  const name = `approval-policy-v${PROFILE_VERSION}`
  return resolve(userDataDirectory, 'devin', allows === 'nothing' ? `${name}.json` : `${name}-${allows}.json`)
}

/**
 * A versioned, Sotto-owned profile; existing native user/project files are never changed. What the
 * thread allows picks the file, and `nothing` keeps the original name so a profile written before
 * allowances existed is still the one an asking thread uses. The allowance has no default: a caller
 * that forgot it would otherwise check every profile as the asking one.
 */
export async function prepareDevinPolicy(userDataDirectory: string, allows: DevinAllowance, cwd?: string, configDirectory?: string): Promise<DevinProfile> {
  await assertDevinWorkingDirectory(cwd, configDirectory)
  const policy = policyFor(allows)
  const policyText = `${JSON.stringify(policy, null, 2)}\n`
  const path = devinPolicyPath(userDataDirectory, allows)
  let pending = preparing.get(path)
  if (!pending) {
    pending = (async () => {
      // Each cause carries the errno; the message the user reads never does.
      try {
        await mkdir(dirname(path), { recursive: true })
        try { await writeFile(path, policyText, { encoding: 'utf8', flag: 'wx', mode: 0o600 }) } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error
        }
      } catch (error) {
        throw new Error('Sotto could not write its approval profile for Devin. Your thread is kept. Check access to Sotto’s data folder and reconnect Devin.', { cause: error })
      }
      let link: boolean
      try { link = (await lstat(path)).isSymbolicLink() } catch (error) {
        throw new Error('Sotto could not read its approval profile for Devin. Your thread is kept. Check access to Sotto’s data folder and reconnect Devin.', { cause: error })
      }
      if (link) throw new Error('The Sotto approval profile for Devin has changed. Your thread is kept. Restore the profile before reconnecting Devin.')
      let existing: unknown
      try { existing = JSON.parse(await readFile(path, 'utf8')) } catch { /* Invalid profile is rejected below without logging its contents. */ }
      if (!isDeepStrictEqual(existing, policy)) {
        throw new Error('The Sotto approval profile for Devin has changed. Your thread is kept. Restore the profile before reconnecting Devin.')
      }
    })()
    preparing.set(path, pending)
  }
  try { await pending } finally { if (preparing.get(path) === pending) preparing.delete(path) }
  return { path, allows }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Receives the result of _cognition.ai/config/read, never a logged protocol body.
 * This confirms the user profile only; it does not report merged native policy.
 */
export function verifyDevinPolicy(result: unknown, profile: DevinProfile): void {
  const response = object(result)
  const config = object(response?.config)
  const readback = typeof response?.configPath === 'string' && isAbsolute(response.configPath)
    && resolve(response.configPath) === resolve(profile.path) && config
    ? compareNormalizedProfile(config, policyFor(profile.allows)) : 'differs'
  // Refusals, not garbled replies: DevinRpc passes them on as they are, so these words reach the provider's tile.
  if (readback === 'telemetry') throw new DevinRefusal('Devin is set to export telemetry, which Sotto’s profile turns off. Nothing was sent, and your threads are kept. Remove the otel settings Devin reads, then reconnect.')
  if (readback === 'newer') throw new DevinRefusal(`This Devin version is newer than the one Sotto checked, and it has settings Sotto has not checked. Nothing was sent, and your threads are kept. Use Devin CLI ${DEVIN_CLI_VERSION} until Sotto checks this version.`)
  if (readback !== 'matches') throw new DevinRefusal('Devin did not confirm the Sotto approval profile. Your thread is kept. Reconnect with the supported Devin version.')
}

/** Version-pinned CLI output, deliberately fail-closed instead of parsing names. */
export function verifyDevinPluginList(stdout: string): void {
  if (stdout.trim() !== 'No plugins installed.') {
    throw new Error('Devin has plugins or could not confirm an empty plugin list. Your thread is kept. Sotto currently requires Devin without plugins.')
  }
}


/** `mcp list` prints command/URL fields, which may contain secrets. Parse only
 * fixed structure, retain nothing, and never include the output in an error.
 * The pinned CLI marks disabled servers with U+2717; enabled servers use U+2022.
 */
export function verifyDevinMcpList(stdout: string): void {
  const text = stdout.trimEnd()
  if (/^No MCP servers configured\. Use 'devin(?:\.exe)? mcp add' to add servers\.$/u.test(text)) return
  const lines = text.split(/\r?\n/u)
  let servers = 0
  let details = 0
  let valid = lines.shift() === 'Configured MCP servers:'
  for (const line of lines) {
    if (line === '') continue
    if (/^ {2}\u2717 [^\r\n]+ \(disabled\)$/u.test(line)) {
      if (servers > 0 && details !== 1) valid = false
      servers++
      details = 0
    } else if (/^ {4}(?:Command|URL): [^\r\n]+$/u.test(line) && servers > 0) {
      details++
    } else valid = false
  }
  if (!valid || servers === 0 || details !== 1) {
    throw new Error('Devin has enabled MCP servers or could not confirm they are disabled. Your thread is kept. Disable native Devin MCP servers before reconnecting.')
  }
}

function nativeList(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  const configIndex = args.indexOf('--config')
  if (configIndex < 0 || !args[configIndex + 1] || !isAbsolute(args[configIndex + 1]!)) return Promise.reject(new Error('Devin integration checks require the Sotto approval profile. Your thread is kept.'))
  return new Promise((resolveOutput, reject) => {
    execFile(executable, [...args], { cwd, env: withCliPath(environment, executable), windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      // execFile errors retain stdout/stderr. Do not propagate them into logs.
      if (error || stderr.trim()) reject(new Error('Sotto could not check Devin integrations. Your thread is kept. Check the supported Devin installation and reconnect.'))
      else resolveOutput(stdout)
    })
  })
}

/** argsPrefix must include --config and the owned profile. Runs no model prompt. */
export async function assertDevinNoPlugins(executable: string, argsPrefix: readonly string[], environment: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
  verifyDevinPluginList(await nativeList(executable, [...argsPrefix, 'plugins', 'list'], environment, cwd))
}

/**
 * Waits for two checks running side by side, then throws the first one's refusal before the second's, so a
 * refusal names the same cause however the two finish.
 */
export async function settleInOrder<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const [a, b] = await Promise.allSettled([first, second])
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason
  return [a.value, b.value]
}

/**
 * Allow an empty native MCP registry or entries all explicitly disabled. The two lists are independent reads that
 * change nothing, so they run side by side and are judged plugins first (`settleInOrder`).
 */
export async function assertDevinNoIntegrations(executable: string, argsPrefix: readonly string[], environment: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
  const [, mcp] = await settleInOrder(
    assertDevinNoPlugins(executable, argsPrefix, environment, cwd),
    nativeList(executable, [...argsPrefix, 'mcp', 'list'], environment, cwd),
  )
  verifyDevinMcpList(mcp)
}

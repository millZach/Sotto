import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// This is Sotto's approval policy, not Devin's similarly named Normal mode.
// The pinned native compatibility experiment proves asks override the tested
// project grants even though ACP advertises accept-edits as its conversation mode.
const policy = {
  version: 1,
  permissions: { allow: [], deny: [], ask: ['edit', 'write', 'Write(**)', 'Write(/**)', 'exec', 'Fetch(*)', 'mcp__*'] },
  read_config_from: { agents_standard: false, cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false },
  hooks: {}, mcpServers: {}, auto_update: false, subagents_enabled: false,
}
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

function normalizedProfileMatches(config: Record<string, unknown>): boolean {
  if (!Object.entries(policy).every(([key, value]) => isDeepStrictEqual(config[key], value))) return false
  for (const [key, value] of Object.entries(config)) {
    if (Object.hasOwn(policy, key)) continue
    if (Object.hasOwn(normalizedRoutes, key)) { if (!isDeepStrictEqual(value, normalizedRoutes[key])) return false }
    else if (key === 'agent') {
      const agent = object(value)
      if (!agent || !isDeepStrictEqual(Object.keys(agent).sort(), ['model', 'preferred_family_models', 'show_history_on_continue', 'thinking', 'model_mixture', 'compaction_threshold_tokens', 'codex_tools'].sort())
        || agent.model !== null || !isDeepStrictEqual(agent.preferred_family_models, {}) || agent.model_mixture !== null
        || agent.compaction_threshold_tokens !== null || agent.codex_tools !== false || typeof agent.show_history_on_continue !== 'boolean') return false
      const thinking = object(agent.thinking)
      if (!thinking || Object.keys(thinking).length !== 1 || typeof thinking.mode !== 'string') return false
    } else if (!presentationFields.has(key) || (value !== null && !['string', 'boolean'].includes(typeof value))) return false
  }
  return true
}

const policyText = `${JSON.stringify(policy, null, 2)}\n`
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
  const workingDirectory = await realpath(cwd)
  let directory = workingDirectory
  while (true) {
    for (const name of nativeFiles) await rejectExisting(join(directory, '.devin', name))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  // Native settings can be discovered lazily below the working folder. Inspect
  // directories only, never contents. A linked directory could hide another
  // configuration tree, so the initial compatibility boundary excludes it.
  const directories = [workingDirectory]
  let directoryCount = 0
  let entryCount = 0
  while (directories.length) {
    if (++directoryCount > 25_000) throw new Error('This working folder is too large to check for native Devin configuration. Your thread is kept. Choose a smaller working folder.')
    const current = directories.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++entryCount > 250_000) throw new Error('This working folder is too large to check for native Devin configuration. Your thread is kept. Choose a smaller working folder.')
      if (entry.name === '.git') continue
      const path = join(current, entry.name)
      if (entry.name === '.devin') {
        for (const name of nativeFiles) await rejectExisting(join(path, name))
      }
      if (entry.isSymbolicLink()) {
        if ((await stat(path)).isDirectory()) throw new Error('This working folder has linked directories that Sotto cannot check for native Devin configuration. Your thread is kept. Use a working folder without linked directories.')
      } else if (entry.isDirectory()) directories.push(path)
    }
  }
}

/** A versioned, Sotto-owned profile; existing native user/project files are never changed. */
export async function prepareDevinPolicy(userDataDirectory: string, cwd?: string, configDirectory?: string): Promise<string> {
  await assertDevinWorkingDirectory(cwd, configDirectory)
  const path = resolve(userDataDirectory, 'devin', 'approval-policy-v1.json')
  let pending = preparing.get(path)
  if (!pending) {
    pending = (async () => {
      await mkdir(dirname(path), { recursive: true })
      try { await writeFile(path, policyText, { encoding: 'utf8', flag: 'wx', mode: 0o600 }) } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
      }
      if ((await lstat(path)).isSymbolicLink()) throw new Error('The Sotto approval profile for Devin has changed. Your thread is kept. Restore the profile before reconnecting Devin.')
      let existing: unknown
      try { existing = JSON.parse(await readFile(path, 'utf8')) } catch { /* Invalid profile is rejected below without logging its contents. */ }
      if (!isDeepStrictEqual(existing, policy)) {
        throw new Error('The Sotto approval profile for Devin has changed. Your thread is kept. Restore the profile before reconnecting Devin.')
      }
    })()
    preparing.set(path, pending)
  }
  try { await pending } finally { if (preparing.get(path) === pending) preparing.delete(path) }
  return path
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Receives the result of _cognition.ai/config/read, never a logged protocol body.
 * This confirms the user profile only; it does not report merged native policy.
 */
export function verifyDevinPolicy(result: unknown, path: string): void {
  const response = object(result)
  const config = object(response?.config)
  const matches = typeof response?.configPath === 'string' && isAbsolute(response.configPath)
    && resolve(response.configPath) === resolve(path)
    && config && normalizedProfileMatches(config)
  if (!matches) throw new Error('Devin did not confirm the Sotto approval profile. Your thread is kept. Reconnect with the supported Devin version.')
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
    execFile(executable, [...args], { cwd, env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
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

/** Allow an empty native MCP registry or entries all explicitly disabled. */
export async function assertDevinNoIntegrations(executable: string, argsPrefix: readonly string[], environment: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
  await assertDevinNoPlugins(executable, argsPrefix, environment, cwd)
  verifyDevinMcpList(await nativeList(executable, [...argsPrefix, 'mcp', 'list'], environment, cwd))
}

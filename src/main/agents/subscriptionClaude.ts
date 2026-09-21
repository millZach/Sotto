import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { SubscriptionAccount, SubscriptionClient } from './subscriptionTypes'

interface ClaudeSubscriptionOptions {
  executable?: string
  prefixArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  completionTimeoutMs?: number
  outputLimitBytes?: number
}
const REQUIRED_FLAGS = ['--safe-mode', '--tools', '--permission-prompts', '--no-session-persistence', '--input-format', '--output-format', '--system-prompt', '--model', '--effort', '--verbose']
const MODEL_ID = z.string().max(160).regex(/^[a-z0-9][a-z0-9._:/-]*(?:\[[a-z0-9]+\])?$/iu)
const NATIVE_MODEL = z.object({
  value: MODEL_ID, displayName: z.string().min(1).max(300),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.string().max(32).regex(/^[a-z][a-z0-9_-]*$/u)).max(30).optional(),
})
const INITIALIZED = z.object({ type: z.literal('control_response'), response: z.object({
  subtype: z.literal('success'), request_id: z.string(), response: z.object({ models: z.array(NATIVE_MODEL).min(1).max(300) }),
}) })
const AUTH = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional(), subscriptionType: z.string().nullable().optional() })
const RESULT = z.object({ type: z.literal('result'), is_error: z.boolean().optional(), result: z.string() })
// Keep native OS identity and networking, not provider keys, alternate account
// directories, Node injection flags, or cloud-provider routing overrides.
const ENVIRONMENT_KEYS = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'homedrive', 'homepath', 'home',
  'appdata', 'localappdata', 'xdg_config_home', 'xdg_cache_home', 'xdg_data_home',
  'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy',
  'ssl_cert_file', 'ssl_cert_dir', 'node_extra_ca_certs',
  // Preserve the user's native compaction policy without inventing defaults.
  'disable_auto_compact', 'disable_compact', 'claude_autocompact_pct_override', 'claude_code_auto_compact_window',
])

/** Runs the user's unmodified Claude CLI; OAuth credentials never enter Sotto. */
export class ClaudeSubscriptionClient implements SubscriptionClient {
  constructor(private readonly workingDirectory: string, private readonly options: ClaudeSubscriptionOptions = {}) {
    if (!isAbsolute(workingDirectory)) throw new Error('Claude reasoning needs an absolute working directory.')
  }

  async status(signal?: AbortSignal): Promise<SubscriptionAccount> { return (await this.inspect(signal)).account }

  async complete(system: string, input: unknown, model: string, effort?: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (model && !MODEL_ID.safeParse(model).success) throw new Error('Choose a valid Claude model before starting reasoning.')
    let prompt: string
    try { prompt = JSON.stringify(input) } catch { throw new Error('Claude reasoning needs a JSON-compatible request.') }
    if (!prompt || Buffer.byteLength(prompt) > 1_000_000 || system.length > 30_000) throw new Error('The Claude reasoning request is too large or invalid.')
    const { account, executable } = await this.inspect(signal)
    if (!account.ready || !executable) throw new Error(account.detail)
    const selectedModel = model || account.defaultModelId
    if (effort && !account.models.find(candidate => candidate.id === selectedModel)?.reasoningEfforts?.includes(effort)) {
      throw new Error('Claude Code does not report that reasoning effort for this model. Choose a supported effort or use the native default.')
    }
    const output = await this.run(executable, [
      '--print', '--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence',
      '--output-format', 'json', ...(selectedModel ? ['--model', selectedModel] : []), ...(effort ? ['--effort', effort] : []), '--system-prompt',
      `${system}\nReturn exactly one JSON object. Do not include Markdown or commentary outside that object.`,
    ], prompt, this.options.completionTimeoutMs ?? 180_000, signal)
    try {
      const envelope = RESULT.parse(JSON.parse(output))
      if (envelope.is_error) throw new Error('Provider reported failure')
      const result: unknown = JSON.parse(envelope.result)
      if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an object')
      return result
    } catch { throw new Error('Claude Code did not return a valid JSON decision. Check the selected model and subscription in Claude Code.') }
  }

  private async inspect(signal?: AbortSignal): Promise<{ account: SubscriptionAccount; executable: string | null }> {
    const executable = await this.findExecutable()
    const account: SubscriptionAccount = { provider: 'claude', label: 'Claude Code subscription', installed: Boolean(executable), ready: false,
      detail: 'Install Claude Code and sign in with your Claude subscription, then check the connection in Sotto.', models: [] }
    if (!executable) return { account, executable }
    try {
      await mkdir(this.workingDirectory, { recursive: true })
      const help = await this.run(executable, ['--help'], '', 10_000, signal)
      if (!REQUIRED_FLAGS.every(flag => help.includes(flag))) {
        account.detail = 'Update Claude Code to a version supporting safe mode and tool-free reasoning, then check the connection in Sotto.'
        return { account, executable }
      }
      const output = await this.run(executable, ['--safe-mode', 'auth', 'status', '--json'], '', 10_000, signal)
      const auth = AUTH.parse(JSON.parse(output))
      if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || !auth.subscriptionType) {
        account.detail = 'Sign in to Claude Code with your Claude subscription, then check the connection in Sotto. Sotto will not switch to API billing.'
        return { account, executable }
      }
      account.models = await this.models(executable, signal)
      if (account.models.some(model => model.id === 'default')) account.defaultModelId = 'default'
      account.allowCustomModel = true
      account.ready = true
      account.detail = 'Uses your signed-in Claude subscription. Its usage limits and account settings apply.'
    } catch {
      account.detail = 'Could not verify the Claude Code subscription and model list. Open Claude Code to check its sign-in, then check the connection in Sotto.'
    }
    return { account, executable }
  }

  private async models(executable: string, signal?: AbortSignal): Promise<SubscriptionAccount['models']> {
    const requestId = randomUUID()
    // Native control initialization is metadata only: no user message or model
    // turn is sent. EOF closes the unmodified CLI after it reports capabilities.
    const output = await this.run(executable, [
      '--print', '--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ], `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false } })}\n`, 15_000, signal)
    for (const line of output.split('\n')) {
      let message: unknown
      try { message = JSON.parse(line) } catch { continue }
      const parsed = INITIALIZED.safeParse(message)
      if (!parsed.success || parsed.data.response.request_id !== requestId) continue
      return parsed.data.response.response.models.map(model => ({
        id: model.value, name: model.displayName,
        reasoningEfforts: model.supportsEffort === false ? [] : [...(model.supportedEffortLevels ?? [])],
      }))
    }
    throw new Error('Claude Code did not report an available model catalog.')
  }

  async findExecutable(): Promise<string | null> {
    const environment = this.options.environment ?? process.env
    const path = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    const filename = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const candidates = this.options.executable ? [this.options.executable] : [
      join(homedir(), '.local', 'bin', filename),
      ...path.split(delimiter).map(directory => directory.replace(/^"|"$/gu, '')).filter(isAbsolute).map(directory => join(directory, filename)),
    ]
    for (const candidate of candidates) {
      if (!isAbsolute(candidate)) continue
      try {
        if (!(await stat(candidate)).isFile()) continue
        await access(candidate, constants.X_OK)
        return candidate
      } catch { /* Try the next user-installed native executable. */ }
    }
    return null
  }

  environment(): NodeJS.ProcessEnv {
    const filtered: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(this.options.environment ?? process.env)) {
      if (ENVIRONMENT_KEYS.has(key.toLowerCase()) && value !== undefined) filtered[key] = value
    }
    filtered.NO_COLOR = '1'
    return filtered
  }

  private run(executable: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(executable, [...(this.options.prefixArgs ?? []), ...args], {
          cwd: this.workingDirectory, env: this.environment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        reject(new Error('Could not start Claude Code. Check its installation and try again.'))
        return
      }
      let settled = false
      let failure: Error | null = null
      let terminationTimer: ReturnType<typeof setTimeout> | undefined
      let bytes = 0
      const chunks: Buffer[] = []
      const finish = (error: Error | null): void => {
        if (settled) return
        settled = true; clearTimeout(timer); clearTimeout(terminationTimer)
        signal?.removeEventListener('abort', stop)
        if (error) reject(error)
        else resolve(Buffer.concat(chunks).toString('utf8'))
      }
      const abort = (error: Error): void => {
        if (settled || failure) return
        failure = error
        clearTimeout(timer)
        // Wait for close after termination so callers cannot start another
        // inference or remove its working directory while this child is alive.
        try { child.kill('SIGKILL') } catch { /* The bounded cleanup below still applies. */ }
        terminationTimer = setTimeout(() => {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
          finish(error)
        }, 2_000)
      }
      const timer = setTimeout(() => abort(new Error('Claude Code did not finish in time. Check the native client before retrying.')), timeoutMs)
      const stop = () => abort(new Error('Sotto reasoning stopped.'))
      signal?.addEventListener('abort', stop, { once: true })
      const consume = (chunk: Buffer, stdout: boolean): void => {
        if (settled || failure) return
        bytes += chunk.length
        if (bytes > (this.options.outputLimitBytes ?? 256 * 1024)) { abort(new Error('Claude Code exceeded the reasoning output limit.')); return }
        if (stdout) chunks.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => consume(chunk, true))
      child.stderr.on('data', (chunk: Buffer) => consume(chunk, false))
      child.on('error', () => abort(new Error('Could not start Claude Code. Check its installation and try again.')))
      child.on('close', code => finish(failure ?? (code === 0 ? null : new Error('Claude Code could not complete the request. Check its subscription and usage limits in the native client.'))))
      child.stdin.on('error', () => abort(new Error('Claude Code could not receive the reasoning request.')))
      child.stdin.end(input)
    })
  }
}


import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, constants, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { SubscriptionAccount, SubscriptionClient } from './subscriptionTypes'

interface GrokSubscriptionOptions {
  executable?: string
  prefixArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  completionTimeoutMs?: number
  statusTimeoutMs?: number
  outputLimitBytes?: number
}
const IDENTIFIER = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:/-]*$/iu)
const EFFORT = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/u)
const SESSION = z.object({ sessionId: z.string().min(1).max(300), models: z.object({
  currentModelId: IDENTIFIER,
  availableModels: z.array(z.object({ modelId: IDENTIFIER, name: z.string().min(1).max(300), _meta: z.object({
    supportsReasoningEffort: z.boolean().optional(), reasoningEffort: EFFORT.optional(),
    reasoningEfforts: z.array(z.object({ id: EFFORT, value: EFFORT.optional(), default: z.boolean().optional() })).max(30).optional(),
  }).optional() })).min(1).max(300),
}), _meta: z.object({ 'x.ai/sessionConfig': z.object({ options: z.array(z.object({ id: z.string(), category: z.string(), selected: z.boolean().optional() })) }).optional() }).optional() })
const SAFE_ENVIRONMENT = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'homedrive', 'homepath',
  'appdata', 'localappdata', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'])
const CONNECTION_ERROR = 'Could not verify the Grok subscription. Open Grok and check its sign-in, then check the connection in Sotto. Sotto will not switch to API billing.'
async function removeSession(directory: string, parent: string): Promise<void> {
  if (dirname(resolve(directory)) !== resolve(parent)) throw new Error('Unexpected temporary Grok session directory.')
  await rm(directory, { recursive: true, force: true })
}

/** The native Grok process reads its own auth path; Sotto never reads or copies credentials. */
export class GrokSubscriptionClient implements SubscriptionClient {
  constructor(private readonly workingDirectory: string, private readonly options: GrokSubscriptionOptions = {}) {
    if (!isAbsolute(workingDirectory)) throw new Error('Grok reasoning requires an absolute isolated working directory.')
  }

  async status(): Promise<SubscriptionAccount> {
    const executable = await this.findExecutable()
    const account: SubscriptionAccount = { provider: 'grok', label: 'Grok subscription', installed: Boolean(executable), ready: false, models: [],
      detail: executable ? CONNECTION_ERROR : 'Install Grok CLI and sign in with your Grok subscription, then check the connection in Sotto.' }
    if (!executable) return account
    try {
      return await this.withSession(executable, this.options.statusTimeoutMs ?? 20_000, async (rpc, directory) => {
        const session = await this.initialize(rpc, directory)
        return this.account(session)
      })
    } catch { return account }
  }

  async complete(system: string, input: unknown, model: string, effort?: string): Promise<unknown> {
    if ((model && !IDENTIFIER.safeParse(model).success) || (effort && !EFFORT.safeParse(effort).success)) throw new Error('Choose a valid Grok model and reasoning effort.')
    let prompt: string
    try { prompt = JSON.stringify(input) } catch { throw new Error('Grok reasoning needs a JSON-compatible request.') }
    if (!prompt || Buffer.byteLength(prompt) > 1_000_000 || system.length > 30_000) throw new Error('The Grok reasoning request is too large or invalid.')
    const executable = await this.findExecutable()
    if (!executable) throw new Error('Install Grok CLI and sign in with your Grok subscription first.')
    return this.withSession(executable, this.options.completionTimeoutMs ?? 180_000, async (rpc, directory) => {
      const session = await this.initialize(rpc, directory, system)
      const account = this.account(session)
      const selectedModel = model || account.defaultModelId!
      const selected = account.models.find(candidate => candidate.id === selectedModel)
      if (!selected) throw new Error('Grok does not report this model in its subscription catalog. Check the connection and choose an available model.')
      if (effort && !selected.reasoningEfforts?.includes(effort)) throw new Error('Grok does not report that reasoning effort for this model. Choose a supported effort or use the native default.')
      rpc.sessionId = session.sessionId
      // Grok 1.0.5 session/new ignores agent --model. Its native ACP model
      // request applies model and effort together and publishes their exact values.
      const selectedResult = await rpc.request('session/set_model', { sessionId: session.sessionId, modelId: selectedModel, ...(effort ? { _meta: { reasoningEffort: effort } } : {}) })
      if (!z.object({ _meta: z.object({ model: z.object({ Ok: z.literal(selectedModel) }) }) }).safeParse(selectedResult).success) throw new Error('Grok did not select the requested model. Check the connection and try again.')
      await rpc.confirmSelection(selectedModel, effort)
      const result = await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] })
      if (!result || typeof result !== 'object' || (result as { stopReason?: string }).stopReason !== 'end_turn') throw new Error('Grok did not finish its reasoning response. Check its subscription and usage limits, then try again.')
      // Grok may deliver trailing response chunks just after the turn result.
      await rpc.drain()
      try {
        const value: unknown = JSON.parse(rpc.text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
        return value
      } catch { throw new Error('Grok did not return a valid JSON decision. Try again or choose another available Grok model.') }
    })
  }

  private async initialize(rpc: GrokRpc, directory: string, system = 'You are a text-only reasoning assistant. Return one JSON object and do not use tools.') {
    const initial = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'sotto', version: '1' } })
    const parsed = z.object({ protocolVersion: z.literal(1), authMethods: z.array(z.object({ id: z.string() })) }).parse(initial)
    if (!parsed.authMethods.some(method => method.id === 'cached_token') || parsed.authMethods.some(method => /api.?key/iu.test(method.id))) throw new Error(CONNECTION_ERROR)
    await rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } })
    return SESSION.parse(await rpc.request('session/new', { cwd: directory, mcpServers: [], _meta: {
      systemPromptOverride: `${system}\nReturn exactly one JSON object. Do not include Markdown or commentary outside it. Tools and all computer actions are unavailable in this reasoning session.`, yoloMode: false, autoMode: false,
      agentProfile: { name: 'sotto-reasoning', description: 'Text-only Sotto reasoning', injectDefaultTools: false, tools: [], permissionMode: 'dontAsk', discoverSkills: false, inheritSkills: false, agentsMd: false, mcpInheritance: 'none', hooks: {} },
    } }))
  }

  private account(session: z.infer<typeof SESSION>): SubscriptionAccount {
    const models = session.models.availableModels.map(model => {
      const reasoningEfforts = model._meta?.supportsReasoningEffort ? [...new Set(model._meta.reasoningEfforts?.map(effort => effort.value ?? effort.id) ?? [])] : []
      const defaultOption = model._meta?.reasoningEfforts?.find(effort => effort.default)
      const reportedDefault = model._meta?.reasoningEffort ?? defaultOption?.value ?? defaultOption?.id
      return { id: model.modelId, name: model.name, reasoningEfforts, ...(reportedDefault && reasoningEfforts.includes(reportedDefault) ? { defaultReasoningEffort: reportedDefault } : {}) }
    })
    if (!models.some(model => model.id === session.models.currentModelId)) throw new Error('Grok did not report its current model in the subscription catalog.')
    return { provider: 'grok', label: 'Grok subscription', installed: true, ready: true, models, defaultModelId: session.models.currentModelId, allowCustomModel: false,
      detail: 'Uses your signed-in Grok subscription. Its usage limits and existing account settings apply.' }
  }

  private async withSession<T>(executable: string, timeoutMs: number, work: (rpc: GrokRpc, directory: string) => Promise<T>): Promise<T> {
    await mkdir(this.workingDirectory, { recursive: true })
    const directory = await mkdtemp(join(this.workingDirectory, 'grok-'))
    const environment = this.options.environment ?? process.env
    const nativeHome = environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(homedir(), '.grok')
    const nativeAuthPath = environment.GROK_AUTH_PATH && isAbsolute(environment.GROK_AUTH_PATH) ? environment.GROK_AUTH_PATH : join(nativeHome, 'auth.json')
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(environment).filter(([key]) => SAFE_ENVIRONMENT.has(key.toLowerCase())))
    Object.assign(env, { GROK_HOME: join(directory, 'home'), GROK_AUTH_PATH: nativeAuthPath, GROK_DISABLE_API_KEY_AUTH: '1', GROK_DISABLE_AUTOUPDATER: '1',
      GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_WRITE_FILE: '0', GROK_WEB_FETCH: '0', GROK_TOOL_SEARCH: '0', GROK_LSP_TOOLS: '0', GROK_MANAGED_MCPS_ENABLED: '0',
      GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0', GROK_DEFAULT_SELECTED_PERMISSION: 'reject', GROK_REMEMBER_TOOL_APPROVALS: '0', GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0' })
    for (const vendor of ['CURSOR', 'CLAUDE']) for (const feature of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) env[`GROK_${vendor}_${feature}_ENABLED`] = '0'
    await mkdir(env.GROK_HOME!, { recursive: true })
    // This native marker suppresses automatic Claude settings/plugin import.
    // It applies only to the owned temporary Grok home, never the user's config.
    await writeFile(join(env.GROK_HOME!, 'config.toml'), '[claude_compat]\nimported = true\n', { mode: 0o600 })
    // Enforce inside Grok, before any session exists. ACP capabilities alone
    // do not cover native built-ins, and Grok's empty --tools is not a deny-all.
    // Native live canary: attempted terminal write returned permission denied;
    // the file was never created without any client-side tool interception.
    await writeFile(join(env.GROK_HOME!, 'requirements.toml'), '[permission]\nrules = [{ action = "deny", tool = "any" }]\n', { mode: 0o600 })
    const args = [...(this.options.prefixArgs ?? []), '--cwd', directory, '--tools', '', '--no-subagents', '--disable-web-search', '--permission-mode', 'dontAsk',
      '--deny', '*', 'agent', '--no-leader', 'stdio']
    let rpc: GrokRpc | undefined
    try {
      rpc = new GrokRpc(spawn(executable, args, { cwd: directory, env, shell: false, windowsHide: true, stdio: 'pipe' }), timeoutMs, this.options.outputLimitBytes ?? 2_000_000)
      return await work(rpc, directory)
    } finally {
      await rpc?.close()
      await removeSession(directory, this.workingDirectory)
    }
  }

  private async findExecutable(): Promise<string | null> {
    if (this.options.executable) return isAbsolute(this.options.executable) ? this.options.executable : null
    const environment = this.options.environment ?? process.env
    const nativeHome = environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(homedir(), '.grok')
    const name = process.platform === 'win32' ? 'grok.exe' : 'grok'
    const candidates = [join(nativeHome, 'bin', name), ...(environment.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, name))]
    for (const candidate of new Set(candidates)) { try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); return candidate } } catch { /* Native executable only; never invoke a shell wrapper. */ } }
    return null
  }
}

class GrokRpc {
  sessionId = ''
  text = ''
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>()
  private serial = 0
  private bytes = 0
  private buffer = ''
  private failed: Error | undefined
  private stopped = false
  private closing = false
  private readonly closed: Promise<void>
  private readonly timeout: ReturnType<typeof setTimeout>
  private lastTextAt = 0
  private selection: { model: string; effort: string | undefined } | undefined

  constructor(private readonly child: ChildProcessWithoutNullStreams, timeoutMs: number, private readonly limit: number) {
    this.closed = new Promise(resolve => child.once('close', () => { this.stopped = true; this.rejectAll(new Error('Grok closed before returning a reasoning response.')); resolve() }))
    this.timeout = setTimeout(() => this.fail(new Error('Grok reasoning timed out. Check its subscription and connection, then try again.')), timeoutMs)
    child.on('error', () => this.fail(new Error('Could not start the native Grok client.')))
    child.stdin.on('error', () => this.fail(new Error('The native Grok connection closed.')))
    child.stderr.on('data', (chunk: Buffer) => this.count(chunk.length))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (!this.count(Buffer.byteLength(chunk))) return
      this.buffer += chunk
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        if (line.trim()) this.receive(line)
      }
    })
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed || this.stopped || this.closing) return Promise.reject(this.failed ?? new Error('The native Grok connection closed.'))
    const id = ++this.serial
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ jsonrpc: '2.0', id, method, params }) })
  }
  async drain(): Promise<void> {
    do { await new Promise(resolve => setTimeout(resolve, 150)) } while (Date.now() - this.lastTextAt < 150 && !this.failed)
    if (this.failed) throw this.failed
  }
  async confirmSelection(model: string, effort: string | undefined): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !this.failed) {
      if (this.selection?.model === model && (!effort || this.selection.effort === effort)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (this.failed) throw this.failed
    throw new Error('Grok did not confirm the requested model and reasoning effort. Check the connection and try again.')
  }
  async close(): Promise<void> {
    this.closing = true
    clearTimeout(this.timeout)
    if (this.stopped) return
    this.child.stdin.end()
    this.child.kill()
    const force = setTimeout(() => this.child.kill('SIGKILL'), 1_000)
    try { await this.closed } finally { clearTimeout(force) }
  }
  private write(message: unknown): void { if (!this.stopped && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`) }
  private count(bytes: number): boolean {
    this.bytes += bytes
    if (this.bytes > this.limit) this.fail(new Error('Grok exceeded the response size limit.'))
    return !this.failed
  }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
  private fail(error: Error): void { if (!this.failed) this.failed = error; this.rejectAll(this.failed); this.child.kill() }
  private receive(line: string): void {
    let message: Record<string, unknown>
    try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message'); message = value as Record<string, unknown> } catch { this.fail(new Error('Grok sent an invalid protocol response.')); return }
    if (message.method && message.id !== undefined) {
      if (message.method === 'session/request_permission') this.write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
      else this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Computer actions are unavailable in Sotto reasoning.' } })
      this.fail(new Error('Grok requested a computer action during text-only reasoning. The action was denied.'))
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) { this.fail(new Error('Grok returned an unexpected protocol response.')); return }
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(CONNECTION_ERROR))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'session/update') {
      const params = message.params as { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } | undefined
      if (params?.sessionId !== this.sessionId) return
      if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text' && typeof params.update.content.text === 'string') { this.text += params.update.content.text; this.lastTextAt = Date.now() }
      if (params.update?.sessionUpdate === 'tool_call') this.fail(new Error('Grok attempted a tool call during text-only reasoning. The response was stopped.'))
    }
    if (message.method === '_x.ai/session_notification') {
      const params = message.params as { sessionId?: string; update?: { sessionUpdate?: string; model_id?: string; reasoning_effort?: string } } | undefined
      if (params?.sessionId === this.sessionId && params.update?.sessionUpdate === 'model_changed' && typeof params.update.model_id === 'string') {
        this.selection = { model: params.update.model_id, effort: params.update.reasoning_effort }
      }
    }
  }
}

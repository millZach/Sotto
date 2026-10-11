import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { z } from 'zod'

import { orderReasoningEfforts } from '../../shared/reasoningEfforts'
import type { SubscriptionAccount, SubscriptionClient } from './subscriptionTypes'
import { findCli, isDispatcher, withCliPath, type CliLookupOptions } from './cliLookup'

const UNAVAILABLE = 'Codex subscription request failed. Check Codex sign-in, model access and usage limits, then retry.'
const MAX_OUTPUT_BYTES = 1_048_576
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin',
  'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'goals', 'computer_use',
  'browser_use', 'browser_use_external', 'in_app_browser', 'in_app_local_automation',
  'image_generation', 'view_image', 'code_mode', 'code_mode_only', 'code_mode_host',
  'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'recommended_plugins',
  'sleep_tool', 'workspace_dependencies',
] as const

/**
 * What every one-off Codex call Sotto makes switches off, for reasoning and for side writing alike: every tool
 * and integration a turn could reach (skills and MCP through the orchestrator as well as directly), the
 * project's instruction files, web search and history. `notify` is emptied so the user's own turn-complete
 * program is never started and handed Sotto's prompt and the reply, and OpenTelemetry never logs the prompt.
 */
const isolationArguments = [
  ...DISABLED_FEATURES.map((name) => `features.${name}=false`),
  'features.skip_host_skill_discovery=true', 'web_search="disabled"',
  'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'orchestrator.skills.enabled=false', 'orchestrator.mcp.enabled=false',
  'project_doc_max_bytes=0', 'mcp_servers={}', 'instructions=""',
  'history.persistence="none"', 'notify=[]', 'otel.log_user_prompt=false',
  'model_provider="openai"', 'sandbox_mode="read-only"',
]
const configArguments = [...isolationArguments, 'approval_policy="on-request"'].flatMap((value) => ['-c', value])

const rpcMessage = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
const accountResult = z.object({ account: z.object({ type: z.string() }).passthrough().nullable() })
const modelResult = z.object({
  data: z.array(z.object({ model: z.string(), displayName: z.string(), hidden: z.boolean().optional(), isDefault: z.boolean().optional(),
    defaultReasoningEffort: z.string().optional(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional() })),
  nextCursor: z.string().nullable().optional(),
})

export function nativeEnvironment(): NodeJS.ProcessEnv {
  // Preserve native login discovery, OS/keychain access and the system proxy.
  // API keys, provider endpoint overrides and NODE_OPTIONS never enter the child.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|HOME|USER|LOGNAME|USERNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|TEMP|TMP|TMPDIR|CODEX_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|LANG|LC_ALL)$/i.test(key),
  ))
}

/**
 * The installed Codex binary, through the shared CLI lookup (ADR-0036). Codex is only ever started as its native
 * binary: a wrapper script, an npm JavaScript entry point or a `.cmd` shim is passed over, but the binary an
 * npm package or a version manager keeps is taken, and a found link is followed to it.
 */
export async function findExecutable(lookup: CliLookupOptions = {}): Promise<string | null> {
  const platform = lookup.platform ?? process.platform
  const windows = platform === 'win32'
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const triple = windows ? `${architecture === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
    : `${architecture === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`
  const packageName = `codex-${platform}-${architecture}`
  const executable = await findCli({
    name: 'codex',
    last: [join(lookup.home ?? homedir(), '.codex', 'bin')],
    // npm's layouts: the package beside a Windows prefix's commands, under `lib` beside a POSIX prefix's `bin`, or
    // beside the `node_modules/.bin` a local install links from. Only a folder named `bin` or `.bin` is looked above,
    // and never on Windows: a PATH folder just below a drive root would reach `C:\lib`, which any account may create.
    within: (directory, file) => (windows ? [join(directory, 'node_modules', '@openai')]
      : basename(directory) === 'bin' ? [join(dirname(directory), 'lib', 'node_modules', '@openai')]
        : basename(directory) === '.bin' && basename(dirname(directory)) === 'node_modules' ? [join(dirname(directory), '@openai')] : []).flatMap(scope => [
      join(scope, 'codex', 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', file),
      join(scope, packageName, 'vendor', triple, 'bin', file),
      join(scope, 'codex', 'vendor', triple, 'bin', file),
    ]),
    accept: candidate => nativeCodex(candidate, windows),
  }, lookup)
  return executable ?? null
}

/** The native binary a candidate is, or leads to: never a manager's shim, a shell script or a JavaScript entry point. */
async function nativeCodex(candidate: string, windows: boolean): Promise<string | undefined> {
  try {
    const executable = await realpath(candidate)
    if (isDispatcher(executable)) return undefined
    await access(executable, windows ? constants.F_OK : constants.X_OK)
    const file = await open(executable, 'r')
    const header = Buffer.alloc(4)
    try { await file.read(header, 0, header.length, 0) } finally { await file.close() }
    const native = windows ? header[0] === 0x4d && header[1] === 0x5a
      : ['7f454c46', 'cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(header.toString('hex'))
    return native ? executable : undefined
  } catch { return undefined }
}

/** One owned, bounded child. No shell, persistent daemon, retries or raw error output. */
function childOperation<T>(executable: string, args: string[], cwd: string, timeout: number,
  operation: (child: ChildProcessWithoutNullStreams, finish: (value: T) => void, fail: (detail?: string) => void) => (line: string) => void,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = nativeEnvironment(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = spawn(executable, args, { cwd, env: withCliPath(env, executable), windowsHide: true, shell: false, stdio: 'pipe' })
    let finishing = false
    let closed = false
    let result: T | undefined
    let rejected = false
    let failureDetail = UNAVAILABLE
    let reapTimer: ReturnType<typeof setTimeout> | undefined
    let buffer = ''
    let bytes = 0
    const settle = () => {
      clearTimeout(timer)
      clearTimeout(reapTimer)
      signal?.removeEventListener('abort', stop)
      if (rejected) reject(new Error(failureDetail))
      else resolve(result as T)
    }
    const finish = (value?: T, error = false) => {
      if (finishing) return
      finishing = true
      result = value
      rejected = error
      clearTimeout(timer)
      if (closed) { settle(); return }
      child.stdin.destroy()
      child.kill()
      // Windows terminates directly; Unix SIGTERM can be ignored. Do not return
      // or remove the temporary directory until this process actually closes.
      reapTimer = setTimeout(() => {
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }, 1_000)
    }
    const fail = (detail?: string) => {
      if (finishing) return
      if (detail) failureDetail = detail
      finish(undefined, true)
    }
    const stop = () => fail('Sotto reasoning stopped.')
    signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(fail, timeout)
    let consume: (line: string) => void
    try { consume = operation(child, (value) => finish(value), fail) } catch { fail(); return }
    child.on('error', () => fail())
    child.stdin.on('error', () => fail())
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_OUTPUT_BYTES) { fail(); return }
      buffer += chunk
      let newline: number
      while (!finishing && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) { try { consume(line) } catch { fail() } }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) fail() })
    child.on('close', () => {
      closed = true
      if (!finishing && buffer.trim()) { try { consume(buffer.trim()) } catch { fail() } }
      if (!finishing) fail()
      settle()
    })
  })
}

/**
 * A side call (ADR-0026) switches off everything the reasoning path does, and it matters more here because
 * the call runs in the thread's real project folder rather than an empty scratch one. Only the approval
 * policy differs: the shell tool is off as well as the sandbox being read-only, so there is nothing an
 * approval could be asked for and nobody is waiting to answer one.
 */
const sideWritingArguments = [...isolationArguments, 'approval_policy="never"'].flatMap((value) => ['-c', value])
const execEvent = z.object({ type: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }).passthrough().optional() }).passthrough()
/**
 * The items a side call may produce. `error` items are Codex's own warnings (an unknown model's metadata,
 * a feature still in development), said before the turn and harmless; every other kind is a tool.
 */
const SIDE_WRITING_ITEMS = new Set(['agent_message', 'reasoning', 'error'])

/**
 * Short text written by the user's own Codex on the thread's model, for Sotto's side writing (ADR-0026).
 * `codex exec --ephemeral` writes no session file, so neither Codex's own thread list nor the adapter's
 * session-log watcher can learn of the call, and the thread's app-server session is never asked anything.
 * The instruction and the material go in on stdin, never argv. The last agent message is the whole answer;
 * a tool item of any kind stops the call rather than being allowed to run.
 */
export function writeWithCodexExec(request: {
  executable: string; prefixArgs?: readonly string[]; codexHome: string
  instruction: string; material: string; model: string; effort?: string; workingDirectory: string; timeoutMs: number; signal?: AbortSignal
}): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,159}$/iu.test(request.model) || (request.effort !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/u.test(request.effort))) {
    return Promise.reject(new Error('Choose a valid Codex model before asking it to write.'))
  }
  const args = [...(request.prefixArgs ?? []), 'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never',
    '--cd', request.workingDirectory, '--model', request.model, ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []), ...sideWritingArguments, '-']
  return childOperation<string>(request.executable, args, request.workingDirectory, request.timeoutMs, (child, finish, fail) => {
    let text: string | undefined
    child.stdin.end(`${request.instruction}\n\n${request.material}`)
    return (line) => {
      const event = execEvent.parse(JSON.parse(line))
      if ((event.type === 'item.started' || event.type === 'item.completed') && event.item && !SIDE_WRITING_ITEMS.has(event.item.type)) { fail('Codex tried to use a tool while writing. Sotto stopped the call.'); return }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text
      if (event.type === 'turn.failed' || event.type === 'error') { fail(); return }
      if (event.type === 'turn.completed') { if (text === undefined) fail(); else finish(text) }
    }
  }, request.signal, { ...nativeEnvironment(), CODEX_HOME: request.codexHome })
}

/**
 * Native managed ChatGPT auth only. Sotto never reads/copies OAuth credentials.
 * Official protocol: https://learn.chatgpt.com/docs/app-server
 * Each decision uses an ephemeral thread with no execution environments,
 * configured MCP servers disabled, a read-only sandbox and denied callbacks.
 * Global AGENTS.md still applies. Account availability does not guarantee quota.
 */
export class CodexSubscriptionClient implements SubscriptionClient {
  constructor(private readonly workingDirectory: string) {}

  private account(ready: boolean, detail: string, installed = true, models: SubscriptionAccount['models'] = []): SubscriptionAccount {
    return { provider: 'codex', label: 'ChatGPT through Codex', installed, ready, detail, models }
  }

  private async session(signal?: AbortSignal): Promise<{ account: SubscriptionAccount }> {
    const executable = await findExecutable()
    if (!executable) return { account: this.account(false, 'Install the Codex CLI and sign in with ChatGPT to connect this subscription.', false) }
    if (!isAbsolute(this.workingDirectory)) throw new Error(UNAVAILABLE)
    await mkdir(this.workingDirectory, { recursive: true })
    const directory = this.workingDirectory
    return childOperation<{ account: SubscriptionAccount }>(executable, ['app-server', '--stdio', ...configArguments], directory, 20_000,
      (child, finish, fail) => {
        let nextId = 1
        let account = this.account(false, UNAVAILABLE)
        const catalog = new Map<string, SubscriptionAccount['models'][number]>()
        const cursors = new Set<string>()
        let defaultModelId: string | undefined
        let configuredModel: string | undefined
        const pending = new Map<number, (result: unknown) => void>()
        const request = (method: string, params: unknown, receive: (result: unknown) => void) => {
          const id = nextId++
          pending.set(id, receive)
          child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
        }
        const models = (cursor?: string) => request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, (result) => {
          const page = modelResult.parse(result)
          for (const model of page.data) {
            if (model.hidden) continue
            catalog.set(model.model, { id: model.model, name: model.displayName,
              ...(model.supportedReasoningEfforts ? { reasoningEfforts: orderReasoningEfforts(model.supportedReasoningEfforts.map((item) => item.reasoningEffort)) } : {}),
              ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
            })
            if (model.isDefault) defaultModelId = model.model
          }
          if (page.nextCursor) {
            if (cursors.has(page.nextCursor) || cursors.size >= 100) { fail('Codex model discovery did not complete. Refresh the account and retry.'); return }
            cursors.add(page.nextCursor)
            models(page.nextCursor)
          } else if (!catalog.size) finish({ account: this.account(false, 'Your Codex account does not currently advertise any available models.') })
          else {
            account = { ...this.account(true, 'Uses your ChatGPT subscription through Codex. Usage limits and account settings apply.', true, [...catalog.values()]),
              defaultModelId: defaultModelId ?? (configuredModel && catalog.has(configuredModel) ? configuredModel : undefined), allowCustomModel: false }
            finish({ account })
          }
        })
        request('initialize', { clientInfo: { name: 'sotto', title: 'Sotto subscription reasoning', version: '1.0' }, capabilities: { experimentalApi: true } }, () => {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
          request('config/read', { includeLayers: false, cwd: directory }, (result) => {
            const { config } = z.object({ config: z.object({
              model_provider: z.string(), model_providers: z.record(z.string(), z.unknown()).optional(),
              model: z.string().nullable().optional(),
              openai_base_url: z.string().nullable().optional(), chatgpt_base_url: z.string().nullable().optional(),
              mcp_servers: z.record(z.string(), z.unknown()).optional(),
            }).passthrough() }).parse(result)
            // Never send native account credentials to a custom provider endpoint.
            if (config.model_provider !== 'openai' || config.model_providers?.openai !== undefined
              || (config.openai_base_url && config.openai_base_url !== 'https://api.openai.com/v1')
              || (config.chatgpt_base_url && !['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/'].includes(config.chatgpt_base_url))) {
              finish({ account: this.account(false, 'Sotto subscription discovery requires the native official OpenAI provider without custom endpoints.') })
              return
            }
            configuredModel = config.model ?? undefined
            request('account/read', { refreshToken: false }, (result) => {
              const account = accountResult.parse(result).account
              if (account?.type !== 'chatgpt') finish({ account: this.account(false, 'Sign in to Codex with ChatGPT. API-key and externally supplied token accounts are not used by this subscription connection.') })
              else models()
            })
          })
        })
        return (line) => {
          const message = rpcMessage.parse(JSON.parse(line))
          if (message.method && message.id !== undefined) {
            // This client never grants permissions, answers interactive prompts,
            // or executes dynamic tools. Respond explicitly before stopping.
            const result = message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval' ? { decision: 'decline' }
              : message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
                : message.method === 'mcpServer/elicitation/request' ? { action: 'decline', content: null }
                  : message.method === 'item/tool/requestUserInput' || message.method === 'tool/requestUserInput' ? { answers: {} } : undefined
            child.stdin.write(JSON.stringify(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'Sotto reasoning does not execute tools.' } }) + '\n')
            fail('Codex requested an action or interactive permission. Sotto reasoning declined it; use the native agent for actions.')
            return
          }
          if (typeof message.id === 'number') {
            const receive = pending.get(message.id)
            if (!receive || message.error !== undefined) { fail(); return }
            pending.delete(message.id)
            receive(message.result)
            return
          }
        }
      }, signal)
  }

  async status(signal?: AbortSignal): Promise<SubscriptionAccount> {
    try { return (await this.session(signal)).account }
    catch { return this.account(false, UNAVAILABLE) }
  }

}

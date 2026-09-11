// @vitest-environment node
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodexSubscriptionClient } from '../../../src/main/agents/subscriptionCodex'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const roots: string[] = []
const model = 'gpt-5.6-luna'
type Rpc = { id?: number; method: string; params?: Record<string, unknown> }
type NativeModel = { model: string; displayName: string; hidden: boolean; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string; description: string }[] }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-codex-client-'))
  roots.push(root)
  const binary = join(root, process.platform === 'win32' ? 'codex.exe' : 'codex')
  await writeFile(binary, process.platform === 'win32' ? Buffer.from('MZ\0\0') : Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o700 })
  const cwd = join(root, 'reasoning')
  await mkdir(cwd)
  vi.stubEnv('PATH', root)
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key-never-forward')
  vi.stubEnv('CODEX_API_KEY', 'fixture-codex-key-never-forward')
  vi.stubEnv('OPENAI_BASE_URL', 'https://untrusted.invalid')
  vi.stubEnv('NODE_OPTIONS', '--require untrusted.js')
  const state = {
    version: 'codex-cli 0.153.4', account: { type: 'chatgpt', email: 'private-fixture@example.invalid' } as { type: string; email?: string } | null,
    models: [{ model, displayName: 'GPT-5.6 Luna', hidden: false, isDefault: true }] as NativeModel[], modelsPage2: [] as NativeModel[], config: { model_provider: 'openai' } as Record<string, unknown>,
    result: JSON.stringify({ json: JSON.stringify({ decision: 'human', text: 'Needs your preference.' }) }),
    isolation: true, tool: false, error: false, malformed: false, holdExit: false, hang: false, approval: '',
  }
  const requests: Rpc[] = []
  const responses: unknown[] = []
  const children: { args: string[]; cwd: string; started: boolean; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; closed: boolean }[] = []
  vi.mocked(spawn).mockImplementation(((executable: string, args: string[], options: { shell: boolean; windowsHide: boolean; env: NodeJS.ProcessEnv; cwd: string }) => {
    expect(executable).toBe(binary)
    expect(options.shell).toBe(false)
    expect(options.windowsHide).toBe(true)
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(options.env).not.toHaveProperty('CODEX_API_KEY')
    expect(options.env).not.toHaveProperty('OPENAI_BASE_URL')
    expect(options.env).not.toHaveProperty('NODE_OPTIONS')
    // This effect fixture speaks the native CLI/JSON-RPC protocols. It does not
    // replace account discovery, process lifecycle, JSON parsing or disk cleanup.
    const child = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const record = { args, cwd: options.cwd, started: false, stdout, stderr, kill: vi.fn(), closed: false }
    const emit = (value: unknown) => stdout.write(JSON.stringify(value) + '\n')
    const close = () => { if (!record.closed) { record.closed = true; child.emit('close', 0) } }
    record.kill.mockImplementation((signal?: string) => {
      if (!(state.holdExit && record.started && signal !== 'SIGKILL')) queueMicrotask(close)
      return true
    })
    let stdin = ''
    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdin += chunk.toString()
        if (args[0] === 'app-server') {
          let newline: number
          while ((newline = stdin.indexOf('\n')) >= 0) {
            const request = JSON.parse(stdin.slice(0, newline)) as Rpc
            stdin = stdin.slice(newline + 1)
            if (!request.method) { responses.push(request); continue }
            requests.push(request)
            queueMicrotask(() => {
              if (state.hang) return
              const result = request.method === 'initialize' ? {}
                : request.method === 'config/read' ? { config: state.config }
                  : request.method === 'account/read' ? { account: state.account }
                    : request.method === 'model/list' ? { data: request.params?.cursor ? state.modelsPage2 : state.models, nextCursor: !request.params?.cursor && state.modelsPage2.length ? 'second' : null }
                      : request.method === 'thread/start' ? { thread: { id: 'fixture-ephemeral', ephemeral: true }, model: request.params?.model, approvalPolicy: 'on-request', sandbox: { type: state.isolation ? 'readOnly' : 'dangerFullAccess', networkAccess: false } }
                        : request.method === 'turn/start' ? { turn: { id: 'fixture-turn', status: 'inProgress' } } : undefined
              if (result !== undefined) emit({ id: request.id, result })
              if (request.method === 'turn/start') {
                record.started = true
                expect(JSON.parse((request.params?.input as { text: string }[])[0]!.text)).toEqual({ request: 'fixture only' })
                const event = (method: string, item: unknown) => emit({ method, params: { threadId: 'fixture-ephemeral', item } })
                if (state.malformed) stdout.write('{invalid json\n')
                else if (state.approval) emit({ id: 'fixture-approval', method: state.approval, params: { threadId: 'fixture-ephemeral' } })
                else if (state.tool) event('item/started', { type: 'commandExecution', command: 'never execute' })
                else if (state.error) emit({ method: 'error', params: { error: { message: 'fixture-secret-never-display' } } })
                else {
                  event('item/completed', { type: 'agentMessage', phase: 'final_answer', text: state.result })
                  emit({ method: 'turn/completed', params: { threadId: 'fixture-ephemeral', turn: { status: 'completed' } } })
                }
              }
            })
          }
        }
        callback()
      },
    })
    if (args[0] === '--version') queueMicrotask(() => stdout.write(state.version + '\n'))
    children.push(record)
    return Object.assign(child, { stdin: writable, stdout, stderr, kill: record.kill })
  }) as unknown as typeof spawn)
  const client = new CodexSubscriptionClient(cwd)
  return { client, state, children, requests, responses, cwd, complete: () => client.complete('Return a decision JSON object.', { request: 'fixture only' }, '') }
}

beforeEach(() => { vi.mocked(spawn).mockReset() })
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-client-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('native Codex subscription client', () => {
  it('discovers every native model page and its reasoning efforts without a version or model allowlist', async () => {
    const f = await fixture()
    f.state.version = 'codex-cli 0.154.0'
    f.state.modelsPage2 = [{ model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium', description: 'Balanced' }] }]
    expect(await f.client.status()).toMatchObject({ ready: true, defaultModelId: 'gpt-5.5', models: [
      { id: model, name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', name: 'GPT-5.5', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium' },
    ] })
    expect(f.requests.filter((request) => request.method === 'model/list').map((request) => request.params?.cursor)).toEqual([undefined, 'second'])
  })

  it('dispatches the user-selected alternate model and reasoning effort', async () => {
    const f = await fixture()
    f.state.models.push({ model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium', description: 'Balanced' }] })
    await f.client.complete('Return a decision JSON object.', { request: 'fixture only' }, 'gpt-5.5', 'medium')
    expect(f.requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-5.5', effort: 'medium' })
  })

  it('uses the native default model and its default effort without silently downgrading an unsupported effort', async () => {
    const f = await fixture()
    f.state.modelsPage2 = [{ model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }] }]
    await f.complete()
    expect(f.requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-5.5', effort: 'medium' })
    f.requests.length = 0
    await expect(f.client.complete('Contract', {}, 'gpt-5.5', 'ultra')).rejects.toThrow('reasoning effort is not supported')
    expect(f.requests.some((request) => request.method === 'thread/start')).toBe(false)
  })

  it('uses a catalog-listed effective default and requires selection when Codex advertises no default', async () => {
    const f = await fixture()
    f.state.models.forEach((entry) => { entry.isDefault = false })
    f.state.config.model = model
    expect(await f.client.status()).toMatchObject({ defaultModelId: model })
    f.state.config.model = 'not-advertised'
    expect((await f.client.status()).defaultModelId).toBeUndefined()
    await expect(f.complete()).rejects.toThrow('Choose an available model')
    expect(f.requests.some((request) => request.method === 'thread/start')).toBe(false)
  })

  it.each([
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null }],
    ['item/tool/requestUserInput', { answers: {} }],
  ])('denies the native callback %s and stops the turn', async (method, result) => {
    const f = await fixture()
    f.state.approval = String(method)
    await expect(f.complete()).rejects.toThrow('declined')
    expect(f.responses).toEqual([{ id: 'fixture-approval', result }])
    expect(f.children.every((child) => child.closed)).toBe(true)
  })

  it('discovers available models without exposing account identifiers or native credentials', async () => {
    const f = await fixture()
    f.state.models.push({ model: 'gpt-5.5', displayName: 'Older model', hidden: false })
    expect(await f.client.status()).toMatchObject({ provider: 'codex', ready: true, installed: true, models: [{ id: model, name: 'GPT-5.6 Luna' }, { id: 'gpt-5.5', name: 'Older model' }] })
    expect(JSON.stringify(await f.client.status())).not.toContain('private-fixture')
    expect(f.requests.map((request) => request.method)).not.toContain('thread/start')
    expect(f.children.every((child) => child.closed)).toBe(true)
    expect(f.children.flatMap((child) => child.args).some((arg) => arg.startsWith('forced_login_method='))).toBe(false)
  })

  it.each([null, { type: 'apiKey' }, { type: 'chatgptAuthTokens' }])('rejects a non-managed ChatGPT account without changing its login: %j', async (account) => {
    const f = await fixture()
    f.state.account = account
    expect((await f.client.status()).ready).toBe(false)
    await expect(f.complete()).rejects.toThrow('Sign in to Codex with ChatGPT')
    expect(f.requests.some((request) => request.method === 'thread/start')).toBe(false)
    expect(f.requests.some((request) => /login|logout|model\/list/.test(request.method))).toBe(false)
  })

  it('rejects unlisted models and custom credential endpoints before inference', async () => {
    const f = await fixture()
    f.state.config.chatgpt_base_url = 'https://untrusted.invalid/backend-api/'
    expect((await f.client.status()).ready).toBe(false)
    expect(f.requests.some((request) => request.method === 'account/read' || request.method === 'model/list')).toBe(false)
    delete f.state.config.chatgpt_base_url
    await expect(f.client.complete('Contract', {}, 'gpt-5.5')).rejects.toThrow('model is no longer available')
    f.state.models = []
    expect((await f.client.status()).ready).toBe(false)
    expect(f.requests.some((request) => request.method === 'thread/start')).toBe(false)
  })

  it('uses an ephemeral thread without environments, disables every configured MCP, and validates the JSON envelope', async () => {
    const f = await fixture()
    f.state.config.mcp_servers = { fixture: { command: 'never-run' }, 'another.server': { command: 'never-run' } }
    expect(await f.complete()).toEqual({ decision: 'human', text: 'Needs your preference.' })
    const execution = f.children.find((child) => child.started)!
    expect(execution.args).toEqual(expect.arrayContaining(['features.code_mode_host=false', 'features.hooks=false', 'orchestrator.mcp.enabled=false', 'orchestrator.skills.enabled=false', 'skills.include_instructions=false']))
    expect(f.requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({ model, ephemeral: true, environments: [], dynamicTools: [], allowProviderModelFallback: false, config: { mcp_servers: { fixture: { enabled: false }, 'another.server': { enabled: false } } } })
    expect(f.requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({ environments: [], sandboxPolicy: { type: 'readOnly', networkAccess: false }, outputSchema: { required: ['json'] } })
    expect(execution.args).not.toContain('fixture only')
    expect(execution.closed).toBe(true)
    expect(await readdir(f.cwd)).toEqual([])
  })

  it.each(['tool', 'error', 'malformed', 'isolation'] as const)('fails closed and discards results on %s failures', async (mode) => {
    const f = await fixture()
    if (mode === 'isolation') f.state.isolation = false
    else f.state[mode] = true
    await expect(f.complete()).rejects.toThrow(mode === 'tool' ? 'attempted to use a tool' : 'Codex subscription request failed')
    expect(f.children.every((child) => child.closed)).toBe(true)
    expect(await readdir(f.cwd)).toEqual([])
  })

  it('rejects malformed decision JSON even when the native turn reports success', async () => {
    const f = await fixture()
    f.state.result = JSON.stringify({ json: 'not JSON' })
    await expect(f.complete()).rejects.toThrow('Codex subscription request failed')
  })

  it('waits for child exit before removing its directory or allowing a second inference, escalating ignored termination', async () => {
    const f = await fixture()
    f.state.holdExit = true
    let finished = false
    const completion = f.complete().then((result) => { finished = true; return result })
    await vi.waitFor(() => expect(f.children.find((child) => child.started)?.kill).toHaveBeenCalled(), { timeout: 500 })
    const execution = f.children.find((child) => child.started)!
    expect(await readdir(execution.cwd)).toEqual([])
    expect(await readdir(f.cwd)).toHaveLength(1)
    expect(finished).toBe(false)
    await expect(f.complete()).rejects.toThrow('already running')
    await completion
    expect(execution.kill).toHaveBeenCalledWith('SIGKILL')
    expect(execution.closed).toBe(true)
    expect(await readdir(f.cwd)).toEqual([])
  })

  it('bounds excessive child output and returns a secret-free unavailable status', async () => {
    const f = await fixture()
    f.state.hang = true
    const status = f.client.status()
    await vi.waitFor(() => expect(f.requests.some((request) => request.method === 'initialize')).toBe(true))
    f.children.at(-1)!.stderr.write(Buffer.alloc(1_048_577, 'x'))
    expect(await status).toMatchObject({ ready: false, detail: expect.not.stringContaining('fixture-secret') })
    expect(f.children.every((child) => child.closed)).toBe(true)
  })

  it('terminates a discovery that exceeds its deadline', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.state.hang = true
    const status = f.client.status()
    await vi.waitFor(() => expect(f.requests.some((request) => request.method === 'initialize')).toBe(true))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await status).toMatchObject({ ready: false })
    expect(f.children.every((child) => child.closed)).toBe(true)
  })
})

// @vitest-environment node
// Explicit no-spend check against an installed native Codex:
// SOTTO_NATIVE_CODEX_CONTRACT=1 npx vitest run tests/integration/subscriptionCodexNative.test.ts
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'

import { expect, it, vi } from 'vitest'

import { CodexSubscriptionClient } from '../../src/main/agents/subscriptionCodex'

const fixture = vi.hoisted(() => ({ home: '', endpoint: '' }))
vi.mock('node:child_process', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, spawn: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    if (args[0] !== 'app-server' || !fixture.endpoint) return native.spawn(executable, args, options)
    // Keep the real native protocol, model catalog, tool construction, hooks,
    // sandbox and inference. Only the external account/provider effects are
    // replaced: a dummy API login never leaves this isolated temporary profile.
    const child = native.spawn(executable, [...args,
      '-c', 'model_provider="sotto_contract"',
      '-c', `model_providers.sotto_contract={name="Local contract fixture",base_url="${fixture.endpoint}",wire_api="responses",requires_openai_auth=false}`,
    ], { ...options, env: { ...options.env, CODEX_HOME: fixture.home } })
    const methods = new Map<number, string>()
    const write = child.stdin!.write.bind(child.stdin!)
    child.stdin!.write = ((chunk: string) => {
      const request = JSON.parse(chunk) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (request.id !== undefined && request.method) methods.set(request.id, request.method)
      if (request.method === 'thread/start') request.params!.modelProvider = 'sotto_contract'
      return write(JSON.stringify(request) + '\n')
    }) as typeof child.stdin.write
    const stdout = child.stdout!
    const effectOutput = new PassThrough()
    let buffer = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number; result?: { config?: Record<string, unknown>; account?: unknown } }
        if (message.id !== undefined && message.result) {
          if (methods.get(message.id) === 'config/read') message.result.config!.model_provider = 'openai'
          if (methods.get(message.id) === 'account/read') message.result.account = { type: 'chatgpt' }
        }
        effectOutput.write(JSON.stringify(message) + '\n')
      }
    })
    stdout.on('end', () => effectOutput.end())
    Object.defineProperty(child, 'stdout', { value: effectOutput })
    return child
  } }
})

it.runIf(process.env.SOTTO_NATIVE_CODEX_CONTRACT === '1')('dispatches modern and previous models with effort, without native action tools, hooks, MCP or auth mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-codex-native-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-native-')) throw new Error('Unexpected native fixture directory')
  fixture.home = join(root, 'fixture-native-home')
  const workingDirectory = join(root, 'reasoning')
  const marker = join(root, 'unexpected-execution')
  const markerScript = join(root, 'marker.cjs')
  const apiLogin = JSON.stringify({ OPENAI_API_KEY: 'sk-sotto-invalid-contract-fixture' })
  const requests: { model: string; reasoning?: { effort: string }; tools?: { name?: string; type: string }[] }[] = []
  let credentialForwarded = false
  const text = JSON.stringify({ json: JSON.stringify({ decision: 'human', text: 'Native contract verified' }) })
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    credentialForwarded ||= request.headers.authorization !== undefined
    const message = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  try {
    await mkdir(fixture.home)
    await writeFile(markerScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
    await writeFile(join(fixture.home, 'auth.json'), apiLogin)
    await writeFile(join(fixture.home, 'config.toml'), [
      '[features]', 'hooks=true',
      '[mcp_servers.sotto_fixture]', `command=${JSON.stringify(process.execPath)}`, `args=[${JSON.stringify(markerScript)}]`,
    ].join('\n'))
    await writeFile(join(fixture.home, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${markerScript}"` }] }] } }))
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture server did not bind.')
    fixture.endpoint = `http://127.0.0.1:${address.port}`
    const client = new CodexSubscriptionClient(workingDirectory)
    for (const [model, effort] of [['gpt-5.6-sol', 'low'], ['gpt-5.5', 'medium']]) {
      expect(await client.complete('Return a decision object. Do not use tools.', { verification: 'local native contract' }, model!, effort!)).toEqual({ decision: 'human', text: 'Native contract verified' })
      const request = requests.at(-1)!
      expect(request).toMatchObject({ model, reasoning: { effort } })
      // Some older native model templates advertise this interactive tool. The
      // client explicitly denies it; no execution, file, network or MCP tool exists.
      expect((request.tools ?? []).every((tool) => tool.type === 'function' && tool.name === 'request_user_input')).toBe(true)
    }
    expect(requests).toHaveLength(2)
    expect(credentialForwarded).toBe(false)
    expect(await readdir(workingDirectory)).toEqual([])
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    // Real read-only discovery, with no JSON-RPC effect replacement, must reject
    // this pre-existing API login while preserving its exact bytes.
    fixture.endpoint = ''
    vi.stubEnv('CODEX_HOME', fixture.home)
    const status = await client.status()
    expect(status.ready).toBe(false)
    expect(status.detail).toContain('Sign in to Codex with ChatGPT')
    expect(await readFile(join(fixture.home, 'auth.json'), 'utf8')).toBe(apiLogin)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    vi.unstubAllEnvs()
    fixture.endpoint = ''
    server.closeAllConnections()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

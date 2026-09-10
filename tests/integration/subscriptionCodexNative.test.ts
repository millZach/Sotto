// @vitest-environment node
// Explicit no-spend contract check against an installed, signed-in Codex 0.153.4:
// SOTTO_NATIVE_CODEX_CONTRACT=1 npx vitest run tests/integration/subscriptionCodexNative.test.ts
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'

import { expect, it, vi } from 'vitest'

import { CodexSubscriptionClient } from '../../src/main/agents/subscriptionCodex'

const fixture = vi.hoisted(() => ({ home: '', endpoint: '' }))
vi.mock('node:child_process', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, spawn: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    // Keep the production client's actual native invocation. Replace only the
    // inference provider with an unauthenticated loopback HTTP effect fixture.
    if (args[0] !== 'exec' || !fixture.endpoint) return native.spawn(executable, args, options)
    return native.spawn(executable, [...args.slice(0, -1),
      '-c', 'model_provider="sotto_contract"',
      '-c', `model_providers.sotto_contract={name="Local contract fixture",base_url="${fixture.endpoint}",wire_api="responses",requires_openai_auth=false}`,
      '-',
    ], { ...options, env: { ...options.env, CODEX_HOME: fixture.home } })
  } }
})

it.runIf(process.env.SOTTO_NATIVE_CODEX_CONTRACT === '1')('verifies zero native tools, disabled configured hooks/MCP and preservation of an existing API login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-codex-native-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-native-')) throw new Error('Unexpected native fixture directory')
  fixture.home = join(root, 'fixture-native-home')
  const workingDirectory = join(root, 'reasoning')
  const marker = join(root, 'unexpected-execution')
  const markerScript = join(root, 'marker.cjs')
  const apiLogin = JSON.stringify({ OPENAI_API_KEY: 'sk-sotto-invalid-contract-fixture' })
  let responseRequests = 0
  let tools: unknown[] | undefined
  let credentialForwarded = false
  const text = JSON.stringify({ json: JSON.stringify({ decision: 'human', text: 'Native contract verified' }) })
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as { tools?: unknown[] }
    responseRequests++
    tools = payload.tools ?? []
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
    // Discovery uses the existing managed account. No live model turn is made:
    // only exec's external provider is redirected to the no-auth local fixture.
    expect((await client.status()).ready).toBe(true)
    expect(await client.complete('Return a decision object. Do not use tools.', { verification: 'local native contract' }, '')).toEqual({ decision: 'human', text: 'Native contract verified' })
    expect(responseRequests).toBe(1)
    expect(tools).toEqual([])
    expect(credentialForwarded).toBe(false)
    expect(await readdir(workingDirectory)).toEqual([])
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    // Read-only account discovery must leave a pre-existing API login untouched.
    // This is a deliberately invalid fixture key in a separate temporary home.
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
}, 30_000)

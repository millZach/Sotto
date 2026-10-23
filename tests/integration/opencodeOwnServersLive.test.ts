// @vitest-environment node
/**
 * The user's own model servers (ADR-0123) on OpenCode 2 itself. Never in CI: it needs OpenCode 2 installed. Run with
 *
 *   SOTTO_OPENCODE_LIVE=1 SOTTO_OPENCODE_EXECUTABLE=<path to opencode 2> npx vitest run tests/integration/opencodeOwnServersLive.test.ts
 *
 * Sotto's folder, HOME and USERPROFILE sit inside a temporary root, so no OpenCode data, config or sign-in of the user's is
 * used. The servers are a local OpenAI-compatible fake in the test, which writes down the key each request carried; the
 * key is made up.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OpenCodeHost } from '../../src/main/agents/opencode'
import { OpenCodeClient, locationQuery } from '../../src/main/agents/opencodeClient'
import { opencodeEnvironment, opencodeFolders, opencodePassword, OpenCodeServer } from '../../src/main/agents/opencodeServer'
import { openCodeForOwnServers } from '../../src/main/ownModelServers/openCode'
import { OwnServers } from '../../src/main/ownModelServers/service'
import { OWN_SERVER_PLACEHOLDER_KEY } from '../../src/main/ownModelServers/providerBlock'

const live = process.env.SOTTO_OPENCODE_LIVE === '1'
const KEY = 'made-up-own-server-key-live-3a9e'

/** An OpenAI-compatible server answering "hello", writing down the key and effort of each chat request. */
async function modelServer(): Promise<{ server: Server; address: string; chats: { auth: string | undefined; effort: unknown }[] }> {
  const chats: { auth: string | undefined; effort: unknown }[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ object: 'list', data: [{ id: 'm-think', owned_by: 'vllm', max_model_len: 32_768 }] })); return }
      const body = (raw ? JSON.parse(raw) : {}) as { model?: string; reasoning_effort?: unknown }
      chats.push({ auth: request.headers.authorization, effort: body.reasoning_effort })
      const chunk = (delta: unknown, finish: string | null): string => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(chunk({ role: 'assistant', content: 'hello' }, null)); response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, address: `http://127.0.0.1:${(server.address() as { port: number }).port}`, chats }
}

it.skipIf(!live)('lists a server under its name, signs its key in, sends the key and not the placeholder, and signs it out on remove', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-own-servers-live-'))
  const home = join(root, 'home'); await mkdir(home, { recursive: true })
  const environment = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') }
  const userData = join(root, 'sotto')
  const source = await modelServer()
  const executable = process.env.SOTTO_OPENCODE_EXECUTABLE
  // The host reads the record at each process start, which is only once both are made.
  const host: OpenCodeHost = new OpenCodeHost(userData, { ...(executable ? { executable } : {}), requestTimeoutMs: 60_000, environment, signInIdleMs: 500,
    ownServers: () => servers.list() })
  const servers = new OwnServers({ directory: userData, openCode: () => openCodeForOwnServers(host) })
  let observer: OpenCodeServer | undefined
  try {
    await host.connect()
    const plain = await servers.add({ name: 'Plain box', address: source.address, models: [{ id: 'm-think', name: 'Plain model', context: 32_768, thinking: false, images: false }] })
    if (plain.status !== 'ok') throw new Error(plain.message)
    const keyed = await servers.add({ name: 'Spark', address: source.address, key: KEY, models: [{ id: 'm-think', name: 'Thinking model', context: 32_768, thinking: true, images: true }] })
    if (keyed.status !== 'ok') throw new Error(keyed.message)
    // Each server is a model source of its own in the catalog, named as the user named it, with effort levels only when it thinks.
    const models = (await host.snapshot()).models
    expect(models.find(model => model.id === `${plain.server.id}/m-think`)).toMatchObject({ provider: 'OpenCode', source: 'Plain box', supportsImages: false })
    expect(models.find(model => model.id === `${plain.server.id}/m-think`)?.reasoningEfforts).toBeUndefined()
    expect(models.find(model => model.id === `${keyed.server.id}/m-think`)).toMatchObject({ source: 'Spark', supportsImages: true,
      reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' })
    // Neither shows among OpenCode's own model sources.
    const sources = await host.signIn.sources()
    expect(sources.status === 'ok' && sources.sources.some(item => item.id.startsWith('own-'))).toBe(false)

    // A process of the test's own on the same folder sends one request to each.
    const password = opencodePassword()
    const folders = opencodeFolders(join(userData, 'opencode'))
    const start = async (): Promise<OpenCodeClient> => {
      observer = await OpenCodeServer.start({ executable: executable ?? 'opencode', cwd: root, env: opencodeEnvironment(environment, folders, password, await servers.list()), timeoutMs: 60_000 })
      return new OpenCodeClient(observer.url, password, 60_000)
    }
    let client = await start()
    const generate = (providerID: string, variant?: string) => client.request('POST', '/api/experimental/generate',
      { query: locationQuery(folders.data), body: { prompt: 'Say hello.', model: { providerID, id: 'm-think', ...(variant ? { variant } : {}) } } })
    await generate(keyed.server.id, 'low')
    await generate(plain.server.id)
    expect(source.chats).toEqual([{ auth: `Bearer ${KEY}`, effort: 'low' }, { auth: `Bearer ${OWN_SERVER_PLACEHOLDER_KEY}`, effort: undefined }])
    await observer?.stop(); observer = undefined

    // Remove signs the key out of Sotto's OpenCode before the record goes.
    expect(await servers.remove({ id: keyed.server.id })).toEqual({ status: 'ok' })
    expect((await servers.list()).map(server => server.id)).toEqual([plain.server.id])
    expect((await host.snapshot()).models.some(model => model.id.startsWith(`${keyed.server.id}/`))).toBe(false)
    client = await start()
    const integrations = await client.request('GET', '/api/integration', { query: locationQuery(folders.data) }) as { data: { id: string; connections: unknown[] }[] }
    expect(integrations.data.find(item => item.id === keyed.server.id)).toBeUndefined()
    expect(JSON.stringify(integrations)).not.toContain('Spark')
  } finally {
    await observer?.stop()
    host.disconnect(); await host.closed()
    await new Promise(resolve => { source.server.closeAllConnections(); source.server.close(resolve) })
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

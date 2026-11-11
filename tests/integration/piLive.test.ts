// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PiHost } from '../../src/main/agents/pi'
import { handleOf } from '../fixtures/stagedImages'
import { ThreadToolServer } from '../../src/main/agents/threadToolServer'

const live = process.env.SOTTO_PI_LIVE === '1'
it.skipIf(!live)('runs Pi through the adapter: tools, streaming, MCP, stop, error and resume', { timeout: 600_000 }, async () => {
  const address = process.env.SOTTO_PI_SERVER
  const model = process.env.SOTTO_PI_MODEL
  if (!address || !model) throw new Error('Set SOTTO_PI_SERVER and SOTTO_PI_MODEL to a keyless server and its model.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-live-'))
  const project = join(root, 'project'); await mkdir(project)
  // Project-local Pi settings are ignored, but ordinary project instructions should be available.
  await writeFile(join(project, 'AGENTS.md'), 'For this probe, the secret project word is ORCHARD.\n')
  const options = { requestTimeoutMs: 60_000, servers: async () => [{ id: 'own-live', name: 'Live server', address, keyed: false,
    models: [{ id: model, name: model, context: 1_048_576, output: 4096, thinking: true, images: false }] }] }
  let calls = 0
  const mcp = new ThreadToolServer({ name: 'probe', serverName: 'probe', instructions: 'Call probe_echo to read the probe word.', unavailable: 'Unavailable', failed: 'Failed' },
    [{ name: 'probe_echo', description: 'Return the probe word.', inputSchema: { type: 'object', properties: {} } }], async () => {
      calls++; return { content: [{ type: 'text', text: 'PINEAPPLE' }] }
    })
  let host = new PiHost(join(root, 'sotto'), options)
  const tools = { name: 'probe', definitions: mcp.definitions, mcpServer: (id: string) => mcp.mcpServer(id) }
  const unavailable = { name: 'unavailable', definitions: [], mcpServer: async () => ({ name: 'unavailable', type: 'http' as const, url: 'http://127.0.0.1:9/mcp', headers: [] }) }
  host.useThreadTools([tools, unavailable])
  try {
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'project', title: 'Probe', path: project })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'project', modelId: `own-live/${model}`, reasoningEffort: 'low', title: 'Probe' })
    host.observeThreads([id])
    const thread = async () => (await host.snapshot()).threads.find(t => t.id === id)!
    const send = (text: string) => host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text })
    const settled = () => expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 250 }).toBe('idle')
    let streamed = 0
    const off = host.subscribeEvents(event => { if (event.event.kind === 'message-text-appended') streamed++ })
    expect(await send('Use bash to run printf hello-from-pi. Use write to put LIVE_OK in live.txt. Call the tool mcp__sotto__probe__probe_echo directly (do not use bash or curl to reach it) and put its word in probe.txt. Remember AMBER_37. Then reply with a short sentence.')).toEqual({ accepted: true })
    await settled()
    expect(await readFile(join(project, 'live.txt'), 'utf8')).toContain('LIVE_OK')
    expect(await readFile(join(project, 'probe.txt'), 'utf8')).toContain('PINEAPPLE')
    expect(calls).toBeGreaterThan(0)
    expect((await thread()).activities?.some(a => a.title === 'mcp__sotto__probe__probe_echo')).toBe(true)
    expect(streamed).toBeGreaterThan(0)
    expect((await thread()).activities?.some(a => a.kind === 'command')).toBe(true)
    await expect.poll(async () => (await thread()).usage?.contextUsed).toBeGreaterThan(0)
    expect((await thread()).usage?.latest?.output).toBeGreaterThan(0)
    off()
    await send('What is the secret project word from AGENTS.md? Reply with the word alone.')
    await settled()
    expect((await thread()).messages.at(-1)?.text).toContain('ORCHARD')
    // A long-running tool must settle when Stop is pressed.
    await send('Run sleep 60 with bash, then reply done.')
    await expect.poll(async () => (await thread()).activities?.some(a => a.kind === 'command' && a.status === 'running'), { timeout: 120_000, interval: 250 }).toBe(true)
    expect(await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })).toEqual({ accepted: true })
    await settled()
    expect((await thread()).lastTurn?.status).toBe('interrupted')
    await send('Write a long explanation of sorting algorithms without tools.')
    expect(await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })).toEqual({ accepted: true })
    await settled()
    expect((await thread()).lastTurn?.status).toBe('interrupted')
    host.disconnect(); await host.closed()
    host = new PiHost(join(root, 'sotto'), options); host.useThreadTools([tools]); host.observeThreads([id]); await host.connect()
    await send('What AMBER number did I ask you to remember? Reply only with the token.')
    await settled()
    expect((await thread()).messages.filter(m => m.role === 'assistant').map(m => m.text).join(' ')).toContain('AMBER_37')
  } finally { host.disconnect(); await host.closed(); await mcp.close(); if (process.env.SOTTO_PI_KEEP !== '1') await rm(root, { recursive: true, force: true }) }
})

it.skipIf(!live)('reports an unreachable model server as a failed turn after accepting the prompt', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-live-error-'))
  const host = new PiHost(root, { servers: async () => [{ id: 'own-unreachable', name: 'Unreachable', address: 'http://127.0.0.1:9/v1', keyed: false,
    models: [{ id: 'unreachable', name: 'Unreachable', context: 32768, thinking: false, images: false }] }] })
  try {
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'project', title: 'Probe', path: root })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'project', modelId: 'own-unreachable/unreachable', title: 'Probe' })
    await host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Say hello.' })
    await expect.poll(async () => (await host.snapshot()).threads[0]?.lastTurn?.status, { timeout: 60_000 }).toBe('failed')
    expect((await host.snapshot()).threads[0]?.activities?.some(a => a.kind === 'turn' && a.status === 'failed')).toBe(true)
  } finally { host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
})


// A real Pi process against a local OpenAI-compatible endpoint: verifies Pi's image transport without claiming model vision quality.
it.skipIf(!live)('passes a staged image through the installed Pi to an OpenAI-compatible endpoint', { timeout: 60_000 }, async () => {
  let imageSeen = false
  let shapes: unknown
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += String(chunk)
    const body = JSON.parse(text) as { messages: { content: { type?: string; image_url?: { url: string } }[] | string }[] }
    shapes = body.messages.map(message => ({ content: typeof message.content === 'string' ? 'string' : message.content.map(part => ({ type: part.type, image: part.image_url ? Object.keys(part.image_url) : [] })) }))
    imageSeen = imageSeen || body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url?.url.startsWith('data:image/')))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ id: 'image-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Image received.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local endpoint.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-image-'))
  const host = new PiHost(root, { servers: async () => [{ id: 'own-image', name: 'Image probe', address: `http://127.0.0.1:${address.port}/v1`, keyed: false,
    models: [{ id: 'image', name: 'Image', context: 32768, thinking: false, images: true }] }] })
  try {
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'project', title: 'Probe', path: root })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'project', modelId: 'own-image/image', title: 'Probe' })
    const imageBytes = await readFile(join(process.cwd(), 'src/renderer/src/assets/providers/hermes-black.png'))
    const image = handleOf(imageBytes, 'image-probe', 'Image.png')
    await host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Describe this.', attachments: [{ ...image, read: async () => imageBytes }] })
    await expect.poll(async () => (await host.snapshot()).threads[0]?.status).toBe('idle')
    expect(imageSeen, JSON.stringify(shapes)).toBe(true)
  } finally {
    host.disconnect(); await host.closed(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

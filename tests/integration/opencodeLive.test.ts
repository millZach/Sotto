// @vitest-environment node
/**
 * OpenCode 2 itself, on a scratch folder of its own (ADR-0087). Never in CI: it needs OpenCode 2 installed and reaches
 * OpenCode Zen's free models on opencode.ai. Run with
 *
 *   SOTTO_OPENCODE_LIVE=1 SOTTO_OPENCODE_EXECUTABLE=<path to opencode 2> npx vitest run tests/integration/opencodeLive.test.ts
 *
 * The adapter's own folder sits inside a temporary root, and HOME and USERPROFILE point inside it too, so no OpenCode data,
 * config or sign-in of the user's is used. The second case signs Sotto's folder in to a model source of its own: a local
 * OpenAI-compatible server in the test that records every request it is sent, so no real credentials are involved.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { BrowserAgentServer } from '../../src/main/agents/browserAgentServer'
import { OpenCodeHost } from '../../src/main/agents/opencode'
import { OpenCodeClient } from '../../src/main/agents/opencodeClient'
import { opencodeEnvironment, opencodeFolders, opencodePassword, OpenCodeServer } from '../../src/main/agents/opencodeServer'
import { VISUAL_MCP_SERVER, VisualToolServer, type VisualToolHandlers } from '../../src/main/agents/visualTools'
import { browserToolDefinitions } from '../../src/main/tools/browserAgentTools'

const live = process.env.SOTTO_OPENCODE_LIVE === '1'
const MODEL = process.env.SOTTO_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free'
/** A scratch home inside the test's root, so OpenCode reads nothing of the user's from theirs. */
async function scratchHome(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') }
}

it.skipIf(!live)('runs, asks, resumes and stops a thread on OpenCode 2 itself', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-live-'))
  const project = join(root, 'project')
  const events: string[] = []
  const options = { ...(process.env.SOTTO_OPENCODE_EXECUTABLE ? { executable: process.env.SOTTO_OPENCODE_EXECUTABLE } : {}), requestTimeoutMs: 60_000,
    environment: await scratchHome(root), log: (event: string) => events.push(event) }
  let host = new OpenCodeHost(join(root, 'sotto'), options)
  try {
    execFileSync('git', ['init', '-q', project]); await writeFile(join(project, 'README.md'), 'Live probe\n')
    execFileSync('git', ['-C', project, 'add', '.']); execFileSync('git', ['-C', project, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'probe'])
    const connected = await host.connect()
    expect(connected.models.find(model => model.id === MODEL)).toMatchObject({ provider: 'OpenCode', source: 'OpenCode Zen' })
    expect(connected.account).toContain('No model source signed in yet')
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Live', path: project })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', modelId: MODEL, title: 'Live probe', reasoningEffort: 'low' })
    host.observeThreads([id])
    const thread = async () => (await host.snapshot()).threads.find(candidate => candidate.id === id)!
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'hello', text: 'Reply with the word hello and nothing else.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 500 }).toBe('idle')
    expect((await thread()).messages.filter(message => message.role === 'assistant').map(message => message.text.toLowerCase()).join(' ')).toContain('hello')
    // A file edit asks under Ask for approval; a reject reaches the model as a failed tool call and the turn goes on.
    await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'edit', text: 'Create a file named probe.txt containing hi. Use your write tool.' })
    await expect.poll(async () => (await thread()).requests.length, { timeout: 120_000, interval: 500 }).toBe(1)
    const request = (await thread()).requests[0]!
    expect(request.kind).toBe('permission')
    await host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: false })
    await expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 500 }).toBe('idle')
    const before = (await thread()).messages.map(message => [message.id, message.role, message.text])
    // A new Sotto run reads the provider session back from OpenCode's history, with the same messages.
    host.disconnect(); await host.closed()
    host = new OpenCodeHost(join(root, 'sotto'), options)
    host.observeThreads([id]); await host.connect()
    await expect.poll(async () => (await thread()).messages.length, { timeout: 60_000, interval: 500 }).toBe(before.length)
    expect((await thread()).messages.map(message => [message.id, message.role, message.text])).toEqual(before)
    // A long answer is stopped.
    await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'long', text: 'Write the numbers from 1 to 400 in words, one per line.' })
    await expect.poll(async () => (await thread()).status, { timeout: 60_000, interval: 250 }).toBe('running')
    // Stop lands on a turn that is streaming: the model has begun its answer.
    await expect.poll(async () => (await thread()).messages.some(message => message.role === 'assistant' && /one/iu.test(message.text) && !before.some(([id]) => id === message.id)), { timeout: 120_000, interval: 100 }).toBe(true)
    expect(await host.execute({ type: 'interrupt', threadId: id, commandId: randomUUID() })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).lastTurn?.status, { timeout: 60_000, interval: 250 }).toBe('interrupted')
    expect(events.every(event => /^opencode-server-[a-z]+$/u.test(event))).toBe(true)
  } finally {
    host.disconnect(); await host.closed()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

/** What the local model source was sent, one record per request. */
interface ModelRequest { readonly tools: readonly string[]; readonly hasTools: boolean; readonly texts: readonly string[]; readonly roles: readonly string[] }
/**
 * A local OpenAI-compatible model source: it answers in words, calls Sotto's visual tool when a prompt asks for it by the
 * name it was offered, and records what each request carried.
 */
async function localModelSource(): Promise<{ server: Server; url: string; requests: ModelRequest[] }> {
  const requests: ModelRequest[] = []
  const textOf = (message: { content?: unknown }): string => typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map(part => (part as { text?: string }).text ?? '').join(' ') : ''
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as { messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] }
      const messages = body.messages ?? []
      const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '')
      requests.push({ tools, hasTools: 'tools' in body, texts: messages.map(textOf), roles: messages.map(message => message.role) })
      const last = messages.at(-1)
      const chunk = (delta: unknown, finish: string | null): string => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const visualize = tools.find(name => name === `${VISUAL_MCP_SERVER}_visualize`)
      if (last?.role === 'user' && /CALL SOTTO VISUAL/u.test(textOf(last)) && visualize) {
        const args = { title: 'Live visual', kind: 'diagram', source: 'flowchart LR\n  A[Draft] --> B[Sent]', steps: [{ text: 'A draft is sent.' }] }
        response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: visualize, arguments: JSON.stringify(args) } }] }, null))
        response.write(chunk({}, 'tool_calls'))
      } else {
        response.write(chunk({ role: 'assistant', content: last?.role === 'tool' ? 'Drawn.' : 'Local title' }, null))
        response.write(chunk({}, 'stop'))
      }
      response.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'local-model', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The local model source did not start.')
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests }
}

it.skipIf(!live)('gives a thread Sotto’s tools, and writes side text that lists no provider session and offers no tools, on OpenCode 2 itself', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-live-'))
  const project = join(root, 'project'), userData = join(root, 'sotto')
  const environment = await scratchHome(root)
  const source = await localModelSource()
  // Sotto's own OpenCode folder signed in to the local source, as the user signing in inside it would leave it.
  const folders = opencodeFolders(join(userData, 'opencode'))
  await mkdir(join(folders.config, 'opencode'), { recursive: true })
  await writeFile(join(folders.config, 'opencode', 'opencode.json'), JSON.stringify({ providers: { local: { name: 'Local Source', package: '@opencode/ai/providers/openai-compatible',
    settings: { apiKey: 'not-a-key', baseURL: source.url }, models: { 'local-model': { name: 'Local Model', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 100_000, output: 4_000 } } } } } }))
  const executable = process.env.SOTTO_OPENCODE_EXECUTABLE
  const host = new OpenCodeHost(userData, { ...(executable ? { executable } : {}), requestTimeoutMs: 60_000, environment })
  const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] }))
  const add = vi.fn<VisualToolHandlers['add']>(async (_threadId, input) => ({ added: true, visual: { id: 'v1', title: input.title, kind: input.kind, source: input.source }, anchor: 'assistant' }))
  const visuals = new VisualToolServer({ enabled: () => true, admits: () => true, add })
  host.useBrowserTools(browser); host.useThreadTools([visuals])
  let observer: OpenCodeServer | undefined
  try {
    execFileSync('git', ['init', '-q', project]); await writeFile(join(project, 'README.md'), 'Live probe\n')
    execFileSync('git', ['-C', project, 'add', '.']); execFileSync('git', ['-C', project, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'probe'])
    const connected = await host.connect()
    expect(connected.models.find(model => model.id === 'local/local-model')).toMatchObject({ source: 'Local Source' })
    expect(connected.account).toBe('Signed in to Local Source')
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Live', path: project })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', modelId: 'local/local-model', title: 'Live tools' })
    host.observeThreads([id])
    const thread = async () => (await host.snapshot()).threads.find(candidate => candidate.id === id)!
    // Under Ask for approval the model is offered Sotto's tools by name, and calls one with no prompt of OpenCode's.
    await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'draw', text: 'CALL SOTTO VISUAL now.' })
    await expect.poll(async () => add.mock.calls.length, { timeout: 120_000, interval: 500 }).toBe(1)
    await expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 500 }).toBe('idle')
    const offered = source.requests.find(request => request.texts.some(text => text.includes('CALL SOTTO VISUAL')))!.tools
    expect(offered).toEqual(expect.arrayContaining([`${VISUAL_MCP_SERVER}_visualize`, ...browserToolDefinitions.map(tool => `sotto_browser_${tool.name}`)]))
    expect(add).toHaveBeenCalledWith(id, expect.objectContaining({ title: 'Live visual' }))
    expect((await thread()).requests).toEqual([])
    expect((await thread()).sottoToolsWithheld).toBeUndefined()

    // A server of the test's own on the same folder lists the provider sessions before and after each side call.
    const password = opencodePassword()
    observer = await OpenCodeServer.start({ executable: executable ?? 'opencode', cwd: project, env: opencodeEnvironment(environment, folders, password), timeoutMs: 60_000 })
    const client = new OpenCodeClient(observer.url, password, 60_000)
    const sessions = async (): Promise<string[]> => ((await client.request('GET', '/api/session')) as { data: { id: string }[] }).data.map(session => session.id).sort()
    const before = await sessions()
    expect(before).toHaveLength(1)
    const asked = source.requests.length
    const prompt = { instruction: 'Name this coding conversation in a few words.', material: 'First message:\nLive side-writing marker 5d2e' }
    await expect(host.writeShortText(id, prompt)).resolves.toBe('Local title')
    // (1) It made no provider session: the list is the same before and after.
    const afterSide = await sessions()
    expect(afterSide).toEqual(before)
    // (2) The one model request it caused offered the model no tools, and carried only the side call's words.
    const side = source.requests.slice(asked)
    expect(side).toHaveLength(1)
    expect(side[0]!.texts.join('\n')).toContain('Live side-writing marker 5d2e')
    expect(side[0]!.hasTools).toBe(false)
    expect(side[0]!.roles).toEqual(['user'])

    // OpenCode Zen's free models refuse the route: nothing is written, and no session is made for the call.
    const zen = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: zen, projectId: 'live', modelId: MODEL, title: 'Live Zen', reasoningEffort: 'low' })
    const withZen = await sessions()
    await expect(host.writeShortText(zen, prompt)).resolves.toBeNull()
    expect(await sessions()).toEqual(withZen)
    // What the run showed, for the verification record, when asked for: no token, key or prompt is in it.
    if (process.env.SOTTO_OPENCODE_LIVE_EVIDENCE) await writeFile(process.env.SOTTO_OPENCODE_LIVE_EVIDENCE, JSON.stringify({ version: connected.version, offered,
      sessionsBefore: before, sessionsAfterSideCall: afterSide, sessionsAroundZenCall: withZen, sideRequest: { hasTools: side[0]!.hasTools, roles: side[0]!.roles },
      zenWrote: null, visualCalls: add.mock.calls.length, requestsShown: (await thread()).requests.length }, null, 2))
  } finally {
    await observer?.stop()
    host.disconnect(); await host.closed()
    await browser.close(); await visuals.close()
    await new Promise<void>(resolve => { source.server.close(() => resolve()); source.server.closeAllConnections() })
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

it.skipIf(!live)('allows Sotto’s browser tools on a thread given only the browser’s server, once OpenCode 2 itself has connected it', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-live-'))
  const project = join(root, 'project'), userData = join(root, 'sotto')
  const environment = await scratchHome(root)
  const executable = process.env.SOTTO_OPENCODE_EXECUTABLE
  const host = new OpenCodeHost(userData, { ...(executable ? { executable } : {}), requestTimeoutMs: 60_000, environment })
  // Only the browser's server: OpenCode answers its add before it has connected it, and no second server's add hides that.
  const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] }))
  host.useBrowserTools(browser)
  let observer: OpenCodeServer | undefined
  try {
    execFileSync('git', ['init', '-q', project]); await writeFile(join(project, 'README.md'), 'Live probe\n')
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Live', path: project })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', modelId: MODEL, title: 'Live browser only' })
    host.observeThreads([id])
    // A server of the test's own on the same folder reads the provider session's rule set as OpenCode holds it.
    const password = opencodePassword()
    observer = await OpenCodeServer.start({ executable: executable ?? 'opencode', cwd: project, env: opencodeEnvironment(environment, opencodeFolders(join(userData, 'opencode')), password), timeoutMs: 60_000 })
    const client = new OpenCodeClient(observer.url, password, 60_000)
    const rules = async (): Promise<{ action: string; effect: string }[]> => {
      const listed = ((await client.request('GET', '/api/session')) as { data: { id: string; title?: string }[] }).data.find(session => session.title === 'Live browser only')
      if (!listed) return []
      return ((await client.request('GET', `/api/session/${listed.id}`)) as { data: { permissions?: { action: string; effect: string }[] } }).data.permissions ?? []
    }
    const browserAllows = browserToolDefinitions.map(tool => `sotto_browser_${tool.name}`)
    // The mode's own rules are there from the start; the allows join them once the server is connected.
    await expect.poll(async () => (await rules()).map(rule => `${rule.action} ${rule.effect}`), { timeout: 60_000, interval: 500 })
      .toEqual(expect.arrayContaining(['shell ask', ...browserAllows.map(action => `${action} allow`)]))
    expect((await host.snapshot()).threads.find(candidate => candidate.id === id)!.sottoToolsWithheld).toBeUndefined()
  } finally {
    await observer?.stop()
    host.disconnect(); await host.closed()
    await browser.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

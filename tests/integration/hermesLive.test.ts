// @vitest-environment node
// Explicit opt-in only. Small requests to the supplied server; no subscription sign-in.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HermesAcpHost } from '../../src/main/agents/hermes'
import { ThreadToolServer } from '../../src/main/agents/threadToolServer'
import type { AgentHostSnapshot } from '../../src/shared/agents'

it.skipIf(process.env.SOTTO_HERMES_LIVE !== '1')('codes, calls HTTP MCP, hot-adds a project, steers, cancels and resumes through Hermes', { timeout: 360_000 }, async () => {
  const address = process.env.SOTTO_HERMES_SERVER, model = process.env.SOTTO_HERMES_MODEL
  if (!address || !model) throw new Error('Supply SOTTO_HERMES_SERVER and SOTTO_HERMES_MODEL.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-hermes-live-')), project = join(root, 'project')
  await mkdir(project)
  const options = { ...(process.env.SOTTO_HERMES_EXECUTABLE ? { executable: process.env.SOTTO_HERMES_EXECUTABLE } : {}), requestTimeoutMs: 90_000, startTimeoutMs: 90_000,
    servers: async () => [{ id: 'own-live', name: 'Live server', address, keyed: false,
      models: [{ id: model, name: model, context: 131072, thinking: true, images: false }] }] }
  let host = new HermesAcpHost(join(root, 'sotto'), options)
  let calls = 0
  const server = new ThreadToolServer({ name: 'sotto_probe', serverName: 'Sotto probe', instructions: 'A local test tool.', unavailable: 'Unavailable', failed: 'Failed' },
    [{ name: 'ping', description: 'Return the test value PONG.', inputSchema: { type: 'object', properties: {} } }],
    async () => { calls++; return { content: [{ type: 'text', text: 'PONG' }] } })
  const tools = [{ name: 'sotto_probe', definitions: server.definitions, mcpServer: (id: string) => server.mcpServer(id) }]
  host.useThreadTools(tools)
  const waitFor = async (predicate: (snapshot: AgentHostSnapshot) => boolean): Promise<void> => {
    if (predicate(await host.snapshot())) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Hermes live check timed out.')) }, 90_000)
      const unsubscribe = host.subscribe(snapshot => { if (predicate(snapshot)) { clearTimeout(timer); unsubscribe(); resolve() } })
    })
  }
  const idle = (id: string) => waitFor(s => s.threads.some(t => t.id === id && (t.status === 'idle' || t.status === 'error')))
  const create = async (projectId: string, path: string) => {
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: projectId, path })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId, title: 'Hermes live check', modelId: `own-live/${model}`, runtimeMode: 'full-access' })
    host.observeThreads([id])
    return id
  }
  try {
    const started = Date.now()
    expect((await host.connect()).models.map(m => m.id)).toContain(`own-live/${model}`)
    const id = await create('first', project)
    console.log(JSON.stringify({ check: 'gateway-session', passed: true }))
    const send = (text: string) => host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text })
    expect(await send('Create answer.py containing a function add(a, b) that returns their sum. Run python3 to import it and assert add(2, 3) == 5. Then call the ping tool from the sotto_probe MCP server. Reply briefly when both succeed.')).toEqual({ accepted: true })
    await idle(id)
    expect(await readFile(join(project, 'answer.py'), 'utf8')).toContain('def add')
    expect(calls).toBeGreaterThan(0)
    const completed = (await host.snapshot()).threads.find(t => t.id === id)!
    expect(completed.status).toBe('idle')
    expect(completed.messages.some(m => m.role === 'assistant')).toBe(true)
    console.log(JSON.stringify({ check: 'live-reasoning', observed: completed.activities?.some(a => a.kind === 'reasoning') ?? false }))
    console.log(JSON.stringify({ check: 'coding-streaming-http-mcp', seconds: (Date.now() - started) / 1000, calls }))

    // A project created after gateway start must join that same gateway.
    const second = join(root, 'second'); await mkdir(second)
    await create('second', second)
    console.log(JSON.stringify({ check: 'hot-add-project', passed: true }))
    host.observeThreads([id])
    expect(await send('Use the terminal tool to run python3 -c "import time; time.sleep(5)". Then reply done.')).toEqual({ accepted: true })
    await waitFor(s => s.threads.some(t => t.id === id && t.activities?.some(a => a.kind === 'command' && a.status === 'running')))
    expect(await host.execute({ type: 'steer', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'After the command, reply STEERED.' })).toEqual({ accepted: true })
    await idle(id)
    expect((await host.snapshot()).threads.find(t => t.id === id)?.messages.some(m => m.role === 'assistant' && m.text.includes('STEERED'))).toBe(true)
    console.log(JSON.stringify({ check: 'steer', passed: true }))
    expect(await send('Use the terminal tool to run python3 -c "import time; time.sleep(20)". Then reply done.')).toEqual({ accepted: true })
    await waitFor(s => s.threads.some(t => t.id === id && t.activities?.some(a => a.kind === 'command' && a.status === 'running')))
    const cancelling = Date.now()
    expect(await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })).toEqual({ accepted: true })
    await idle(id)
    expect((await host.snapshot()).threads.find(t => t.id === id)?.lastTurn?.status).toBe('interrupted')
    console.log(JSON.stringify({ check: 'cancel-mid-tool', passed: true, seconds: (Date.now() - cancelling) / 1000 }))

    host.disconnect(); await host.closed()
    host = new HermesAcpHost(join(root, 'sotto'), options); host.useThreadTools(tools); host.observeThreads([id])
    await host.connect()
    expect(await send('Call the ping tool from sotto_probe again, then reply RESUMED.')).toEqual({ accepted: true })
    await idle(id)
    expect(calls).toBeGreaterThan(1)
    expect((await host.snapshot()).threads.find(t => t.id === id)?.messages.some(m => m.role === 'assistant' && m.text.includes('RESUMED'))).toBe(true)
    console.log(JSON.stringify({ check: 'resume-http-mcp', passed: true, totalSeconds: (Date.now() - started) / 1000 }))
    if (process.env.SOTTO_HERMES_REFUSELESS_LIVE === '1') {
      const rf = randomUUID(), rfStarted = Date.now()
      expect((await host.snapshot()).models.some(m => m.id === 'own-refuseless/glm-5.3-flash-abliterated')).toBe(true)
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: rf, projectId: 'first', title: 'Refuseless live check',
        modelId: 'own-refuseless/glm-5.3-flash-abliterated', runtimeMode: 'full-access' })
      host.observeThreads([rf])
      expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: rf,
        text: 'Write refuseless_check.py in this project with a function double(x) returning x * 2. Run python3 to import it and assert double(3) == 6. Reply REFUSELESS_OK once it passes.' })).toEqual({ accepted: true })
      await idle(rf)
      expect(await readFile(join(project, 'refuseless_check.py'), 'utf8')).toContain('def double')
      const finished = (await host.snapshot()).threads.find(t => t.id === rf)
      expect(finished?.status).toBe('idle')
      expect(finished?.messages.some(m => m.role === 'assistant' && m.text.includes('REFUSELESS_OK'))).toBe(true)
      console.log(JSON.stringify({ check: 'refuseless-folder-reasoning-no-title', passed: true, seconds: (Date.now() - rfStarted) / 1000 }))
    }
  } finally {
    host.disconnect(); await host.closed(); await server.close()
    console.log(JSON.stringify({ check: 'cleanup', root }))
  }
})

// @vitest-environment node
/**
 * What a Claude thread does, checked on Google's own `agy` (docs/research/2026-11-21-antigravity-claude-parity.md). Never
 * in CI: it needs `agy` 1.5 or newer and a Google sign-in, and spends a dozen short turns on that account. Run as
 * antigravityLive.test.ts is run, with the same three variables, plus SOTTO_ANTIGRAVITY_LIVE_REPORT for a report file.
 * Each check records what it saw and carries on, so one failure does not hide the rest; the test fails if any failed.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { AntigravityAcpHost } from '../../src/main/agents/antigravity'
import { ThreadToolServer } from '../../src/main/agents/threadToolServer'
import { promptImageOf } from '../fixtures/stagedImages'

const live = process.env.SOTTO_ANTIGRAVITY_LIVE === '1'
const MODEL = process.env.SOTTO_ANTIGRAVITY_MODEL ?? 'gemini-3.8-flash'
const executable = process.env.SOTTO_ANTIGRAVITY_EXECUTABLE ?? ''
const directory = process.env.SOTTO_ANTIGRAVITY_LIVE_DIR ?? ''
const reportPath = process.env.SOTTO_ANTIGRAVITY_LIVE_REPORT

/** A solid square PNG of one colour, so a model can name it. */
function squarePng(rgb: readonly [number, number, number], size = 32): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [...rgb]).flat())])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

it.skipIf(!live)('does what a Claude thread does, on Google’s own agy', { timeout: 1_800_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'sotto-antigravity-parity-'))
  const host = new AntigravityAcpHost(directory, { executable, requestTimeoutMs: 120_000 })
  let calls = 0
  const tools = new ThreadToolServer({ name: 'sotto_probe', serverName: 'Sotto probe', instructions: 'A local test tool.', unavailable: 'Unavailable', failed: 'Failed' },
    [{ name: 'ping', description: 'Return the test value.', inputSchema: { type: 'object', properties: {} } }],
    async () => { calls++; return { content: [{ type: 'text', text: 'PONG-7731' }] } })
  host.useThreadTools([{ name: 'sotto_probe', definitions: tools.definitions, mcpServer: (id: string) => tools.mcpServer(id) }])
  const results: Record<string, { passed: boolean; saw: unknown }> = {}
  const check = async (name: string, run: () => Promise<{ passed: boolean; saw: unknown }>): Promise<void> => {
    try { results[name] = await run() } catch (error) { results[name] = { passed: false, saw: error instanceof Error ? error.message : String(error) } }
  }
  const thread = async (id: string) => (await host.snapshot()).threads.find(item => item.id === id)!
  const lastReply = async (id: string) => (await thread(id)).messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
  const idle = (id: string, timeout = 300_000) => expect.poll(async () => (await thread(id)).status, { timeout, interval: 1_000 }).toBe('idle')
  const projectId = randomUUID()
  const open = async (runtimeMode: AgentRuntimeMode, modelId = MODEL): Promise<string> => {
    const id = randomUUID()
    expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId, modelId, reasoningEffort: 'low', title: 'Parity', runtimeMode })).toMatchObject({ accepted: true })
    host.observeThreads([...(await host.snapshot()).threads.map(item => item.id)])
    return id
  }
  const send = async (id: string, text: string, extra: Record<string, unknown> = {}) =>
    host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text, ...extra } as Parameters<typeof host.execute>[0])
  try {
    const connected = await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Parity', path: project })

    // Sotto's own tools reach agy over HTTP MCP: the road the browser, delegation, Council, Watcher's merge train and media take.
    await check('sotto-mcp-tool', async () => {
      const id = await open('full-access')
      await send(id, 'Call the ping tool on the sotto_probe MCP server, then reply with exactly the text it returned.')
      await idle(id)
      const reply = await lastReply(id)
      return { passed: calls > 0 && reply.includes('PONG-7731'), saw: { calls, reply: reply.slice(0, 200), activities: (await thread(id)).activities?.map(row => [row.kind, row.title]).slice(0, 10) } }
    })

    // An image in.
    await check('image-in', async () => {
      const id = await open('approval-required')
      await send(id, 'What colour is this image? Reply with one word.', { attachments: [promptImageOf(squarePng([220, 20, 20]), 'red', 'red.png')] })
      await idle(id)
      const reply = (await lastReply(id)).toLowerCase()
      return { passed: reply.includes('red'), saw: reply.slice(0, 200) }
    })

    // Another Gemini model and thinking level for the next prompt.
    await check('model-and-effort-next-prompt', async () => {
      const id = await open('approval-required')
      await send(id, 'Reply with exactly: one'); await idle(id)
      const other = connected.models.find(model => model.id !== MODEL && (model.reasoningEfforts?.length ?? 0) > 0) ?? connected.models.find(model => model.id !== MODEL)!
      const effort = other.reasoningEfforts?.at(-1)
      await host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: other.id, ...(effort ? { reasoningEffort: effort } : {}) })
      await send(id, 'Reply with exactly: two'); await idle(id)
      const after = await thread(id)
      return { passed: after.modelId === other.id && (await lastReply(id)).toLowerCase().includes('two') && after.status === 'idle',
        saw: { model: other.id, effort, modelId: after.modelId, reply: (await lastReply(id)).slice(0, 100) } }
    })

    // Stop a running turn.
    await check('stop', async () => {
      const id = await open('approval-required')
      await send(id, 'Write the numbers from 1 to 400, one per line, with no other text.')
      await expect.poll(async () => (await thread(id)).status, { timeout: 120_000, interval: 250 }).toBe('running')
      await new Promise(resolve => setTimeout(resolve, 3_000))
      const stopped = Date.now()
      expect(await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })).toEqual({ accepted: true })
      await idle(id, 60_000)
      return { passed: true, saw: { secondsToIdle: (Date.now() - stopped) / 1000, lastLine: (await lastReply(id)).trim().split('\n').at(-1) } }
    })

    // agy's own commands, listed as skills.
    await check('slash-commands', async () => {
      const id = await open('approval-required')
      await send(id, 'Reply with exactly: ready'); await idle(id)
      const skills = (await host.listThreadSkills!(id)).skills.map(skill => skill.invocation)
      return { passed: skills.length > 0, saw: skills }
    })

    // Allow edits: Sotto answers agy's edit requests once, and the file is written with no card left.
    await check('allow-edits', async () => {
      const id = await open('auto-accept-edits')
      await send(id, 'Create a file named parity.txt in the current folder containing only the word parity. Use your file editing tool, not the shell.')
      await expect.poll(async () => (await thread(id)).status === 'idle' || (await thread(id)).requests.length > 0, { timeout: 300_000, interval: 1_000 }).toBe(true)
      const waiting = (await thread(id)).requests.map(request => ({ kind: request.kind, text: request.text.slice(0, 120) }))
      for (const request of (await thread(id)).requests) await host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: false })
      await idle(id)
      const file = join(project, 'parity.txt')
      const written = existsSync(file) ? (await readFile(file, 'utf8')).trim() : undefined
      const rows = (await thread(id)).activities?.map(row => [row.kind, row.title, row.status]).slice(0, 10)
      return { passed: written === 'parity' && waiting.length === 0, saw: { written, waiting, rows } }
    })

    // A question agy asks the user, as a card.
    await check('question-card', async () => {
      const id = await open('approval-required')
      await send(id, 'Before you do anything else, use your tool for asking the user a question to ask me whether I prefer tea or coffee. Then reply with my answer in one word.')
      await expect.poll(async () => (await thread(id)).status === 'idle' || (await thread(id)).requests.length > 0, { timeout: 300_000, interval: 1_000 }).toBe(true)
      const request = (await thread(id)).requests[0]
      if (!request) return { passed: false, saw: { asked: false, reply: (await lastReply(id)).slice(0, 200) } }
      const saw = { kind: request.kind, text: request.text.slice(0, 200), options: request.options?.map(option => option.label) }
      const choice = request.options?.find(option => /tea/iu.test(option.label))?.label ?? 'tea'
      await host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: choice, ...(request.kind === 'permission' ? { approved: true } : {}) })
      await idle(id)
      return { passed: request.kind === 'question' && (await lastReply(id)).toLowerCase().includes('tea'), saw: { ...saw, reply: (await lastReply(id)).slice(0, 100) } }
    })
  } finally {
    if (reportPath) await writeFile(reportPath, JSON.stringify(results, null, 2))
    host.disconnect(); await host.closed(); await tools.close()
    await rm(project, { recursive: true, force: true })
  }
  expect(Object.entries(results).filter(([, result]) => !result.passed).map(([name]) => name)).toEqual([])
})

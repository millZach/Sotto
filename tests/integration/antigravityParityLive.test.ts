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

/** A local MCP server of the user's, as their own `agy` file would name it: one tool, `echo`, and a file of its calls. */
const USER_SERVER = `import { appendFileSync } from 'node:fs'
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk; let at
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue
    const frame = JSON.parse(line), reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n')
    if (frame.method === 'initialize') reply({ protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'user_probe', version: '1.0.0' } })
    else if (frame.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'Return the user test value.', inputSchema: { type: 'object', properties: {} } }] })
    else if (frame.method === 'tools/call') { appendFileSync(process.env.USER_PROBE_CALLS, 'call\\n'); reply({ content: [{ type: 'text', text: 'USER-4418' }] }) }
    else if (frame.id !== undefined) reply({})
  }
})
`

/** A one-page PDF whose only text is `word`, with a correct cross-reference table, so a model can read the word back. */
function pdfOf(word: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${word}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'; const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

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
  // The user's own `agy` file, kept outside the project, with one local server whose variable says where it records calls.
  const userSetup = await mkdtemp(join(tmpdir(), 'sotto-antigravity-user-mcp-')), userCalls = join(userSetup, 'calls.txt')
  await writeFile(join(userSetup, 'server.mjs'), USER_SERVER)
  await writeFile(join(userSetup, 'mcp_config.json'), JSON.stringify({ mcpServers: { user_probe: { command: process.execPath, args: [join(userSetup, 'server.mjs')], env: { USER_PROBE_CALLS: userCalls } } } }))
  const host = new AntigravityAcpHost(directory, { executable, requestTimeoutMs: 120_000, userMcpConfig: join(userSetup, 'mcp_config.json') })
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

    // A server from the user's own `agy` file reaches agy beside Sotto's (parity slice 3).
    await check('user-mcp-server', async () => {
      const id = await open('full-access')
      await send(id, 'Call the echo tool on the user_probe MCP server, then reply with exactly the text it returned.')
      await idle(id)
      const reply = await lastReply(id), called = existsSync(userCalls)
      return { passed: called && reply.includes('USER-4418'), saw: { called, reply: reply.slice(0, 200), activities: (await thread(id)).activities?.map(row => [row.kind, row.title]).slice(0, 10) } }
    })

    // An image in.
    await check('image-in', async () => {
      const id = await open('approval-required')
      await send(id, 'What colour is this image? Reply with one word.', { attachments: [promptImageOf(squarePng([220, 20, 20]), 'red', 'red.png')] })
      await idle(id)
      const reply = (await lastReply(id)).toLowerCase()
      return { passed: reply.includes('red'), saw: reply.slice(0, 200) }
    })

    // The thread's token count and how full its context is, from what agy sends with the turn.
    await check('token-count', async () => {
      const id = await open('approval-required')
      await send(id, 'Reply with exactly: ok'); await idle(id)
      const usage = (await thread(id)).usage
      return { passed: (usage?.contextUsed ?? 0) > 0 && (usage?.contextWindow ?? 0) > 0 && (usage?.latest?.input ?? 0) > 0 && (usage?.latest?.output ?? 0) > 0,
        saw: { contextUsed: usage?.contextUsed, contextWindow: usage?.contextWindow, latest: usage?.latest, total: usage?.total } }
    })

    // Compaction: agy's own /compact folds the conversation, and the next turn's context is the smaller one.
    await check('compaction', async () => {
      const id = await open('approval-required')
      await send(id, 'Write about 600 words on the history of the bicycle.'); await idle(id)
      const before = (await thread(id)).usage?.contextUsed ?? 0
      await host.execute({ type: 'compact-thread', threadId: id, commandId: randomUUID() })
      await expect.poll(async () => (await thread(id)).compaction?.status, { timeout: 300_000, interval: 1_000 }).not.toBe('running')
      const compaction = (await thread(id)).compaction
      await send(id, 'Reply with exactly: ok'); await idle(id)
      const after = (await thread(id)).usage?.contextUsed ?? 0
      const boundary = (await thread(id)).activities?.find(row => row.kind === 'compaction')
      return { passed: compaction?.status === 'completed' && after > 0 && after < before && boundary !== undefined,
        saw: { compaction, before, after, boundary: boundary?.context, messages: (await thread(id)).messages.length } }
    })

    // A PDF in (parity slice 6). agy 1.5.14 takes no PDF in the prompt itself, as an embedded resource or otherwise, so
    // Sotto saves it in the thread's folder and names it, and agy reads it with its own tool.
    await check('pdf-in', async () => {
      const id = await open('full-access')
      await send(id, 'Read the attached PDF and reply with only the code word printed in it.', { attachments: [promptImageOf(pdfOf('ZEBRA-4417'), 'pdf', 'report.pdf', 'application/pdf')] })
      await idle(id)
      const reply = await lastReply(id)
      return { passed: reply.includes('ZEBRA-4417'), saw: { reply: reply.slice(0, 120), rows: (await thread(id)).activities?.filter(row => row.kind !== 'turn').map(row => [row.kind, row.title]).slice(0, 6) } }
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

    // An edit placed on its lines (parity slice 5): only the changed lines, numbered as the file is now.
    await check('edit-lines', async () => {
      await writeFile(join(project, 'lines.txt'), 'alpha\nbravo\ncharlie\ndelta\necho\n')
      const id = await open('auto-accept-edits')
      await send(id, 'In lines.txt, replace the line charlie with CHARLIE. Use your file editing tool, not the shell. Then reply done.')
      await idle(id)
      const diffs = (await thread(id)).activities?.filter(row => row.kind === 'file-change').flatMap(row => row.changes?.map(change => change.diff ?? '') ?? []) ?? []
      // The report keeps each diff's first line only, a hunk's place, never the file's text.
      return { passed: diffs.some(diff => diff.startsWith('@@ -3 +3 @@') && diff.includes('-charlie') && diff.includes('+CHARLIE')), saw: { heads: diffs.map(diff => diff.startsWith('@@') ? diff.split('\n')[0] : 'as reported') } }
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
    await rm(userSetup, { recursive: true, force: true })
  }
  expect(Object.entries(results).filter(([, result]) => !result.passed).map(([name]) => name)).toEqual([])
})

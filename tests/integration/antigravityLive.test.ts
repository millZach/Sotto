// @vitest-environment node
/**
 * Google's own `agy` (ADR-0212). Never in CI: it needs `agy` 1.5 or newer and a Google sign-in, and it spends a few short
 * turns on that account. Run with
 *
 *   SOTTO_ANTIGRAVITY_LIVE=1 SOTTO_ANTIGRAVITY_EXECUTABLE=<agy> SOTTO_ANTIGRAVITY_LIVE_DIR=<folder> npx vitest run tests/integration/antigravityLive.test.ts
 *
 * `<folder>` is the runtime directory whose `antigravity/gemini` folder `agy acp --login` signed in, so the user's own
 * ~/.gemini is never read or written. The model is Gemini 3.8 Flash at low thinking unless SOTTO_ANTIGRAVITY_MODEL names
 * another.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AntigravityAcpHost } from '../../src/main/agents/antigravity'

const live = process.env.SOTTO_ANTIGRAVITY_LIVE === '1'
const MODEL = process.env.SOTTO_ANTIGRAVITY_MODEL ?? 'gemini-3.8-flash'
const executable = process.env.SOTTO_ANTIGRAVITY_EXECUTABLE ?? ''
const directory = process.env.SOTTO_ANTIGRAVITY_LIVE_DIR ?? ''
/** Where to write what the run saw, for a verification note: counts, names and words Sotto showed, never the account. */
const reportPath = process.env.SOTTO_ANTIGRAVITY_LIVE_REPORT
const report: Record<string, unknown> = {}

it.skipIf(!live)('runs, asks, steers, resumes, writes short text and reads limits on Google’s own agy, in Sotto’s own folder', { timeout: 900_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'sotto-antigravity-live-'))
  const options = { executable, requestTimeoutMs: 120_000, usageEnabled: true }
  let host = new AntigravityAcpHost(directory, options)
  const thread = async (id: string) => (await host.snapshot()).threads.find(item => item.id === id)!
  const reply = async (id: string) => (await thread(id)).messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n')
  const idle = (id: string) => expect.poll(async () => (await thread(id)).status, { timeout: 300_000, interval: 1_000 }).toBe('idle')
  try {
    const connected = await host.connect()
    expect(connected.version).toMatch(/^1\.5\.\d+ \/ ACP 1$/u)
    const model = connected.models.find(item => item.id === MODEL)!
    expect(model).toMatchObject({ provider: 'Antigravity' })
    expect(model.reasoningEfforts).toContain('low')
    // Gemini only, under Google's terms, though the account lists Claude and GPT models too (ADR-0212).
    expect(connected.models.length).toBeGreaterThan(0)
    expect(connected.models.every(item => item.id.startsWith('gemini-'))).toBe(true)
    Object.assign(report, { version: connected.version, models: connected.models.map(item => [item.id, item.name, item.reasoningEfforts]), runtimeModes: model.runtimeModes })

    const projectId = randomUUID()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Live', path: project })
    const id = randomUUID()
    expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId, modelId: MODEL, reasoningEffort: 'low', title: 'Live' })).toMatchObject({ accepted: true })
    host.observeThreads([id])

    // A reply.
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Reply with exactly the word: pong' })).toEqual({ accepted: true })
    await idle(id)
    expect((await reply(id)).toLowerCase()).toContain('pong')

    // A permission card on Ask for approval, answered by the user.
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Run the shell command `echo sotto-live-check` and tell me what it printed.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread(id)).requests.length, { timeout: 300_000, interval: 1_000 }).toBeGreaterThan(0)
    const request = (await thread(id)).requests[0]!
    report.request = { kind: request.kind, text: request.text, command: request.context?.command, choices: request.permissionChoices?.map(choice => choice.label) }
    expect(request.permissionChoices?.map(choice => choice.label)).toEqual(expect.arrayContaining(['Allow once']))
    expect(await host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true })).toEqual({ accepted: true })
    await idle(id)
    expect(await reply(id)).toContain('sotto-live-check')

    // A short title, on the side.
    const title = await host.writeShortText(id, { instruction: 'Name this coding conversation in three words. Reply with the name only.', material: 'First message:\nReply with exactly the word: pong' })
    expect(title?.length).toBeGreaterThan(0)
    report.title = title

    // A restart: a new adapter over the same folder resumes the session, which replays nothing and remembers the first reply.
    host.disconnect(); await host.closed()
    host = new AntigravityAcpHost(directory, options)
    await host.connect()
    host.observeThreads([id])
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm3', text: 'What single word did you reply with first? Reply with that word only.' })).toEqual({ accepted: true })
    await idle(id)
    expect((await reply(id)).toLowerCase()).toContain('pong')

    // Steering a running turn with a second prompt.
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm4', text: 'Count slowly from 1 to 40, one number per line.' })).toEqual({ accepted: true })
    expect(await host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'm5', text: 'Stop counting and reply with exactly: steered' })).toEqual({ accepted: true })
    await idle(id)
    expect((await reply(id)).toLowerCase()).toContain('steered')
    report.messages = (await thread(id)).messages.map(message => [message.role, message.text.slice(0, 200)])
    report.activities = (await thread(id)).activities?.map(row => [row.kind, row.title, row.status, row.command]).slice(0, 40)
    if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2))
  } finally {
    host.disconnect(); await host.closed()
    await rm(project, { recursive: true, force: true })
  }
})

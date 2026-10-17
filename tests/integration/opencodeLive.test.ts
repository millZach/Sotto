// @vitest-environment node
/**
 * OpenCode 2 itself, on a scratch folder of its own (ADR-0087). Never in CI: it needs OpenCode 2 installed and reaches
 * OpenCode Zen's free models on opencode.ai. Run with
 *
 *   SOTTO_OPENCODE_LIVE=1 SOTTO_OPENCODE_EXECUTABLE=<path to opencode 2> npx vitest run tests/integration/opencodeLive.test.ts
 *
 * The adapter's own folder sits inside a temporary root, so no OpenCode data, config or sign-in of the user's is used.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OpenCodeHost } from '../../src/main/agents/opencode'

const live = process.env.SOTTO_OPENCODE_LIVE === '1'
const MODEL = process.env.SOTTO_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free'

it.skipIf(!live)('runs, asks, resumes and stops a thread on OpenCode 2 itself', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-live-'))
  const project = join(root, 'project')
  const events: string[] = []
  const options = { ...(process.env.SOTTO_OPENCODE_EXECUTABLE ? { executable: process.env.SOTTO_OPENCODE_EXECUTABLE } : {}), requestTimeoutMs: 60_000, log: (event: string) => events.push(event) }
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

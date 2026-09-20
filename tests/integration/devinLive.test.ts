// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DevinRejected } from '../../src/main/agents/devinRpc'
import { DevinAcpHost } from '../../src/main/agents/devin'

it.skipIf(process.env['SOTTO_DEVIN_LIVE'] !== '1')('verifies native Devin identity, decisions, questions, interrupt, and restart in a disposable Git project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-devin-live-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-devin-live-')) throw new Error('Unexpected temporary directory')
  const cwd = join(root, 'project'); const data = join(root, 'sotto')
  await mkdir(cwd); await mkdir(data)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
  let host = new DevinAcpHost(data)
  const id = randomUUID()
  const thread = async () => (await host.snapshot()).threads.find(thread => thread.id === id)!
  let stage = 'connect'
  try {
    const connected = await host.connect()
    expect(connected.models.some(model => model.id === 'swe-1-6-fast' && model.ready)).toBe(true)
    stage = 'create-project'
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Synthetic native check', path: cwd })
    stage = 'create-thread'
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', title: 'Synthetic native check', modelId: 'swe-1-6-fast' })
    host.observeThreads([id])
    stage = 'empty-thread-restart'
    host.disconnect(); await host.closed()
    host = new DevinAcpHost(data); host.observeThreads([id]); await host.connect()
    expect((await thread()).id).toBe(id)
    expect((await thread()).modelId).toBe('swe-1-6-fast')
    expect((await thread()).messages).toHaveLength(0)
    const send = async (text: string) => host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text })
    const denied = join(cwd, 'denied.txt')
    stage = 'send-denied'
    expect(await send('Use the file write tool to create denied.txt containing SOTTO_DENIED. Do not read other files, use shell commands, fetch URLs, or delegate. If permission is denied, stop.')).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).requests.some(request => request.kind === 'permission'), { timeout: 30_000 }).toBe(true)
    let request = (await thread()).requests[0]!
    await host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: false })
    await expect.poll(async () => (await thread()).status, { timeout: 30_000 }).toBe('idle')
    expect(await readFile(denied).then(() => true, () => false)).toBe(false)

    stage = 'send-allowed'
    expect(await send('Use the file write tool to create allowed.txt containing exactly SOTTO_ALLOWED. Do not read other files, use shell commands, fetch URLs, or delegate.')).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).requests.some(request => request.kind === 'permission'), { timeout: 30_000 }).toBe(true)
    request = (await thread()).requests[0]!
    const proposed = JSON.parse(request.context!.details!)
    expect(typeof proposed.file_path === 'string' && resolve(proposed.file_path) === resolve(cwd, 'allowed.txt') && proposed.content.trim() === 'SOTTO_ALLOWED').toBe(true)
    await host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true })
    await expect.poll(async () => (await thread()).status, { timeout: 30_000 }).toBe('idle')
    expect((await readFile(join(cwd, 'allowed.txt'), 'utf8')).trim() === 'SOTTO_ALLOWED').toBe(true)

    stage = 'question'
    expect(await send('Use your structured question tool to ask me to choose Alpha or Beta. Wait for my answer, then acknowledge it. Do not use any other tools.')).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).requests.some(request => request.kind === 'question'), { timeout: 30_000 }).toBe(true)
    request = (await thread()).requests[0]!
    const question = request.questions![0]!
    expect(question.options.length === 2).toBe(true)
    await host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '',
      questionAnswers: { [question.id]: { optionIds: [question.options[0]!.id] } } })
    await expect.poll(async () => (await thread()).status, { timeout: 30_000 }).toBe('idle')

    const before = (await thread()).messages.map(message => message.id)
    stage = 'restart'
    host.disconnect(); await host.closed()
    host = new DevinAcpHost(data); host.observeThreads([id]); await host.connect()
    expect((await thread()).messages.map(message => message.id)).toEqual(before)
    stage = 'cancel'
    expect(await send('Use the file write tool to create cancelled.txt containing SOTTO_CANCELLED. Do not use any other tools.')).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).requests.some(request => request.kind === 'permission'), { timeout: 30_000 }).toBe(true)
    await host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })
    await expect.poll(async () => (await thread()).status, { timeout: 30_000 }).toBe('idle')
    expect(await readFile(join(cwd, 'cancelled.txt')).then(() => true, () => false)).toBe(false)
  } catch (error) {
    console.info('devin-live-failure', { stage, code: error instanceof DevinRejected ? error.code : undefined, operation: error instanceof DevinRejected ? error.operation : undefined })
    throw error
  } finally {
    host.disconnect(); await host.closed()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)

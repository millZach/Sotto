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


it.skipIf(process.env['SOTTO_DEVIN_LIVE'] !== '1' || process.platform !== 'win32').each([false, true])('preserves native identity after abrupt owner loss (model previously saved: %s)', async modelSaved => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-devin-live-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-devin-live-')) throw new Error('Unexpected temporary directory')
  const cwd = join(root, 'project'); const data = join(root, 'sotto')
  await mkdir(cwd); await mkdir(data)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
  const options = { pollIntervalMs: 60_000 }
  let host = new DevinAcpHost(data, options)
  const id = randomUUID()
  const thread = async () => (await host.snapshot()).threads.find(thread => thread.id === id)!
  let stage = 'connect'
  try {
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Synthetic loss check', path: cwd })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', title: 'Synthetic loss check', modelId: 'swe-1-6-fast' })
    host.observeThreads([id])
    if (modelSaved) {
      expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id,
        text: 'Reply with SOTTO_INITIALIZED. Do not use tools.' })).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status, { timeout: 30_000 }).toBe('idle')
      host.disconnect(); await host.closed()
      host = new DevinAcpHost(data, options); host.observeThreads([id]); await host.connect()
    }
    const messageId = randomUUID()
    expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId, threadId: id,
      text: 'Use the file write tool to create lost-owner.txt containing SOTTO_LOST_OWNER. Do not read other files, use shell commands, fetch URLs, or delegate.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).requests.some(request => request.kind === 'permission'), { timeout: 30_000 }).toBe(true)
    const pendingId = (await thread()).requests[0]!.id
    const before = JSON.parse(await readFile(join(data, 'devin-threads.json'), 'utf8'))[id].devinSessionId
    // Select only the ACP child launched with this test's unique owned profile; never print command lines.
    const profile = join(data, 'devin', 'approval-policy-v1.json').replaceAll("'", "''")
    const query = "@(Get-CimInstance Win32_Process -Filter \"Name = 'devin.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + profile + "') -and $_.CommandLine -match '(?:^|\\s)acp(?:\\s|$)' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const value: unknown = JSON.parse(raw)
    const pids = Array.isArray(value) ? value : [value]
    expect(pids).toHaveLength(1)
    const pid: unknown = pids[0]
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Unexpected native process identity')
    stage = 'kill-owner'
    process.kill(pid, 'SIGKILL')
    await expect.poll(async () => (await thread()).status, { timeout: 15_000 }).toBe('error')
    expect((await thread()).lastTurn?.status).toBe('failed')
    expect(await readFile(join(cwd, 'lost-owner.txt')).then(() => true, () => false)).toBe(false)
    stage = 'restart'
    host.disconnect(); await host.closed()
    host = new DevinAcpHost(data, options)
    if (!modelSaved) {
      await host.connect()
      await expect(host.refreshThread(id)).rejects.toThrow('Restore the original model in Devin')
      const alias = JSON.parse(await readFile(join(data, 'devin-threads.json'), 'utf8'))[id]
      expect(alias.devinSessionId).toBe(before)
      expect(alias.modelId).toBe('swe-1-6-fast')
      expect(alias.origins.some((origin: { messageId: string }) => origin.messageId === messageId)).toBe(true)
      expect((await thread()).status).toBe('error')
      expect((await thread()).requests).toHaveLength(0)
      await expect(host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: pendingId, answer: '', approved: true })).rejects.toThrow('Restore the original model in Devin')
      expect(await readFile(join(cwd, 'lost-owner.txt')).then(() => true, () => false)).toBe(false)
      return
    }
    host.observeThreads([id]); await host.connect()
    expect(JSON.parse(await readFile(join(data, 'devin-threads.json'), 'utf8'))[id].devinSessionId).toBe(before)
    expect((await thread()).messages.some(message => message.id === messageId)).toBe(true)
    expect((await thread()).requests).toHaveLength(0)
    stage = 'reject-stale-answer'
    await expect(host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: pendingId, answer: '', approved: true })).rejects.toThrow('no longer pending')
    stage = 'new-prompt'
    expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id,
      text: 'Reply with SOTTO_RECOVERED. Do not use tools or resume the previous file action.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 30_000 }).toBe('idle')
    expect(await readFile(join(cwd, 'lost-owner.txt')).then(() => true, () => false)).toBe(false)
  } catch (error) {
    console.info('devin-live-loss-failure', { stage, code: error instanceof DevinRejected ? error.code : undefined, operation: error instanceof DevinRejected ? error.operation : undefined })
    throw error
  } finally {
    host.disconnect(); await host.closed()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)

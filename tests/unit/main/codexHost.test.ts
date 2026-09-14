// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { codexFixture, rolloutLine } from '../../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const controls: AgentControl[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})
async function fixture(wrapped = false, timeout = 1000) {
  const f = await codexFixture(undefined, wrapped, timeout); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  return f
}
async function create(f: Awaited<ReturnType<typeof fixture>>, threadId = randomUUID()) {
  const result = await f.host.execute({ type: 'create-thread', threadId, commandId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'Implementation' })
  return { threadId, result }
}
async function startControl(f: Awaited<ReturnType<typeof fixture>>) {
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => v.toString() }); await credentials.load()
  const control = new AgentControl({ directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  controls.push(control); await control.start(); await control.command({ type: 'connect' })
  return control
}
describe('Codex App Server provider adapter', () => {
  it('routes manual compaction through the public control, rejecting concurrent requests and preserving uncertain restart state', async () => {
    const f = await fixture()
    const { threadId } = await create(f)
    const control = await startControl(f)
    await control.command({ type: 'compact-thread', threadId })
    expect((await control.command({ type: 'compact-thread', threadId })).error).toMatch(/finish|compaction|working/i)
    expect((await f.driver.requests()).filter(row => row.method === 'thread/compact/start')).toHaveLength(1)
    control.dispose()
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
    expect((await f.host.snapshot()).threads[0]?.compaction?.status).toBe('uncertain')
    await expect(f.host.execute({ type: 'compact-thread', commandId: 'retry', threadId })).rejects.toThrow(/unconfirmed/i)
    expect((await f.driver.requests()).filter(row => row.method === 'thread/compact/start')).toHaveLength(1)
  })
  it('reads a newly created unmaterialized thread without turns, then reads its first message normally', async () => {
    const f = await fixture()
    const { threadId } = await create(f)
    expect((await f.adapter.refreshThread(threadId)).threads[0]).toMatchObject({ id: threadId, status: 'idle', messages: [] })
    expect((await f.driver.requests()).filter(request => request.method === 'thread/read').map(request => request.params?.includeTurns)).toEqual([true, false])
    await f.host.execute({ type: 'send', commandId: 'first', threadId, messageId: 'first-message', text: 'First prompt' })
    expect((await f.adapter.refreshThread(threadId)).threads[0]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'First prompt', commandId: 'first' })]))
    expect((await f.driver.requests()).filter(request => request.method === 'thread/read').at(-1)?.params?.includeTurns).toBe(true)
  })
  it('does not treat unrelated thread read rejections as an empty transcript', async () => {
    const f = await fixture()
    const { threadId } = await create(f)
    await f.script({ reject: 'thread/read' })
    await expect(f.adapter.refreshThread(threadId)).rejects.toThrow('Codex rejected the operation')
    expect((await f.driver.requests()).filter(request => request.method === 'thread/read')).toHaveLength(1)
  })
  it('keeps a missing saved session unavailable without blocking connection or creating a replacement', async () => {
    const f = await fixture()
    const { threadId } = await create(f)
    const nativeId = await f.realId(threadId)
    f.host.disconnect(); await f.adapter.closed()
    await f.script({ reject: 'thread/resume', rejection: { code: -32600, message: `no rollout found for thread id ${nativeId}` } })
    const connected = await f.host.connect()
    expect(connected.connected).toBe(true)
    expect(connected.threads[0]).toMatchObject({ id: threadId, status: 'error', historyStatus: 'error', historyError: expect.stringContaining('saved session') })
    expect((await f.driver.requests()).filter(request => request.method === 'thread/start')).toHaveLength(1)
    const fresh = await create(f)
    expect((await f.adapter.refreshThread(fresh.threadId)).connected).toBe(true)
  })
  it('reads supported reasoning levels and preserves selected thread settings through real RPCs and restart', async () => {
    const f = await fixture()
    expect((await f.host.snapshot()).models[0]).toMatchObject({ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', supportsImages: false })
    const threadId = randomUUID()
    expect(await f.host.execute({ type: 'create-thread', commandId: 'create', threadId, projectId: f.projectId, title: 'Configured', modelId: f.modelId,
      reasoningEffort: 'high', runtimeMode: 'approval-required' })).toEqual({ accepted: true })
    expect((await f.host.snapshot()).threads[0]).toMatchObject({ modelId: f.modelId, reasoningEffort: 'high', runtimeMode: 'approval-required' })
    await f.host.execute({ type: 'configure-thread', commandId: 'config', threadId, reasoningEffort: 'low', runtimeMode: 'full-access' })
    expect((await f.host.snapshot()).threads[0]).toMatchObject({ reasoningEffort: 'low', runtimeMode: 'full-access' })
    const rpc = (await f.driver.requests()).findLast(request => request.method === 'thread/resume')!
    expect(rpc.params).toMatchObject({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'low' } })
    f.host.disconnect(); await f.adapter.closed()
    await f.host.connect()
    expect((await f.host.snapshot()).threads[0]).toMatchObject({ reasoningEffort: 'low', runtimeMode: 'full-access' })
    await f.host.execute({ type: 'send', commandId: 'send', threadId, messageId: 'message', text: 'Fixture prompt' })
    expect((await f.driver.requests()).findLast(request => request.method === 'turn/start')!.params).toMatchObject({ approvalPolicy: 'never', approvalsReviewer: 'user', effort: 'low' })
  })
  it('reconciles uncertain settings after reconnect without replaying an override or restoring the old policy', async () => {
    // Leave child initialization headroom while still forcing the settings acknowledgement to time out.
    const f = await fixture(false, 500); const { threadId } = await create(f)
    await f.script({ delay: { method: 'thread/resume', ms: 1500 } })
    expect(await f.host.execute({ type: 'configure-thread', commandId: 'config', threadId, runtimeMode: 'full-access' })).toEqual({ accepted: false, uncertain: true })
    f.host.disconnect(); await f.adapter.closed()
    await f.host.connect()
    expect((await f.host.snapshot()).threads[0]).toMatchObject({ runtimeMode: 'full-access' })
    const resumes = (await f.driver.requests()).filter(request => request.method === 'thread/resume')
    expect(resumes.filter(request => request.params?.sandbox !== undefined)).toHaveLength(1)
    expect(resumes.at(-1)?.params).not.toHaveProperty('approvalPolicy')
  })
  it('rejects unsupported images and model reasoning without silently sending text or falling back', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'bad', threadId, reasoningEffort: 'invented' })).rejects.toThrow(/reasoning/)
    await expect(f.host.execute({ type: 'send', commandId: 'image', threadId, messageId: 'image-message', text: 'Do not drop this image',
      attachments: [{ id: 'shot', name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YWJj' }] })).rejects.toThrow(/image support/)
    expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toEqual([])
  })
  it('reports model listing failure without inventing an available model', async () => {
    const f = await codexFixture(); fixtures.push(f)
    await f.script({ reject: 'model/list' })
    const snapshot = await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Project', path: f.root })
    expect(snapshot.models).toEqual([])
    expect(snapshot).toMatchObject({ error: expect.stringMatching(/models.*list|list.*models/iu) })
    await expect(create(f)).rejects.toThrow('Choose an available Codex model.')
    expect((await f.host.connect())).not.toHaveProperty('error')
    expect((await create(f)).result).toEqual({ accepted: true })
  })
  it.each(['answer again', 'interrupt', 'disconnect'] as const)('writes only one accept when its write callback times out before %s', async next => {
    const f = await fixture(false, 200); const { threadId } = await create(f)
    await f.driver.raisePermission(threadId, 'Synthetic permission')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const requestId = (await f.host.snapshot()).threads[0]!.requests[0]!.id
    const rpcId = JSON.parse(requestId.slice(4))
    const command = { type: 'answer' as const, commandId: 'answer', threadId, requestId, answer: '', approved: true }
    const child = f.adapter['child']!
    const originalWrite = child.stdin.write.bind(child.stdin)
    const callbacks: (() => void)[] = []
    // Keep the provider's resolved notification from hiding the write-timeout race.
    child.stdout.pause()
    child.stdin.write = ((chunk: string, callback?: (error?: Error | null) => void) => originalWrite(chunk, error => {
      if (callback) callbacks.push(() => callback(error))
    })) as typeof child.stdin.write
    try {
      expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
      let secondError: unknown
      if (next === 'answer again') { try { await f.host.execute(command) } catch (error) { secondError = error } }
      else if (next === 'interrupt') await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId })
      else { f.host.disconnect(); await f.adapter.closed() }
      await expect.poll(async () => (await f.driver.requests()).filter(r => r.id === rpcId && r.result).length).toBeGreaterThan(0)
      expect((await f.driver.requests()).filter(r => r.id === rpcId && r.result)).toEqual([{ id: rpcId, result: { decision: 'accept' } }])
      if (next === 'answer again') expect(secondError).toMatchObject({ message: 'This Codex request is no longer pending.' })
      expect((await f.host.snapshot()).threads[0]!.requests).toEqual([])
    } finally {
      child.stdin.write = originalWrite
      for (const callback of callbacks) callback()
      child.stdout.resume()
    }
  })
  it('does not decline an already answered request captured before another decline finishes', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.driver.raisePermission(threadId, 'First permission')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    await f.driver.raisePermission(threadId, 'Second permission')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(2)
    const [first, second] = (await f.host.snapshot()).threads[0]!.requests
    const child = f.adapter['child']!
    const originalWrite = child.stdin.write.bind(child.stdin)
    let release: (() => void) | undefined
    child.stdin.write = ((chunk: string, callback?: (error?: Error | null) => void) => originalWrite(chunk, error => {
      if (JSON.parse(chunk).id === JSON.parse(first!.id.slice(4))) release = () => callback?.(error)
      else callback?.(error)
    })) as typeof child.stdin.write
    const interrupt = f.host.execute({ type: 'interrupt', commandId: 'stop', threadId })
    try {
      await expect.poll(() => !!release).toBe(true)
      await f.host.execute({ type: 'answer', commandId: 'answer', threadId, requestId: second!.id, answer: '', approved: true })
      release!(); await interrupt
      f.host.disconnect(); await f.adapter.closed()
      expect((await f.driver.requests()).filter(r => r.id === JSON.parse(second!.id.slice(4)) && r.result)).toEqual([
        { id: JSON.parse(second!.id.slice(4)), result: { decision: 'accept' } },
      ])
    } finally { release?.(); child.stdin.write = originalWrite; await interrupt }
  })
  it('rejects an MCP form answer that omits a required second field', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.action(threadId, { type: 'question', text: 'Choose color', method: 'mcpServer/elicitation/request', params: { requestedSchema: {
      type: 'object', properties: { choice: { type: 'string' }, explanation: { type: 'string' } }, required: ['choice', 'explanation'],
    } } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const requestId = (await f.host.snapshot()).threads[0]!.requests[0]!.id
    await expect(f.host.execute({ type: 'answer', commandId: 'answer', threadId, requestId, answer: '{"choice":"Blue"}' })).rejects.toThrow('Answer the required field')
    expect((await f.host.snapshot()).threads[0]!.requests).toHaveLength(1)
  })
  it.each([
    ['item/commandExecution/requestApproval', {}],
    ['item/commandExecution/requestApproval', { decision: 'allow' }],
    ['item/fileChange/requestApproval', {}],
    ['item/fileChange/requestApproval', { decision: 'allow' }],
    ['item/permissions/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: [] }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'forever' }],
    ['item/tool/requestUserInput', {}],
    ['item/tool/requestUserInput', { answers: { choice: { answers: [true] } } }],
    ['item/tool/requestUserInput', { answers: { choice: 'Blue' } }],
    ['mcpServer/elicitation/request', {}],
    ['mcpServer/elicitation/request', { action: 'allow' }],
  ])('makes malformed %s replies fail fixture inspection and cleanup (%j)', async (method, result) => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.action(threadId, { type: 'question', text: 'Synthetic question', method })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const pending = (await f.host.snapshot()).threads[0]!.requests[0]!
    f.adapter['child']!.stdin.write(JSON.stringify({ id: JSON.parse(pending.id.slice(4)), result }) + '\n')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(0)
    try {
      await expect(f.driver.requests()).rejects.toThrow(`Invalid Codex reply for ${method}:`)
      await expect(f.cleanup()).rejects.toThrow(`Invalid Codex reply for ${method}:`)
    } finally {
      fixtures.splice(fixtures.indexOf(f), 1)
      await f.cleanup().catch(() => undefined)
    }
  })
  it('performs the handshake and isolates provider IDs and working directories', async () => {
    const f = await fixture(true); const { threadId } = await create(f)
    const real = await f.realId(threadId)
    expect(real).not.toBe(threadId); expect(real).not.toBe(f.registry.byThread(threadId)!.sessionId)
    expect(JSON.stringify(await f.host.snapshot())).not.toContain(real)
    const requests = await f.driver.requests()
    expect(requests.slice(0, 3).map(r => r.method)).toEqual(['initialize', 'initialized', 'model/list'])
    expect(requests.find(r => r.method === 'thread/start')!.params).toMatchObject({ cwd: f.root, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: false })
    await expect(f.host.execute({ type: 'create-project', commandId: 'bad', projectId: 'bad', title: 'Bad', path: 'relative' })).rejects.toThrow('absolute')
  })
  it('persists a late creation acknowledgement and never repeats thread/start', async () => {
    const f = await fixture(false, 200); await f.driver.delayNextAck('thread/start')
    const { threadId, result } = await create(f)
    expect(result).toEqual({ accepted: false, uncertain: true })
    expect((await create(f, threadId)).result).toEqual({ accepted: false, uncertain: true })
    await expect.poll(async () => (await f.host.snapshot()).threads.some(t => t.id === threadId)).toBe(true)
    expect(await f.realId(threadId)).not.toBe(threadId)
    expect((await f.driver.requests()).filter(r => r.method === 'thread/start')).toHaveLength(1)
  })
  it.each([false, true])('reconciles delayed send acknowledgements with item notifications suppressed=%s', async suppressNotifications => {
    const f = await fixture(false, 200); const { threadId } = await create(f)
    await f.script({ delay: { method: 'turn/start', ms: 450 }, suppressNotifications })
    const command = { type: 'send' as const, commandId: 'send', messageId: 'own-message', threadId, text: 'Synthetic input' }
    expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.messages.filter(m => m.id === command.messageId).length).toBe(1)
    expect((await f.host.snapshot()).threads[0]!.messages[0]).toMatchObject({ commandId: 'send', role: 'user' })
    await f.host.execute(command)
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
  })
  it('clears the durable coordinator outbox and draft after a late send acknowledgement without retrying', async () => {
    const f = await fixture(true, 200); const { threadId } = await create(f); const control = await startControl(f)
    await control.command({ type: 'assign', threadId }); await control.command({ type: 'select-thread', threadId })
    await control.command({ type: 'compose', text: 'Retained draft' })
    await f.driver.delayNextAck('turn/start')
    const uncertain = await control.command({ type: 'send' })
    expect(uncertain.error).toContain('did not confirm'); expect(uncertain.draft).toBe('Retained draft')
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toHaveLength(1)
    await expect.poll(() => control.get().draft).toBe('')
    await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox.length).toBe(0)
    expect(control.get().assignments[0]!.mode).toBe('managed')
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
  })
  it('keeps a completed turn idle after its delayed start response and preserves the reply across restart', async () => {
    const f = await fixture(false, 200); const { threadId } = await create(f)
    await f.script({ delay: { method: 'turn/start', ms: 400 }, reply: 'Finished already' })
    expect(await f.host.execute({ type: 'send', threadId, commandId: 'send', messageId: 'message', text: 'Synthetic input' })).toEqual({ accepted: false, uncertain: true })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.status).toBe('idle')
    await f.script({})
    const before = (await f.host.snapshot()).threads[0]!
    const restarted = await f.driver.restart(); fixtures.push(restarted)
    await restarted.host.connect()
    const restored = (await restarted.host.snapshot()).threads[0]!
    // Live observation times belong to WorkspaceHost's privacy-aware cache;
    // this bare native adapter can restore only timing present in native history.
    const { activities: beforeActivities, ...beforeThread } = before
    const { activities: restoredActivities, ...restoredThread } = restored
    expect(restoredThread).toEqual(beforeThread)
    expect(restoredActivities?.map(({ id, kind, status }) => ({ id, kind, status })))
      .toEqual(beforeActivities?.map(({ id, kind, status }) => ({ id, kind, status })))
  })
  it('rejects a definitive send failure and permits a corrected dispatch', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.script({ reject: 'turn/start' })
    const command = { type: 'send' as const, threadId, commandId: 'send', messageId: 'message', text: 'Synthetic input' }
    await expect(f.host.execute(command)).rejects.toThrow('rejected')
    expect((await f.host.snapshot()).threads[0]!.messages).toEqual([])
    expect(await f.host.execute(command)).toEqual({ accepted: true })
  })
  it('removes a rejected origin even when the rejection arrives after the deadline', async () => {
    const f = await fixture(false, 200); const { threadId } = await create(f)
    await f.script({ reject: 'turn/start', delay: { method: 'turn/start', ms: 400 } })
    expect(await f.host.execute({ type: 'send', threadId, commandId: 'send', messageId: 'message', text: 'Rejected input' })).toEqual({ accepted: false, uncertain: true })
    await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'codex-threads.json'), 'utf8'))[threadId].origins.length).toBe(0)
    const directory = join(f.root, 'home', 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `rollout-2026-09-10-${await f.realId(threadId)}.jsonl`), JSON.stringify({
      timestamp: new Date().toISOString(), ordinal: 1, type: 'event_msg', payload: { type: 'user_message', message: 'Rejected input' },
    }) + '\n')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.messages.length).toBe(1)
    expect((await f.host.snapshot()).threads[0]!.messages[0]!.commandId).toBeUndefined()
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
  })
  it('answers numbered questions and removes requests resolved directly by the provider', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.action(threadId, { type: 'question', text: 'Questions', params: { questions: [
      { id: 'color', question: 'Which color?', options: [{ label: 'Blue', description: '' }] },
      { id: 'size', question: 'Which size?', options: null },
    ] } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const request = (await f.host.snapshot()).threads[0]!.requests[0]!
    expect(request.text).toBe('1. Which color? (Blue)\n2. Which size?')
    const command = { type: 'answer' as const, threadId, commandId: 'answer', requestId: request.id, answer: '1: Blue\n2: Large' }
    await f.host.execute(command)
    await expect.poll(async () => (await f.driver.requests()).some(r => JSON.stringify(r.result?.answers) === '{"color":{"answers":["Blue"]},"size":{"answers":["Large"]}}')).toBe(true)
    await f.driver.raiseQuestion(threadId, 'Resolved in Codex')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const pending = (await f.host.snapshot()).threads[0]!.requests[0]!
    await f.action(threadId, { type: 'notify', method: 'serverRequest/resolved', params: { requestId: JSON.parse(pending.id.slice(4)) } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(0)
    await expect(f.host.execute({ ...command, requestId: pending.id })).rejects.toThrow('no longer pending')
  })
  it('ignores unknown observed provider sessions and closes unanswered questions with an empty answer', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    f.host.observeThreads?.(['unknown', threadId]); await f.driver.raiseQuestion(threadId, 'Unanswered')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    f.host.disconnect(); await f.adapter.closed()
    expect((await f.driver.requests()).filter(r => r.method === 'thread/resume')).toHaveLength(0)
    expect((await f.driver.requests()).some(r => JSON.stringify(r.result?.answers) === '{}')).toBe(true)
    expect((await f.host.snapshot()).connected).toBe(false)
  })
  it('recovers the binding, title, running status and message origin with a new process', async () => {
    const f = await fixture(true); const { threadId } = await create(f)
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'message', threadId, text: 'Synthetic prompt' })
    const before = (await f.host.snapshot()).threads[0]!
    const restarted = await f.driver.restart(); fixtures.push(restarted)
    restarted.host.observeThreads?.([threadId]); await restarted.host.connect()
    expect((await restarted.host.snapshot()).threads[0]).toEqual(before)
    expect((await restarted.driver.requests()).filter(r => r.method === 'thread/resume').at(-1)!.params!.threadId).toBe(await restarted.realId(threadId))
  })
  it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])('requires explicit decisions for %s', async method => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.action(threadId, { type: 'permission', text: 'Synthetic permission', method })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const command = { type: 'answer' as const, commandId: 'answer', threadId, requestId: (await f.host.snapshot()).threads[0]!.requests[0]!.id, answer: '' }
    await expect(f.host.execute(command)).rejects.toThrow('Explicitly')
    if (method === 'item/permissions/requestApproval') await expect(f.host.execute({ ...command, approved: true })).rejects.toThrow('Codex')
    await f.host.execute({ ...command, approved: false })
    await expect.poll(async () => (await f.driver.requests()).some(r => r.id !== undefined && r.result !== undefined)).toBe(true)
    expect((await f.driver.requests()).some(r => r.result?.decision === 'accept')).toBe(false)
  })
  it.each(['item/tool/requestUserInput', 'mcpServer/elicitation/request'])('delivers question answers for %s', async method => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.action(threadId, { type: 'question', text: 'Choose color', method })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.requests.length).toBe(1)
    const request = (await f.host.snapshot()).threads[0]!.requests[0]!
    expect(request).toMatchObject({ kind: 'question', text: 'Choose color' })
    await f.host.execute({ type: 'answer', commandId: 'answer', threadId, requestId: request.id, answer: 'Blue' })
    await expect.poll(async () => (await f.driver.requests()).some(r => method === 'mcpServer/elicitation/request'
      ? r.result?.action === 'accept' && JSON.stringify(r.result.content) === '{"choice":"Blue"}'
      : JSON.stringify(r.result?.answers) === '{"choice":{"answers":["Blue"]}}')).toBe(true)
  })
  it('reports failed turns and unexpected child exit to subscribers', async () => {
    const f = await fixture(); const { threadId } = await create(f)
    await f.script({ fail: true }); await f.host.execute({ type: 'send', threadId, commandId: 'send', messageId: 'message', text: 'Synthetic prompt' })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.status).toBe('error')
    const connected: boolean[] = []; f.host.subscribe(s => connected.push(s.connected))
    await f.action(threadId, { type: 'exit' })
    await expect.poll(() => connected.includes(false)).toBe(true)
  })
  it('routes attention requests and detects CLI takeover through AgentControl without mistaking its own prompt', async () => {
    const f = await fixture(true); const { threadId } = await create(f)
    const control = await startControl(f)
    await control.command({ type: 'assign', threadId }); await control.command({ type: 'select-thread', threadId })
    await control.command({ type: 'compose', text: 'Own prompt' }); expect((await control.command({ type: 'send' })).error).toBeNull()
    const directory = join(f.root, 'home', 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    const path = join(directory, `rollout-2026-09-10-${await f.realId(threadId)}.jsonl`)
    await writeFile(path, rolloutLine(1, { id: await f.realId(threadId), cwd: f.root }, 'session_meta') +
      rolloutLine(2, { type: 'user_message', client_id: control.get().host.threads.find(t => t.id === threadId)!.messages.find(m => m.role === 'user')!.id, message: 'Own prompt' }) +
      rolloutLine(3, { type: 'message', role: 'assistant', content: [] }, 'response_item'))
    await f.adapter.pollSessionLogs(); expect(control.get().assignments[0]!.mode).toBe('managed')
    await f.driver.raisePermission(threadId, 'Allow build?')
    await expect.poll(() => control.get().queue.some(q => q.kind === 'permission')).toBe(true)
    await control.command({ type: 'later' })
    expect((await f.driver.requests()).some(r => r.result?.decision === 'accept')).toBe(false)
    const requestId = control.get().queue.find(q => q.kind === 'permission')!.requestId!
    expect((await control.command({ type: 'answer', threadId, requestId, answer: '', approved: false })).error).toBeNull()
    await f.driver.raiseQuestion(threadId, 'Choose color')
    await expect.poll(() => control.get().queue.some(q => q.kind === 'question')).toBe(true)
    const questionId = control.get().queue.find(q => q.kind === 'question')!.requestId!
    await control.command({ type: 'answer', threadId, requestId: questionId, answer: 'Blue' })
    await appendFile(path, rolloutLine(4, { type: 'item_completed', item: { type: 'UserMessage', id: 'cli-user', content: [{ type: 'text', text: 'I am controlling this' }] } }))
    await expect.poll(() => control.get().assignments[0]!.mode).toBe('manual')
    expect(control.get().host.threads[0]!.messages.find(m => m.id === 'cli-user')!.commandId).toBeUndefined()
    expect(await readFile(join(f.root, 'codex-threads.json'), 'utf8')).not.toContain('Own prompt')
  })
})

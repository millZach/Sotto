// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { codexFixture } from '../../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const controls: AgentControl[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})
async function fixture(wrapped = false, timeout = 1000) {
  const f = await codexFixture(undefined, wrapped, timeout); fixtures.push(f)
  await f.host.connect(f.connection)
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
    await restarted.host.connect(f.connection)
    expect((await restarted.host.snapshot()).threads[0]).toEqual(before)
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
  it('ignores unknown observed sessions and closes unanswered questions with an empty answer', async () => {
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
    restarted.host.observeThreads?.([threadId]); await restarted.host.connect(f.connection)
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
  it.each(['item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'])('delivers question answers for %s', async method => {
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
    const line = (ordinal: number, payload: unknown, type = 'event_msg') => JSON.stringify({ timestamp: new Date().toISOString(), ordinal, type, payload }) + '\n'
    await writeFile(path, line(1, { id: await f.realId(threadId), cwd: f.root }, 'session_meta') +
      line(2, { type: 'item_completed', item: { type: 'UserMessage', id: 'own-rollout', content: [{ type: 'text', text: 'Own prompt' }] } }) +
      line(3, { type: 'message', role: 'assistant', content: [] }, 'response_item'))
    await f.adapter.pollSessions(); expect(control.get().assignments[0]!.mode).toBe('managed')
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
    await appendFile(path, line(4, { type: 'item_completed', item: { type: 'UserMessage', id: 'cli-user', content: [{ type: 'text', text: 'I am controlling this' }] } }))
    await expect.poll(() => control.get().assignments[0]!.mode).toBe('manual')
    expect(control.get().host.threads[0]!.messages.find(m => m.id === 'cli-user')!.commandId).toBeUndefined()
    expect(await readFile(join(f.root, 'codex-threads.json'), 'utf8')).not.toContain('Own prompt')
  })
})

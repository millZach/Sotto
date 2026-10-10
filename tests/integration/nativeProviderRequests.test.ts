// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { CodexProcess, RpcFrame } from '../../src/main/agents/codexProcess'
import type { GrokRpc } from '../../src/main/agents/grokRpc'
import type { AdapterFixture } from '../fixtures/adapterFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

for (const provider of ['claude', 'grok'] as const) it(`${provider} does not replay an already dispatched native request after reconnect`, async () => {
  let f: AdapterFixture = provider === 'claude' ? await claudeFixture() : await grokFixture()
  const threadId = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
    if (provider === 'claude') await (f as Awaited<ReturnType<typeof claudeFixture>>).action(threadId, { type: 'permission', requestId: 'persistent-request', text: 'Build?' })
    else await f.driver.raisePermission(threadId, 'Build?')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.requests.length).toBe(1)
    const request = (await f.host.snapshot()).threads[0]!.requests[0]!
    expect(await f.host.execute({ type: 'answer', commandId: 'answer', threadId, requestId: request.id, answer: '', approved: true })).toEqual({ accepted: true })
    f = await f.driver.restart(); await f.host.connect()
    // Each thread runs its own process, so a pending request can only come from one whose session is loaded.
    f.host.observeThreads?.([threadId])
    if (provider === 'claude') {
      await (f as Awaited<ReturnType<typeof claudeFixture>>).action(threadId, { type: 'permission', requestId: 'persistent-request', text: 'Build?' })
    } else await f.driver.raisePermission(threadId, 'Build?')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.requests[0]?.delivery).toBe('uncertain')
    expect(await f.host.execute({ type: 'answer', commandId: 'replay', threadId, requestId: request.id, answer: '', approved: true })).toEqual({ accepted: false, uncertain: true })
    expect((await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) === true)).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('grok raises session permissions only on the process that holds the session', async () => {
  const f = await grokFixture(undefined, 2000, 60000); const threadId = randomUUID()
  let probe: GrokRpc | undefined
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
    f.host.disconnect(); await f.host.closed(); await f.host.connect()
    // The provider probe is a real fake-client process, with no loaded session and no thread RPC ownership.
    const native = f.host as unknown as { spawn(executable: string, lost: () => void): GrokRpc }
    probe = native.spawn(process.execPath, () => undefined)
    await probe.request('initialize', { protocolVersion: 1 })
    await f.driver.raisePermission(threadId, 'Synthetic permission before load')
    // The fixture checks control input before handling a protocol frame. This deliberately gives the
    // unowned probe the first chance to consume a request intended for the session's next process.
    await probe.request('initialize', { protocolVersion: 1 })
    expect((await f.driver.requests()).filter(record => record.method === 'fixture/control-claimed')).toEqual([])
    await f.host.startThreadSession(threadId)
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.requests.length).toBe(1)
    const claims = (await f.driver.requests()).filter(record => record.method === 'fixture/control-claimed')
    expect(claims).toHaveLength(1); expect(claims[0]?.params).toEqual({ type: 'permission', resident: true })
  } finally { probe?.close(); await probe?.closed; await f.cleanup() }
})

for (const provider of ['claude', 'grok'] as const) it(`${provider} pins structured answers and reserves concurrent decisions once`, async () => {
  const f = provider === 'claude' ? await claudeFixture() : await grokFixture()
  const first = randomUUID(); const second = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    for (const threadId of [first, second]) await f.host.execute({ type: 'create-thread', commandId: threadId, threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.driver.raiseQuestion(first, 'Which?')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === first)?.requests.length).toBe(1)
    await f.driver.raisePermission(second, 'Build?')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === second)?.requests.length).toBe(1)
    const [a, b] = [first, second].map(id => f.host.snapshot().then(snapshot => snapshot.threads.find(t => t.id === id)!.requests[0]!))
    const question = await a!; const permission = await b!
    await expect(f.host.execute({ type: 'answer', commandId: 'wrong', threadId: second, requestId: question.id, answer: 'wrong' })).rejects.toThrow('pending')
    expect(await f.host.execute({ type: 'answer', commandId: 'question', threadId: first, requestId: question.id, answer: '', questionAnswers: { '0': { optionIds: [], text: 'Free text' } } })).toEqual({ accepted: true })
    const choice = permission.permissionChoices!.find(choice => choice.kind === 'allow-once')!
    const answers = await Promise.all([
      f.host.execute({ type: 'answer', commandId: 'one', threadId: second, requestId: permission.id, answer: '', approved: true, permissionChoice: choice.id }),
      f.host.execute({ type: 'answer', commandId: 'two', threadId: second, requestId: permission.id, answer: '', approved: true, permissionChoice: choice.id }),
    ])
    expect(answers.filter(result => result.accepted)).toHaveLength(1)
    // The fake provider records what it was asked in a file it appends to, so the record of the
    // accepted decision can land just after the answer resolves. Wait for it rather than assume it,
    // then read the count once more: a second decision would still fail, because nothing is in
    // flight once both answers have settled.
    const decisions = async (): Promise<number> =>
      (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) === true).length
    const expected = provider === 'claude' ? 2 : 1
    await expect.poll(decisions).toBe(expected)
    expect(await decisions()).toBe(expected)
  } finally { await f.cleanup() }
})

it('codex says a request for the user went unread instead of letting the refusal pass as an answer', async () => {
  const f = await codexFixture()
  const threadId = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
    // A renamed approval: Codex still wants a person, and Sotto's refusal would otherwise read as a denial.
    await f.action(threadId, { type: 'permission', text: 'Delete the branch?', method: 'item/commandExecution/v2/requestApproval' })
    await expect.poll(async () => (await f.host.snapshot()).error ?? '').toContain('only you can answer')
    expect((await f.host.snapshot()).threads[0]!.requests).toEqual([])
  } finally { await f.cleanup() }
})

it('codex stays quiet about requests Sotto is never meant to answer', async () => {
  const f = await codexFixture()
  const threadId = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.action(threadId, { type: 'permission', text: 'What time is it?', method: 'currentTime/read' })
    await expect.poll(async () => (await f.driver.requests()).some(record => (record as { error?: { code?: number } }).error?.code === -32601)).toBe(true)
    expect((await f.host.snapshot()).error ?? '').not.toContain('only you can answer')
  } finally { await f.cleanup() }
})

it.each(['unknown-child', null])('codex reports a refused approval with thread ID %s on a session app-server', async nativeThreadId => {
  const f = await codexFixture()
  const threadId = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
    // The payload's thread ID is unknown; only the app-server's session ownership is established.
    await f.action(threadId, { type: 'permission', text: 'Build?', params: { threadId: nativeThreadId } })
    await expect.poll(async () => (await f.driver.requests()).some(record => (record as { error?: { code?: number } }).error?.code === -32601)).toBe(true)
    await expect.poll(async () => (await f.host.snapshot()).error ?? '').toContain('Codex asked for an approval Sotto could not show')
    expect((await f.host.snapshot()).error).toContain('The request was refused')
    expect((await f.host.snapshot()).threads[0]!.requestNotice).toContain('The request was refused')
    expect((await f.host.snapshot()).threads[0]!.requests).toEqual([])
    expect((await f.driver.requests()).some(record => record.result?.decision?.toString().startsWith('accept'))).toBe(false)
  } finally { await f.cleanup() }
})

it('codex keeps an unknown approval on the provider app-server quiet', async () => {
  const f = await codexFixture()
  try {
    await f.host.connect()
    const adapter = f.adapter as unknown as { provider: CodexProcess; frame(server: CodexProcess, frame: RpcFrame): Promise<void> }
    const write = vi.spyOn(adapter.provider, 'write')
    await adapter.frame(adapter.provider, { id: 999, method: 'item/commandExecution/requestApproval', params: { threadId: 'foreign' } })
    expect(write).toHaveBeenCalledWith({ id: 999, error: { code: -32601, message: 'Sotto does not handle this request.' } })
    expect((await f.host.snapshot()).error).toBeUndefined()
    write.mockRestore()
  } finally { await f.cleanup() }
})

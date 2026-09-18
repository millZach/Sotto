// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AdapterFixture } from './adapterContract'

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
    if (provider === 'claude') {
      f.host.observeThreads?.([threadId])
      await (f as Awaited<ReturnType<typeof claudeFixture>>).action(threadId, { type: 'permission', requestId: 'persistent-request', text: 'Build?' })
    } else await f.driver.raisePermission(threadId, 'Build?')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.requests[0]?.delivery).toBe('uncertain')
    expect(await f.host.execute({ type: 'answer', commandId: 'replay', threadId, requestId: request.id, answer: '', approved: true })).toEqual({ accepted: false, uncertain: true })
    expect((await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) === true)).toHaveLength(1)
  } finally { await f.cleanup() }
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

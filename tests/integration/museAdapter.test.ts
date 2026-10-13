// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { describeAdapterContract } from './adapterContract'
import { museFixture, museFixtureSkips } from '../fixtures/museFixture'

describeAdapterContract('Muse MSP', session => museFixture(undefined, undefined, session), museFixtureSkips)

const open = async () => {
  const f = await museFixture()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
  return { f, id }
}
const thread = async (f: Awaited<ReturnType<typeof museFixture>>, id: string) =>
  (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!

it('recovers missed history after a view gap without blocking its resume reply or duplicating messages', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.action(id, { type: 'gap', text: 'A reply missed by the stream', repeat: true })
    await expect.poll(async () => (await thread(f, id)).messages.filter(message => message.text === 'A reply missed by the stream').length).toBe(1)
    expect((await thread(f, id)).status).toBe('running')
    expect((await f.driver.requests()).filter(record => record.method === 'session/resume')).toHaveLength(1)
    await f.driver.completeTurn(id, 'The stream still works')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).messages.map(message => message.text)).toContain('The stream still works')
  } finally { await f.cleanup() }
})

it.each(['malformed', 'gap'] as const)('closes a lost host after %s and lets its thread restart', async type => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    if (type === 'gap') await f.script({ rejectResume: true })
    await f.action(id, { type })
    await expect.poll(async () => (await thread(f, id)).status).toBe('error')
    await expect.poll(() => f.sessions.stopped(id)).toBe(true)
    expect((await f.host.snapshot()).connected).toBe(true)
    await f.script({})
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'next', text: 'Try again' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Recovered')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).messages.map(message => message.text)).toContain('Recovered')
  } finally { await f.cleanup() }
})

it('fails a prompt whose host ends after the turn acknowledgement and before message delivery', async () => {
  const { f, id } = await open()
  try {
    await f.script({ suppressUserMessage: true })
    const send = f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await expect.poll(async () => (await thread(f, id)).lastTurn).toEqual({ id: 'first', status: 'running' })
    await f.action(id, { type: 'exit' })
    await expect(send).resolves.toEqual({ accepted: false, uncertain: true })
    expect((await thread(f, id)).status).toBe('error')
    await f.script({})
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'second', text: 'Continue' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Recovered after process loss')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
  } finally { await f.cleanup() }
})

it('offers the permission modes the client let a probe select, and only those (ADR-0075)', async () => {
  const openF = await museFixture()
  try {
    await openF.script({ ceiling: true })
    const snapshot = await openF.host.connect()
    // Under the fixture's ceiling, allowAll and onRequest are refused, so neither is promised.
    expect(snapshot.models[0]?.runtimeModes).toEqual(['approval-required'])
  } finally { await openF.cleanup() }
  const { f, id } = await open()
  try {
    const snapshot = await f.host.snapshot()
    expect(snapshot.models[0]?.runtimeModes).toEqual(['approval-required', 'auto', 'full-access'])
    expect((await thread(f, id)).runtimeMode).toBe('approval-required')
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })
    expect((await thread(f, id)).runtimeMode).toBe('full-access')
    expect((await f.driver.requests()).filter(record => record.method === 'session/setApprovalMode')
      .map(record => record.params)).toEqual([expect.objectContaining({ mode: 'allowAll' })])
  } finally { await f.cleanup() }
})

it('sends the chosen reasoning effort on the turn, and Muse’s tier list in order', async () => {
  const { f, id } = await open()
  try {
    const model = (await f.host.snapshot()).models[0]!
    expect(model.reasoningEfforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(model.defaultReasoningEffort).toBe('high')
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    const starts = (await f.driver.requests()).filter(record => record.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.params).toMatchObject({ reasoningEffort: 'high' })
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'low' })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'second', text: 'Again' })
    expect((await f.driver.requests()).filter(record => record.method === 'turn/start')[1]?.params)
      .toMatchObject({ reasoningEffort: 'low' })
  } finally { await f.cleanup() }
})

it('steers a running turn and refuses to steer an idle one', async () => {
  const { f, id } = await open()
  try {
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'too-early', text: 'Wait' }))
      .rejects.toThrow('no running turn to steer')
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'steered', text: 'Also check the tests' }))
      .resolves.toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'turn/steer')).toHaveLength(1)
    expect((await thread(f, id)).messages.map(message => message.id)).toContain('steered')
    await f.driver.completeTurn(id, 'Done after steering')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const finished = await thread(f, id)
    expect(finished.lastTurn).toEqual({ id: 'first', status: 'completed' })
    expect(finished.activities?.filter(activity => activity.kind === 'turn')).toEqual([
      expect.objectContaining({ turnId: 'first', status: 'completed' }),
    ])
  } finally { await f.cleanup() }
})

it('refuses a client Sotto cannot drive: an older one, and another MSP version', async () => {
  const old = await museFixture()
  try {
    await old.script({ cliVersion: '1.0.0' })
    await expect(old.host.connect()).rejects.toThrow('Could not connect Muse.')
    expect((await old.host.snapshot()).connected).toBe(false)
  } finally { await old.cleanup() }
  const future = await museFixture()
  try {
    await future.script({ schemaVersion: 2 })
    await expect(future.host.connect()).rejects.toThrow('Could not connect Muse.')
  } finally { await future.cleanup() }
})

it('keeps the account’s keys out of the client’s environment', async () => {
  const saved = process.env.META_API_KEY
  process.env.META_API_KEY = 'fixture-secret'
  try {
    const { f } = await open()
    try {
      const processes = (await f.driver.requests()).filter(record => record.method === 'fixture/process')
      expect(processes.length).toBeGreaterThan(0)
      for (const started of processes) expect((started.params as { environment?: unknown }).environment).toEqual({})
    } finally { await f.cleanup() }
  } finally { if (saved === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = saved }
})

it('answers a question with free text when it names no option, and cancels on a decline', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.driver.raiseQuestion(id, 'Which color?')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '',
      questionAnswers: { q1: { optionIds: ['not-offered'] } } })).rejects.toThrow()
    expect((await f.driver.requests()).filter(record => record.method === 'userInput/answer')).toHaveLength(0)
    expect((await thread(f, id)).requests[0]?.delivery).toBeUndefined()
    expect(JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8'))[id].answeredRequestIds).not.toContain(request.id)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: 'Blue' })
    const answers = (await f.driver.requests()).filter(record => record.method === 'userInput/answer')
    expect(answers).toHaveLength(1)
    expect(answers[0]?.params).toMatchObject({ answers: [{ questionId: 'q1', freeText: 'Blue' }] })
    await f.driver.raiseQuestion(id, 'Another?')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const second = (await thread(f, id)).requests[0]!
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: second.id, answer: '', approved: false })
    expect((await f.driver.requests()).filter(record => record.method === 'userInput/cancel')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('does not start a side call when MSP cannot enforce that all tools are disabled', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const before = await readFile(join(f.root, 'oneshot.jsonl'), 'utf8')
    await expect(f.host.writeShortText!(id, { instruction: 'Name it.', material: 'Marker material' })).resolves.toBeNull()
    await expect(f.host.writeShortText!(id, { instruction: 'Name it.', material: 'Aborted material' }, AbortSignal.abort())).resolves.toBeNull()
    expect(await readFile(join(f.root, 'oneshot.jsonl'), 'utf8')).toBe(before)
    expect((await f.host.snapshot()).threads).toHaveLength(1)
    expect(JSON.stringify(await f.driver.requests())).not.toContain('Marker material')
  } finally { await f.cleanup() }
})

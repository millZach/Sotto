// @vitest-environment node
import { randomUUID } from 'node:crypto'
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

it('never lists a side call’s session as a thread, and writes at the lowest effort', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    await f.sideWriting.answer('A title')
    await expect(f.host.writeShortText!(id, { instruction: 'Name it.', material: 'Marker material' })).resolves.toBe('A title')
    expect((await f.host.snapshot()).threads).toHaveLength(1)
    expect(JSON.stringify(await f.driver.requests())).not.toContain('Marker material')
  } finally { await f.cleanup() }
})

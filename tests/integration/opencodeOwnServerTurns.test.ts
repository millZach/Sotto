// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { ownServerTurnText, type OwnServer } from '../../src/shared/ownModelServers'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'

/**
 * A thread on one of the user's own model servers (ADR-0124, October 24 amendment): while OpenCode tries the server
 * again its running turn says which try, and a turn the server let down records how, in words a phone can show too.
 */
const spark: OwnServer = {
  id: 'own-spark1', name: 'Spark', address: 'http://spark-head:8888/v1', keyed: false,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 163_840, thinking: false, images: false }],
}
const OWN_MODEL = { id: 'deepseek-v4.1-flash', modelID: 'deepseek-v4.1-flash', providerID: 'own-spark1', name: 'DeepSeek V4.1 Flash',
  capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], enabled: true, status: 'active', limit: { context: 163_840, output: 32_000 } }
const FIXTURE_MODEL = { id: 'fixture-model', modelID: 'fixture-model', providerID: 'opencode', name: 'Fixture Model',
  capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], enabled: true, status: 'active', limit: { context: 200_000, output: 32_000 } }
const WORDS = { name: 'Spark', model: 'DeepSeek V4.1 Flash', host: 'spark-head:8888' }

async function ownServerThread(modelId = 'own-spark1/deepseek-v4.1-flash', servers: readonly OwnServer[] = [spark]) {
  const f = await opencodeFixture(undefined, undefined, {}, { ownServers: async () => servers })
  await f.script({ models: [FIXTURE_MODEL, OWN_MODEL], providers: [{ id: 'opencode', name: 'OpenCode', activation: 'enabled' }, { id: 'own-spark1', name: 'Spark', activation: 'enabled' }] })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId, title: 'Own server thread' })
  f.host.observeThreads?.([id])
  const thread = async () => (await f.host.snapshot()).threads.find(item => item.id === id)
  const turn = async (messageId: string): Promise<AgentActivity | undefined> => (await thread())?.activities?.find(record => record.kind === 'turn' && record.turnId === messageId)
  const send = async (messageId: string): Promise<void> => {
    expect(await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId, text: 'Synthetic prompt' })).toEqual({ accepted: true })
    await expect.poll(async () => (await turn(messageId))?.status).toBe('running')
  }
  return { f, id, thread, turn, send }
}

it('says which try OpenCode is on while it tries the server again, and lets the reply take the line back', async () => {
  const { f, id, turn, send } = await ownServerThread()
  try {
    await send('first')
    // The running turn knows its server from the start, so the window can say it is still waiting on it.
    expect((await turn('first'))?.ownServer).toEqual(WORDS)
    // OpenCode's attempt numbers the request it makes next: attempt 2 is the first retry.
    await f.action(id, { type: 'retry', attempt: 2 })
    await expect.poll(async () => (await turn('first'))?.ownServer).toEqual({ ...WORDS, attempt: 1, attempts: 10 })
    await f.action(id, { type: 'retry', attempt: 4 })
    await expect.poll(async () => (await turn('first'))?.ownServer?.attempt).toBe(3)
    await f.action(id, { type: 'reply', text: 'Back again.' })
    await expect.poll(async () => (await turn('first'))?.ownServer).toEqual(WORDS)
    await f.action(id, { type: 'complete', text: 'Done.' })
    await expect.poll(async () => (await turn('first'))?.status).toBe('completed')
    expect((await turn('first'))?.error).toBeUndefined()
    // Nothing the server said reaches a log: OpenCode's adapter logs stable event names only.
    expect(f.events.every(event => /^opencode-[a-z-]+$/u.test(event))).toBe(true)
  } finally { await f.cleanup() }
})

it('records how the server let each turn down, in the words a phone and Watcher’s news read too', async () => {
  const { f, id, turn, send } = await ownServerThread()
  try {
    const cases = [
      [{ error: 'provider.transport', message: 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?' }, 'unreachable'],
      [{ error: 'provider.timeout', message: 'The operation timed out.' }, 'timeout'],
      [{ error: 'provider.auth', status: 401, message: 'Invalid API key.' }, 'key-refused'],
      [{ error: 'provider.invalid-request', status: 404, message: 'The model `deepseek-v4.1-flash` does not exist.' }, 'model-gone'],
      [{ error: 'provider.invalid-request', status: 400, message: 'This model\'s maximum context length is 163840 tokens. However, you requested 170000 tokens.' }, 'too-long'],
    ] as const
    for (const [index, [error, failure]] of cases.entries()) {
      const messageId = `turn-${index}`
      await send(messageId)
      await f.action(id, { type: 'fail', ...error })
      await expect.poll(async () => (await turn(messageId))?.status).toBe('failed')
      expect(await turn(messageId)).toMatchObject({ error: ownServerTurnText(failure, WORDS), ownServer: { ...WORDS, failure } })
    }
    // What the server said is matched, never kept: no record carries its message.
    expect(JSON.stringify((await f.host.snapshot()).threads)).not.toContain('Invalid API key.')
  } finally { await f.cleanup() }
})

it('stops the turn when the server sent nothing within OpenCode’s five minutes, as the thread said it would', async () => {
  const { f, id, turn, send } = await ownServerThread()
  try {
    await send('first')
    // OpenCode 2.1.4 would try a silent server three more times, five minutes each; Sotto ends the turn at the first.
    await f.action(id, { type: 'retry', attempt: 2, message: 'Timed out waiting for response headers' })
    await expect.poll(async () => (await turn('first'))?.status).toBe('failed')
    expect(await turn('first')).toMatchObject({ error: ownServerTurnText('timeout', WORDS), ownServer: { ...WORDS, failure: 'timeout' } })
    expect((await turn('first'))?.ownServer?.attempt).toBeUndefined()
    expect((await f.driver.requests()).filter(record => record.method === 'session.interrupt')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('leaves a failure the server did not cause, and every other model source, with OpenCode’s general words', async () => {
  const own = await ownServerThread()
  try {
    await own.send('first')
    await own.f.action(own.id, { type: 'fail', error: 'provider.content-filter', message: 'Blocked' })
    await expect.poll(async () => (await own.turn('first'))?.status).toBe('failed')
    expect((await own.turn('first'))?.ownServer?.failure).toBeUndefined()
    expect((await own.turn('first'))?.error).toContain('OpenCode could not finish this turn.')
  } finally { await own.f.cleanup() }
  const other = await ownServerThread('opencode/fixture-model')
  try {
    await other.send('first')
    expect((await other.turn('first'))?.ownServer).toBeUndefined()
    await other.f.action(other.id, { type: 'retry', attempt: 2 })
    await other.f.action(other.id, { type: 'fail', error: 'provider.transport', message: 'ECONNREFUSED' })
    await expect.poll(async () => (await other.turn('first'))?.status).toBe('failed')
    expect(await other.turn('first')).toMatchObject({ error: expect.stringContaining('OpenCode could not finish this turn.') })
    expect((await other.turn('first'))?.ownServer).toBeUndefined()
  } finally { await other.f.cleanup() }
})

it('says nothing of its own while the Owl feature is off, when OpenCode is given no server', async () => {
  const { f, id, turn, send } = await ownServerThread('own-spark1/deepseek-v4.1-flash', [])
  try {
    await send('first')
    expect((await turn('first'))?.ownServer).toBeUndefined()
    await f.action(id, { type: 'fail', error: 'provider.transport', message: 'ECONNREFUSED' })
    await expect.poll(async () => (await turn('first'))?.status).toBe('failed')
    expect((await turn('first'))?.ownServer).toBeUndefined()
  } finally { await f.cleanup() }
})

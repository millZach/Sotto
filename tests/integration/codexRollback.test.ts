// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup() })
async function setup(timeout = 1000) {
  const f = await codexFixture(undefined, true, timeout); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Owned fixture', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'sotto-thread', projectId: 'project', title: 'Rewind', modelId: f.modelId })
  const send = async (id: string) => {
    await f.script({ reply: `Answer ${id}` })
    await f.host.execute({ type: 'send', commandId: `send-${id}`, threadId: 'sotto-thread', messageId: id, text: `Message ${id}` })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]!.status).toBe('idle')
    await f.host.refreshThread!('sotto-thread')
  }
  await send('first'); await send('second')
  return { f, send }
}
it('rewinds exact native history through the stable Sotto binding and retains the rewind after restart', async () => {
  const { f } = await setup()
  const before = (await f.host.snapshot()).threads[0]!, nativeId = await f.realId(before.id)
  expect(await f.host.rollbackThread!('sotto-thread', 1, ['first', 'second'])).toEqual({ accepted: true })
  const after = (await f.host.refreshThread!('sotto-thread')).threads[0]!
  expect(after.messages.map(message => message.text)).toEqual(['Message first', 'Answer first'])
  expect(after.id).toBe(before.id)
  expect(await f.realId(after.id)).toBe(nativeId)
  const restored = await f.driver.restart()
  // The original fixture owns the shared temporary directory cleanup.
  try {
    await restored.host.connect(); const snapshot = await restored.host.refreshThread!('sotto-thread')
    expect(snapshot.threads[0]!.messages.map(message => message.text)).toEqual(['Message first', 'Answer first'])
    expect(snapshot.threads[0]!.historyEpoch).toBe(after.historyEpoch)
    expect((await restored.driver.requests()).filter(request => request.method === 'thread/rollback')).toHaveLength(1)
  } finally { restored.host.disconnect(); await restored.adapter.closed() }
})

it('reconciles a lost native acknowledgement through history without replaying rollback', async () => {
  const { f } = await setup(150)
  await f.script({ dropRollbackReply: true })
  expect(await f.host.rollbackThread!('sotto-thread', 1, ['first', 'second'])).toEqual({ accepted: false, uncertain: true })
  const after = (await f.host.refreshThread!('sotto-thread')).threads[0]!
  expect(after.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['first'])
  expect((await f.driver.requests()).filter(request => request.method === 'thread/rollback')).toHaveLength(1)
})

it('does not infer confirmed rollback from a response missing its full history', async () => {
  const { f } = await setup()
  await f.script({ omitRollbackTurns: true })
  expect(await f.host.rollbackThread!('sotto-thread', 1, ['first', 'second'])).toEqual({ accepted: false, uncertain: true })
  await f.host.connect()
  await f.host.refreshThread!('sotto-thread')
  expect((await f.host.snapshot()).threads[0]!.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['first'])
})

it('guards stale history and active turns before any native rewind is sent', async () => {
  const { f } = await setup()
  await expect(f.host.rollbackThread!('sotto-thread', 1, ['first', 'wrong'])).rejects.toThrow('changed')
  await f.script({})
  await f.host.execute({ type: 'send', commandId: 'third', threadId: 'sotto-thread', messageId: 'third', text: 'Keep working' })
  await expect(f.host.rollbackThread!('sotto-thread', 1, ['first', 'second', 'third'])).rejects.toThrow('pending')
  expect((await f.driver.requests()).filter(request => request.method === 'thread/rollback')).toEqual([])
})

it('rewinds a steered turn once and rejects a checkpoint in the middle of that native turn', async () => {
  const { f } = await setup()
  await f.script({})
  await f.host.execute({ type: 'send', commandId: 'third', threadId: 'sotto-thread', messageId: 'third', text: 'Keep working' })
  await f.host.execute({ type: 'steer', commandId: 'steer', threadId: 'sotto-thread', messageId: 'steered', text: 'Change direction' })
  await f.driver.completeTurn('sotto-thread', 'Completed both inputs')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]!.status).toBe('idle')
  await expect(f.host.rollbackThread!('sotto-thread', 1, ['first', 'second', 'third', 'steered'])).rejects.toThrow('split a native turn')
  expect(await f.host.rollbackThread!('sotto-thread', 2, ['first', 'second', 'third', 'steered'])).toEqual({ accepted: true })
  const request = (await f.driver.requests()).find(request => request.method === 'thread/rollback')!
  expect(request.params?.numTurns).toBe(1)
  expect((await f.host.snapshot()).threads[0]!.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['first', 'second'])
})

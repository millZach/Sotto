// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture(timeout = 1000) {
  const f = await codexFixture(undefined, true, timeout); fixtures.push(f)
  const threadId = randomUUID()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, path: f.root, title: 'Fixture' })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Steer' })
  await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'original', text: 'Original turn' })
  return { f, threadId }
}
it('uses installed turn/steer shape on the same active native turn and reconciles exact Sotto message identity', async () => {
  const { f, threadId } = await fixture()
  const command = { type: 'steer' as const, commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Focus on tests', expectedLastUserMessageId: 'original' }
  expect(await f.host.execute(command)).toEqual({ accepted: true })
  const requests = await f.driver.requests()
  const start = requests.findLast(r => r.method === 'turn/start')!
  const steer = requests.findLast(r => r.method === 'turn/steer')!
  expect(steer.params).toEqual({ threadId: start.params!.threadId, expectedTurnId: expect.any(String), input: [{ type: 'text', text: command.text }] })
  expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(requests.filter(r => r.method === 'turn/interrupt')).toHaveLength(0)
  const thread = (await f.host.snapshot()).threads.find(t => t.id === threadId)!
  expect(thread.status).toBe('running')
  expect(thread.messages.filter(m => m.role === 'user')).toHaveLength(2)
  expect(thread.messages).toContainEqual(expect.objectContaining({ id: command.messageId, commandId: command.commandId }))
})
it('keeps lost steer acknowledgement uncertain and reconciles on resume without a second steer', async () => {
  const { f, threadId } = await fixture(500)
  await f.script({ delay: { method: 'turn/steer', ms: 1500 }, suppressNotifications: true })
  const command = { type: 'steer' as const, commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'A single correction' }
  expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
  await f.host.snapshot()
  expect(await f.host.execute(command)).toEqual({ accepted: true })
  expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(1)
})
it('rejects absent active turns and pending permissions before writing steer or interrupt', async () => {
  const { f, threadId } = await fixture()
  await f.driver.raisePermission(threadId, 'Approve?')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.requests.length).toBe(1)
  const steer = { type: 'steer' as const, commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Correction' }
  await expect(f.host.execute(steer)).rejects.toThrow(/pending Codex request/)
  await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId })
  await expect(f.host.execute(steer)).rejects.toThrow(/active Codex turn changed/)
  expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(0)
})

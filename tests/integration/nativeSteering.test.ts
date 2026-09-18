// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.cleanup() })
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function selectedSkill(f: Awaited<ReturnType<typeof codexFixture>>) {
  const skill = { name: 'native-review', path: join(f.root, 'SKILL.md') }
  await f.script({ skills: [{ ...skill, description: 'Synthetic review', enabled: true, scope: 'repo' }] })
  return skill
}
async function fixture() {
  const f = await codexFixture(undefined, true); fixtures.push(f)
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
  expect(steer.params).toEqual({ threadId: start.params!.threadId, expectedTurnId: expect.any(String), clientUserMessageId: command.messageId, input: [{ type: 'text', text: command.text }] })
  expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(requests.filter(r => r.method === 'turn/interrupt')).toHaveLength(0)
  const thread = (await f.host.snapshot()).threads.find(t => t.id === threadId)!
  expect(thread.status).toBe('running')
  expect(thread.messages.filter(m => m.role === 'user')).toHaveLength(2)
  expect(thread.messages).toContainEqual(expect.objectContaining({ id: command.messageId, commandId: command.commandId }))
})
it('keeps lost steer acknowledgement uncertain and reconciles on resume without a second steer', async () => {
  const { f, threadId } = await fixture()
  await f.script({ delay: { method: 'turn/steer', ms: 3000 }, suppressNotifications: true })
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

it('steers with the exact selected native skill without starting another turn', async () => {
  const { f, threadId } = await fixture()
  const skill = await selectedSkill(f)
  const text = '$native-review Focus on tests'
  expect(await f.host.execute({ type: 'steer', threadId, commandId: randomUUID(), messageId: randomUUID(), text, skills: [skill] })).toEqual({ accepted: true })
  const requests = await f.driver.requests()
  expect(requests.findLast(request => request.method === 'turn/steer')?.params?.input).toEqual([
    { type: 'text', text }, { type: 'skill', ...skill },
  ])
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
})

it('reserves steering while asynchronous skill validation is pending', async () => {
  const { f, threadId } = await fixture()
  const skill = await selectedSkill(f)
  const validation = gate()
  const prepare = f.adapter.prepareSkillInput.bind(f.adapter)
  const pending = vi.spyOn(f.adapter, 'prepareSkillInput').mockImplementationOnce(async (...args) => { await validation.promise; return prepare(...args) })
  const command = { type: 'steer' as const, threadId, commandId: randomUUID(), messageId: randomUUID(), text: '$native-review First correction', skills: [skill] }
  const first = f.host.execute(command)
  let firstResult: unknown
  try {
    await vi.waitFor(() => expect(pending).toHaveBeenCalled())
    await expect(f.host.execute({ ...command, commandId: randomUUID(), messageId: randomUUID(), text: '$native-review Concurrent correction' })).rejects.toThrow('already being submitted')
  } finally {
    validation.release()
    firstResult = await first.catch(error => error)
  }
  expect(firstResult).toEqual({ accepted: true })
  expect((await f.driver.requests()).filter(request => request.method === 'turn/steer')).toHaveLength(1)
})

it('rejects a catalog invalidated while the steering origin is being saved', async () => {
  const { f, threadId } = await fixture()
  const skill = await selectedSkill(f)
  const save = gate()
  const persistence = f.adapter as unknown as { persist(): Promise<void> }
  const persist = persistence.persist.bind(f.adapter)
  const saving = vi.spyOn(persistence, 'persist').mockImplementationOnce(async () => { await save.promise; await persist() })
  const result = f.host.execute({ type: 'steer', threadId, commandId: randomUUID(), messageId: randomUUID(), text: '$native-review Check once', skills: [skill] })
  let outcome: unknown
  try {
    await vi.waitFor(() => expect(saving).toHaveBeenCalled())
    await f.script({ skillsChanged: true, skills: [{ ...skill, description: 'Synthetic review', enabled: false, scope: 'repo' }] })
    expect((await f.host.listThreadSkills!(threadId, true)).status).toBe('error')
  } finally {
    save.release()
    outcome = await result.catch(error => error)
  }
  expect(outcome).toBeInstanceOf(Error)
  expect((outcome as Error).message).toMatch(/skills changed/)
  expect((await f.driver.requests()).filter(request => request.method === 'turn/steer')).toHaveLength(0)
})

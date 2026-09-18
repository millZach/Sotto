// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
async function fixture() {
  const f = await codexFixture(undefined, true)
  cleanup.push(f.cleanup)
  await f.host.connect()
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic' })
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => false, encryptString: t => Buffer.from(t), decryptString: t => t.toString() })
  await credentials.load()
  const c = new AgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Synthetic', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Synthetic', expiresAt: null }) } })
  cleanup.push(async () => { c.dispose(); await c.privacyChanged() })
  await c.start(); await c.command({ type: 'connect' })
  const current = () => c.get().host.threads.find(t => t.id === threadId)!
  return { f, c, threadId, current }
}
it.each([false, true])('corroborated legacy input preserves management unless external input is present=%s', async external => {
  const { f, c, threadId, current } = await fixture()
  await c.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Legacy own input' })
  await f.driver.completeTurn(threadId, 'Synthetic result')
  await expect.poll(() => current().status).toBe('idle')
  await c.command({ type: 'assign', threadId })
  const before = current().messages
  const state = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'))
  const thread = state.threads[await f.realId(threadId)]
  const turn = thread.turns[0]
  const sessions = join(f.root, 'home', 'sessions'); await mkdir(sessions, { recursive: true })
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Legacy own input' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic result' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: turn.items.at(-1).id, content: [{ type: 'output_text', text: 'Synthetic result' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } },
  ]
  if (external) {
    turn.items.push({ type: 'userMessage', id: 'foreign-input', clientId: 'foreign-client', content: [{ type: 'text', text: 'External follow-up' }] })
    events.splice(events.length - 1, 0, { type: 'event_msg', payload: { type: 'user_message', client_id: 'foreign-client', message: 'External follow-up' } })
  }
  // Exact legacy metadata and native history, all confined to this owned fixture.
  f.host.disconnect(); await f.adapter.closed()
  const aliasPath = join(f.root, 'codex-threads.json')
  const aliases = JSON.parse(await readFile(aliasPath, 'utf8'))
  for (const alias of Object.values(aliases) as Array<{ messageIdentities?: unknown; origins: Array<{ clientIdentity?: boolean }> }>) { delete alias.messageIdentities; for (const origin of alias.origins) delete origin.clientIdentity }
  delete turn.items[0].clientId
  await writeFile(aliasPath, JSON.stringify(aliases)); await writeFile(join(f.root, 'state.json'), JSON.stringify(state))
  await writeFile(join(sessions, `rollout-${thread.id}.jsonl`), events.map((e, ordinal) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal, ...e })).join('\n') + '\n')
  await f.script({ historyItemIds: true })
  await c.command({ type: 'connect' })
  expect(current().messages.map(m => [m.id, m.commandId])).toEqual(external ? expect.arrayContaining(before.map(m => [m.id, m.commandId])) : before.map(m => [m.id, m.commandId]))
  expect(c.get().assignments.find(a => a.threadId === threadId)?.mode).toBe(external ? 'manual' : 'managed')
  if (external) expect(current().messages).toContainEqual(expect.objectContaining({ text: 'External follow-up', role: 'user' }))
})
it.each([false, true])('lagging full history preserves an already completed assistant message, partial row=%s', async partial => {
  const { f, c, threadId, current } = await fixture()
  await c.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic' })
  const turnId = current().lastTurn!.id
  if (partial) {
    await f.action(threadId, { type: 'notify', persist: true, method: 'item/started', params: { turnId, item: { type: 'agentMessage', id: 'live-tail', text: 'Already' } } })
    await expect.poll(() => current().messages.find(m => m.id === 'live-tail')?.text).toBe('Already')
  }
  const event = new Promise<void>(resolve => { const off = f.host.subscribe(() => { off(); resolve() }) })
  // Native event arrives before its persisted history row, a normal write lag.
  await f.action(threadId, { type: 'notify', method: 'item/completed', params: { turnId, item: { type: 'agentMessage', id: 'live-tail', text: 'Already displayed' } } })
  await event
  expect(current().messages.some(m => m.id === 'live-tail')).toBe(true)
  if (partial) {
    const state = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'))
    expect(state.threads[await f.realId(threadId)].turns[0].items.at(-1).text).toBe('Already')
  }
  await f.host.refreshThread!(threadId)
  const after = (await f.host.snapshot()).threads.find(t => t.id === threadId)!
  expect(after.messages.some(m => m.id === 'live-tail')).toBe(true)
  expect(after.messages.find(m => m.id === 'live-tail')?.text).toBe('Already displayed')
})

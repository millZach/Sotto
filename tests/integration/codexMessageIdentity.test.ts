// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture() {
  const f = await codexFixture(undefined, true); fixtures.push(f)
  const threadId = randomUUID()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Identity', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Identity', modelId: f.modelId })
  const current = async () => (await f.host.snapshot()).threads.find(t => t.id === threadId)!
  const send = (type: 'send' | 'steer', text: string) => {
    const command = { type, threadId, commandId: randomUUID(), messageId: randomUUID(), text }
    return { command, sent: f.host.execute(command) }
  }
  const notify = async (method: string, params: Record<string, unknown>, persist = false) => {
    const event = new Promise<void>(resolve => { const off = f.host.subscribe(() => { off(); resolve() }) })
    await f.action(threadId, { type: 'notify', method, params, persist }); await event
  }
  const native = async () => JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')).threads[await f.realId(threadId)]
  return { f, threadId, current, send, notify, native }
}

async function authoredRollout(f: Awaited<ReturnType<typeof codexFixture>>, source: { id: string; turns: Array<{ id: string; items: Array<{ type: string; id: string; clientId?: string; content?: Array<{ text: string }>; text?: string }> }> }) {
  const lines: unknown[] = []
  for (const turn of source.turns) {
    lines.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } })
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        lines.push({ type: 'event_msg', payload: { type: 'user_message', message: item.content![0]!.text, client_id: item.clientId } })
      } else if (item.type === 'agentMessage') {
        lines.push({ type: 'event_msg', payload: { type: 'agent_message', message: item.text } },
          { type: 'response_item', payload: { type: 'message', role: 'assistant', id: item.id, content: [{ type: 'output_text', text: item.text }] } })
      }
    }
    lines.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } })
  }
  const sessions = join(f.root, 'home', 'sessions'); await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, `rollout-${source.id}.jsonl`), lines.map((line, ordinal) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal, ...line as object })).join('\n') + '\n')
}

it('preserves distinct repeated user/assistant messages, steer origins and activity anchors when native history regenerates item IDs', async () => {
  const { f, threadId, current, send, notify } = await fixture()
  const first = send('send', 'same'); await first.sent
  const turnId = (await current()).lastTurn!.id
  await notify('item/completed', { turnId, item: { id: 'live-commentary', type: 'agentMessage', text: 'same answer' } }, true)
  const steer1 = send('steer', 'same'); await steer1.sent
  const steer2 = send('steer', 'same'); await steer2.sent
  await notify('item/completed', { turnId, item: { id: 'live-command', type: 'commandExecution', command: 'synthetic', cwd: f.root, status: 'completed', exitCode: 0 } }, true)
  await f.driver.completeTurn(threadId, 'same answer')
  await expect.poll(async () => (await current()).lastTurn?.status).toBe('completed')
  const before = await current()
  expect(before.messages).toHaveLength(5)
  await f.script({ historyItemIds: true })
  await f.host.refreshThread!(threadId)
  expect((await current()).messages).toEqual(before.messages)
  expect((await current()).activities?.map(a => [a.id, a.afterMessageId]).sort()).toEqual(before.activities?.map(a => [a.id, a.afterMessageId]).sort())
  f.host.disconnect(); await f.adapter.closed()
  await f.host.connect()
  expect((await current()).messages).toEqual(before.messages)
  expect((await current()).activities?.map(a => [a.id, a.afterMessageId]).sort()).toEqual(before.activities?.map(a => [a.id, a.afterMessageId]).sort())
  for (const sent of [first, steer1, steer2]) expect((await current()).messages).toContainEqual(expect.objectContaining({ id: sent.command.messageId, commandId: sent.command.commandId }))
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(2)
})

it('keeps summary/not-loaded turn views out of message identity and origin reconciliation', async () => {
  const { current, send, notify } = await fixture()
  const first = send('send', 'same'); await first.sent
  const turnId = (await current()).lastTurn!.id
  const before = (await current()).messages
  await notify('turn/completed', { turn: { id: turnId, status: 'completed', itemsView: 'summary', items: [
    { type: 'userMessage', id: 'summary-user', content: [{ type: 'text', text: 'same' }] },
    { type: 'agentMessage', id: 'summary-answer', text: 'Display summary' },
  ] } })
  expect((await current()).messages).toEqual(before)
  await notify('turn/completed', { turn: { id: turnId, status: 'completed', itemsView: 'notLoaded', items: [] } })
  expect((await current()).messages).toEqual(before)
  await notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'actual-final', text: 'Full final answer' } })
  expect((await current()).messages).toHaveLength(2)
  expect((await current()).messages.at(-1)).toMatchObject({ id: 'actual-final', text: 'Full final answer' })
})

it('keeps native-authored identical input unowned and item IDs scoped across independent turns', async () => {
  const { f, threadId, current, send, notify, native } = await fixture()
  const first = send('send', 'same'); await first.sent
  await f.driver.completeTurn(threadId, 'same answer')
  await expect.poll(async () => (await current()).status).toBe('idle')
  await f.script({ historyItemIds: true })
  const second = send('send', 'same'); await second.sent
  const turnId = (await current()).lastTurn!.id
  await notify('item/completed', { turnId, item: { type: 'userMessage', id: 'native-only', clientId: 'foreign-client', content: [{ type: 'text', text: 'same' }] } }, true)
  const steer = send('steer', 'same'); await steer.sent
  await f.driver.completeTurn(threadId, 'same answer')
  await expect.poll(async () => (await current()).status).toBe('idle')
  const before = await current()
  expect(before.messages).toHaveLength(6)
  expect(before.messages.filter(m => m.role === 'user' && !m.commandId)).toEqual([expect.objectContaining({ id: 'native-only', text: 'same' })])
  await f.host.refreshThread!(threadId)
  expect((await current()).messages).toEqual(before.messages)
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
  expect((await current()).messages).toEqual(before.messages)
  const old = (await native()).turns[0]
  await notify('turn/completed', { turn: old })
  expect((await current()).lastTurn).toEqual(before.lastTurn)
  expect((await current()).messages).toEqual(before.messages)
})

it('does not infer legacy command authority when equal-text native-authored input makes the origin ambiguous', async () => {
  const { f, threadId, current, send, notify, native } = await fixture()
  await send('send', 'first').sent
  const steer = send('steer', 'repeated'); await steer.sent
  const turnId = (await current()).lastTurn!.id
  await notify('item/completed', { turnId, item: { type: 'userMessage', id: 'outside', content: [{ type: 'text', text: 'repeated' }] } }, true)
  await f.driver.completeTurn(threadId, 'done')
  await expect.poll(async () => (await current()).status).toBe('idle')
  const source = await native()
  f.host.disconnect(); await f.adapter.closed()
  const aliasPath = join(f.root, 'codex-threads.json')
  const aliases = JSON.parse(await readFile(aliasPath, 'utf8'))
  for (const alias of Object.values(aliases) as Array<{ origins: Array<{ clientIdentity?: boolean }>; messageIdentities?: unknown }>) {
    delete alias.messageIdentities; for (const origin of alias.origins) delete origin.clientIdentity
  }
  await writeFile(aliasPath, JSON.stringify(aliases))
  delete source.turns[0].items[1].clientId
  const stored = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')); stored.threads[source.id] = source
  await writeFile(join(f.root, 'state.json'), JSON.stringify(stored))
  await authoredRollout(f, source)
  await f.script({ historyItemIds: true }); await f.host.connect()
  const repeated = (await current()).messages.filter(m => m.role === 'user' && m.text === 'repeated')
  expect(repeated).toHaveLength(2)
  expect(repeated.every(m => m.commandId === undefined && m.id !== steer.command.messageId)).toBe(true)
  // An old uncertain/ambiguous origin is retained, never automatically replayed.
  expect(await f.host.execute(steer.command)).toEqual({ accepted: false, uncertain: true })
  expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(1)
})

it('joins corroborated watcher aliases to native history while preserving every repeated outside input', async () => {
  const { f, threadId, current, send, native, notify } = await fixture()
  await send('send', 'same').sent
  const turnId = (await current()).lastTurn!.id
  for (const id of ['outside-a', 'outside-b']) {
    await notify('item/completed', { turnId, item: { type: 'userMessage', id, content: [{ type: 'text', text: 'same' }] } }, true)
  }
  await f.driver.completeTurn(threadId, 'done')
  await expect.poll(async () => (await current()).status).toBe('idle')
  const before = await current()
  await authoredRollout(f, await native())
  await f.host.refreshThread!(threadId)
  expect((await current()).messages).toEqual(before.messages)
  expect((await current()).messages.filter(m => m.role === 'user' && !m.commandId)).toHaveLength(2)
  await f.script({ historyItemIds: true })
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
  expect((await current()).messages).toEqual(before.messages)
})

it('rejects a conflicting native client identity even when an ordered history slot has identical text', async () => {
  const { f, threadId, current, send, native } = await fixture()
  const sent = send('send', 'same'); await sent.sent
  await f.driver.completeTurn(threadId, 'answer')
  await expect.poll(async () => (await current()).status).toBe('idle')
  const source = await native()
  f.host.disconnect(); await f.adapter.closed()
  source.turns[0].items[0].clientId = 'explicit-foreign-client'
  const stored = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')); stored.threads[source.id] = source
  await writeFile(join(f.root, 'state.json'), JSON.stringify(stored))
  await f.script({ historyItemIds: true }); await f.host.connect()
  const messages = (await current()).messages
  expect(messages).toHaveLength(2)
  expect(messages[0]).toMatchObject({ role: 'user', text: 'same' })
  expect(messages[0]!.id).not.toBe(sent.command.messageId)
  expect(messages[0]!.commandId).toBeUndefined()
  expect(await f.host.execute(sent.command)).toEqual({ accepted: false, uncertain: true })
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
})

it('learns authoritative order after reordered notifications and ignores late completed/started/delta replays', async () => {
  const { current, send, notify, native } = await fixture()
  await send('send', 'first').sent
  const turnId = (await current()).lastTurn!.id
  const a = { id: 'earlier-answer', type: 'agentMessage', text: 'identical' }
  const b = { id: 'later-answer', type: 'agentMessage', text: 'identical' }
  await notify('item/completed', { turnId, item: b })
  await notify('item/started', { turnId, item: { ...a, text: '' } })
  await notify('item/completed', { turnId, item: a })
  const first = (await native()).turns[0].items[0]
  await notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [first, a, b] } })
  const before = await current()
  expect(before.messages.map(m => m.id)).toEqual([first.clientId, a.id, b.id])
  await notify('item/started', { turnId, item: { ...a, text: '' } })
  await notify('item/agentMessage/delta', { turnId, itemId: a.id, delta: 'late' })
  await notify('item/completed', { turnId, item: { ...a, text: 'stale partial' } })
  expect((await current()).messages).toEqual(before.messages)
})

it('recovers legacy steer origins and original assistant IDs from corroborated authored rollout order without retaining transcript text', async () => {
  const { f, threadId, current, send, notify, native } = await fixture()
  await send('send', 'private synthetic same').sent
  const turnId = (await current()).lastTurn!.id
  await notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'original-live-commentary', text: 'private synthetic answer' } }, true)
  await send('steer', 'private synthetic same').sent
  await send('steer', 'private synthetic same').sent
  await f.driver.completeTurn(threadId, 'private synthetic answer')
  await expect.poll(async () => (await current()).status).toBe('idle')
  const before = await current(); const source = await native()
  f.host.disconnect(); await f.adapter.closed()
  const aliasPath = join(f.root, 'codex-threads.json')
  const aliases = JSON.parse(await readFile(aliasPath, 'utf8'))
  for (const alias of Object.values(aliases) as Array<{ origins: Array<{ clientIdentity?: boolean }>; messageIdentities?: unknown }>) {
    delete alias.messageIdentities
    for (const origin of alias.origins) delete origin.clientIdentity
  }
  await writeFile(aliasPath, JSON.stringify(aliases))
  const lines: unknown[] = [{ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }]
  for (const [index, item] of source.turns[0].items.entries()) {
    if (item.type === 'userMessage') {
      if (index !== 0) delete item.clientId
      lines.push({ type: 'response_item', payload: { type: 'message', id: `injected-${index}`, role: 'user', content: [{ type: 'input_text', text: 'private synthetic injected skill' }] } })
      lines.push({ type: 'event_msg', payload: { type: 'user_message', message: item.content[0].text, client_id: item.clientId } })
    } else if (item.type === 'agentMessage') {
      lines.push({ type: 'event_msg', payload: { type: 'agent_message', message: item.text } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', id: item.id, content: [{ type: 'output_text', text: item.text }] } })
    }
  }
  const stored = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')); stored.threads[source.id] = source
  await writeFile(join(f.root, 'state.json'), JSON.stringify(stored))
  const sessions = join(f.root, 'home', 'sessions'); await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, `rollout-${source.id}.jsonl`), lines.map((line, ordinal) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal, ...line as object })).join('\n') + '\n')
  await f.script({ historyItemIds: true })
  await f.host.connect()
  // Historical timestamps may be unavailable in old aliases, but IDs/order/text/authority are exact.
  const identity = (messages: typeof before.messages) => messages.map(m => ({ id: m.id, role: m.role, text: m.text, commandId: m.commandId }))
  expect(identity((await current()).messages)).toEqual(identity(before.messages))
  const metadata = await readFile(aliasPath, 'utf8')
  expect(metadata).not.toContain('private synthetic')
  const after = await current()
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
  expect((await current()).messages).toEqual(after.messages)
})

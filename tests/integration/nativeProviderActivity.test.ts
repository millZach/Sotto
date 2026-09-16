// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentActivity } from '../../src/shared/agentActivity'

// Sotto records the turns Claude and Grok do not report. Those records are live observation: a replay
// restores the work rows, not Sotto's watching, so the lifecycle and the order number it occupies are left out.
const tools = (thread: { activities?: readonly AgentActivity[] | undefined } | undefined) =>
  (thread?.activities ?? []).filter(record => record.kind !== 'turn').map(record => ({ ...record, sequence: 0 }))

it('Claude live tool-only message anchors survive log reload with no duplicate execution', async () => {
  let f = await claudeFixture(undefined, 1000); const id = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Use a tool' })
    await f.action(id, { type: 'raw', frame: { type: 'stream_event', event: { type: 'message_start', message: { id: 'tool-message' } } } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.messages.some(m => m.id === 'tool-message')).toBe(true)
    await f.action(id, { type: 'raw', persist: true, frame: { type: 'assistant', uuid: 'tool-frame', timestamp: '2026-09-13T10:00:00.000Z', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'echo ok' } }] } } })
    await expect.poll(async () => tools((await f.host.snapshot()).threads[0]).length).toBe(1)
    await f.action(id, { type: 'raw', persist: true, frame: { type: 'user', uuid: 'result', timestamp: '2026-09-13T10:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] } } })
    await expect.poll(async () => tools((await f.host.snapshot()).threads[0])[0]?.status).toBe('completed')
    const before = tools((await f.host.snapshot()).threads[0])
    f.host.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root, 1000); await f.host.connect()
    expect(tools((await f.host.snapshot()).threads[0])).toEqual(before)
    expect((await f.driver.requests()).filter(r => r.method === 'user')).toHaveLength(1)
  } finally { await f.cleanup() }
})
it('Grok restores tool snapshots, failures and exact output once across replay/reconnect', async () => {
  let f = await grokFixture(); const id = randomUUID()
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Use a tool' })
    await f.action(id, { type: 'chunk', text: 'Checking ', meta: { promptId: 'prompt', streamStartMs: 10 } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.messages.some(message => message.text === 'Checking ')).toBe(true)
    await f.action(id, { type: 'chunk', text: 'now.', meta: { promptId: 'prompt', streamStartMs: 10 } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.messages.some(message => message.text === 'Checking now.')).toBe(true)
    await f.action(id, { type: 'coalesce', streamStartMs: 10 })
    await expect.poll(async () => {
      const sessions = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8'))
      return sessions[await f.realId(id)].updates.filter((entry: { params: { update: { sessionUpdate: string } } }) => entry.params.update.sessionUpdate === 'agent_message_chunk').length
    }).toBe(1)
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo bad' } } })
    await expect.poll(async () => tools((await f.host.snapshot()).threads[0]).length).toBe(1)
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'failure' } }] } })
    await expect.poll(async () => tools((await f.host.snapshot()).threads[0])[0]?.status).toBe('failed')
    const before = tools((await f.host.snapshot()).threads[0])
    await f.action(id, { type: 'replay' }); await f.host.snapshot()
    f = await f.driver.restart(); await f.host.connect()
    expect(tools((await f.host.snapshot()).threads[0])).toEqual(before)
    expect((await f.driver.requests()).filter(r => r.method === 'session/prompt')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it.each(['Done.', 'Done. Another result.'])('Grok retains a distinct live stream containing %s while history lags', async repeated => {
  let f = await grokFixture(); const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Use a tool' })
    await f.action(id, { type: 'chunk', text: 'Done.', meta: { promptId: 'prompt', streamStartMs: 10 } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.messages.filter(message => message.role === 'assistant').length).toBe(1)
    const firstId = (await f.host.snapshot()).threads[0]!.messages.find(message => message.role === 'assistant')!.id
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Run', kind: 'execute', status: 'completed' } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.activities?.length).toBe(1)
    await f.script({ historyVisibleCount: 3 }) // user, first assistant, tool; second assistant has not reached durable history
    const liveIds = new Set<string>()
    const unsubscribe = f.host.subscribe(state => {
      for (const message of state.threads[0]?.messages ?? []) if (message.role === 'assistant') liveIds.add(message.id)
    })
    await f.action(id, { type: 'chunk', text: repeated, meta: { promptId: 'prompt', streamStartMs: 20 } })
    await expect.poll(() => liveIds.size).toBe(2)
    unsubscribe()
    const read = async () => (await f.host.snapshot()).threads[0]!.messages.filter(message => message.role === 'assistant').map(({ id, text }) => ({ id, text }))
    const expected = [{ id: firstId, text: 'Done.' }, { id: [...liveIds].find(value => value !== firstId)!, text: repeated }]
    expect(await read()).toEqual(expected)
    await f.script({ historyVisibleCount: 4 }) // the second stream's prefix is now durable, its next chunk is not
    await f.action(id, { type: 'chunk', text: ' Later.', meta: { promptId: 'prompt', streamStartMs: 20 } })
    expected[1]!.text += ' Later.'
    await expect.poll(read).toEqual(expected)
    await f.script({})
    await f.action(id, { type: 'replay' })
    expect(await read()).toEqual(expected)
    f = await f.driver.restart(); await f.host.connect()
    expect(await read()).toEqual(expected)
    expect((await f.driver.requests()).filter(request => request.method === 'session/prompt')).toHaveLength(1)
  } finally { await f.cleanup() }
})

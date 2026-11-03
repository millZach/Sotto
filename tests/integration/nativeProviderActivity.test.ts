// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { GrokRpc } from '../../src/main/agents/grokRpc'

// Sotto records the turns Claude and Grok do not report. Those records are live observation: a replay
// restores the work rows, not Sotto's watching, so the lifecycle, the order number it occupies and a start
// Sotto timed itself are left out. A start the provider reported survives, because the transcript carries it.
const tools = (thread: { activities?: readonly AgentActivity[] | undefined } | undefined) =>
  (thread?.activities ?? []).filter(record => record.kind !== 'turn')
    .map(({ startedAt, timingSource, ...record }) => ({ ...record, sequence: 0,
      ...(timingSource === 'observed' ? {} : { startedAt, timingSource }) }))

it('Claude live tool-only message anchors survive log reload with no duplicate execution', async () => {
  let f = await claudeFixture(); const id = randomUUID()
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
    f.host.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root); await f.host.connect()
    expect(tools((await f.host.snapshot()).threads[0])).toEqual(before)
    expect((await f.driver.requests()).filter(r => r.method === 'user')).toHaveLength(1)
  } finally { await f.cleanup() }
})
it.each(['before read', 'between reads', 'during restarted read'])('Grok restores tool snapshots, failures and exact output once across replay/reconnect (coalesce %s)', async order => {
  // Only awaited reads fetch history, so each side of the coalesce/read race is reproducible.
  let f = await grokFixture(undefined, undefined, 600_000); const id = randomUUID()
  let live = tools(undefined); let liveText: string | undefined
  const unsubscribe = f.host.subscribe(snapshot => { live = tools(snapshot.threads[0]); liveText = snapshot.threads[0]?.messages.at(-1)?.text })
  const coalesce = async (streamStartMs: number) => {
    await f.action(id, { type: 'coalesce', streamStartMs })
    await expect.poll(async () => {
      const sessions = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8'))
      return sessions[await f.realId(id)].updates.filter((entry: { params: { _meta: { streamStartMs?: number }; update: { sessionUpdate: string } } }) => entry.params.update.sessionUpdate === 'agent_message_chunk' && entry.params._meta.streamStartMs === streamStartMs).length
    }).toBe(1)
  }
  try {
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Use a tool' })
    await f.action(id, { type: 'chunk', text: 'Checking ', meta: { promptId: 'prompt', streamStartMs: 10 } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.messages.some(message => message.text === 'Checking ')).toBe(true)
    await f.action(id, { type: 'chunk', text: 'now.', meta: { promptId: 'prompt', streamStartMs: 10 } })
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.messages.some(message => message.text === 'Checking now.')).toBe(true)
    // The live chunk may have arrived after that snapshot's read. Read it durably before coalescing.
    await f.host.snapshot()
    await coalesce(10)
    if (order === 'before read') await f.host.snapshot()
    if (order === 'during restarted read') {
      await f.action(id, { type: 'chunk', text: 'Still ', meta: { promptId: 'prompt', streamStartMs: 20 } })
      await expect.poll(() => liveText).toBe('Still ')
      await f.action(id, { type: 'chunk', text: 'checking.', meta: { promptId: 'prompt', streamStartMs: 20 } })
      await expect.poll(() => liveText).toBe('Still checking.')
    }
    // Let both tool notifications arrive before reading history. In the racing order the tool start
    // fills the position removed by the coalesce, so totalCount never falls below the prior read's.
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo bad' } } })
    await expect.poll(() => live.length).toBe(1)
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'failure' } }] } })
    await expect.poll(() => live[0]?.status).toBe('failed')
    let pages = 0
    if (order === 'during restarted read') {
      const native = f.adapter as unknown as { processes: Map<string, { rpc: GrokRpc }> }
      const rpc = native.processes.get(id)!.rpc; const request = rpc.request.bind(rpc)
      vi.spyOn(rpc, 'request').mockImplementation((method, params, accept) => {
        if (method !== '_x.ai/session/updates') return request(method, params, accept)
        // Short pages put the second stream at the restarted page's boundary. Coalesce it only
        // after that page was applied, moving the tool start into the following overlap slot.
        return request(method, { ...params as Record<string, unknown>, limit: 4 }, async value => {
          await accept?.(value)
          if (++pages === 2) await coalesce(20)
        })
      })
    }
    const before = tools((await f.host.refreshThread(id)).threads[0])
    await f.action(id, { type: 'replay' }); await f.host.snapshot()
    f = await f.driver.restart(); f.host.observeThreads?.([id]); await f.host.connect()
    expect(tools((await f.host.snapshot()).threads[0])).toEqual(before)
    expect(before).toEqual([expect.objectContaining({ kind: 'command', title: 'Run', command: 'echo bad', status: 'failed', output: 'failure' })])
    if (order === 'during restarted read') expect(pages).toBeGreaterThan(3)
    expect((await f.driver.requests()).filter(r => r.method === 'session/prompt')).toHaveLength(1)
  } finally { vi.restoreAllMocks(); unsubscribe(); await f.cleanup() }
})

it('Grok bounds repeated coalesces even when the sliding overlap entry is byte-identical', async () => {
  const f = await grokFixture(undefined, undefined, 600_000); const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    const sessionId = await f.realId(id)
    const entry = (update: Record<string, unknown>, timestamp: number) => ({ timestamp, method: 'session/update', params: { sessionId, update, _meta: { promptId: 'prompt', streamStartMs: 10 } } })
    const chunk = (text: string, timestamp: number) => entry({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, timestamp)
    const user = entry({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Use a tool' } }, 1_700_000_000)
    const marker = entry({ sessionUpdate: 'available_commands_update', availableCommands: [] }, 1_700_000_001)
    const start = entry({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo bad' } }, 1_700_000_002)
    const failure = entry({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'failure' } }] }, 1_700_000_003)
    let updates = [user, chunk('Checking ', 1_700_000_004), chunk('now.', 1_700_000_005), marker]
    let rewriting = false; const offsets: number[] = []
    const native = f.adapter as unknown as { processes: Map<string, { rpc: GrokRpc }> }
    const rpc = native.processes.get(id)!.rpc; const request = rpc.request.bind(rpc)
    vi.spyOn(rpc, 'request').mockImplementation(async (method, params, accept) => {
      if (method !== '_x.ai/session/updates') return request(method, params, accept)
      const { offset } = params as { offset: number }; offsets.push(offset)
      // A missing restart bound fails on a request count, without waiting for a test deadline.
      if (offsets.length > 10) throw new Error('History kept restarting without yielding.')
      if (rewriting && offset === 0) updates = [user, chunk('Checking ', 1_700_000_004), chunk('again.', 1_700_000_005), marker, marker, start, failure]
      const page = updates.slice(offset, offset + 4)
      await accept?.({ updates: page, totalCount: updates.length, hasMore: offset + page.length < updates.length })
      if (rewriting && offset === 0) {
        // Coalescing removes an entry before two identical markers (timestamp included). One
        // overlap would still match after the shift. Keep doing this at every restarted page.
        updates = [user, chunk('Checking again.', 1_700_000_005), marker, marker, start, failure]
      }
    })
    await f.host.refreshThread(id)
    offsets.length = 0; rewriting = true
    updates = [user, chunk('Checking ', 1_700_000_004), chunk('again.', 1_700_000_005), marker, marker, start, failure]
    await f.host.refreshThread(id)
    expect(offsets.filter(offset => offset === 0)).toHaveLength(2)
    expect(offsets.length).toBeLessThanOrEqual(5)
    // The bound leaves a fresh cursor. Once history settles, the next read restores every row.
    offsets.length = 0; rewriting = false
    const restored = await f.host.refreshThread(id)
    expect(offsets[0]).toBe(0)
    expect(tools(restored.threads[0])).toEqual([expect.objectContaining({ kind: 'command', title: 'Run', command: 'echo bad', status: 'failed', output: 'failure' })])
    expect(restored.threads[0]?.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Checking again.'])
  } finally { vi.restoreAllMocks(); await f.cleanup() }
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
    await expect.poll(async () => tools((await f.host.snapshot()).threads[0]).length).toBe(1)
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
    f = await f.driver.restart(); f.host.observeThreads?.([id]); await f.host.connect()
    expect(await read()).toEqual(expected)
    expect((await f.driver.requests()).filter(request => request.method === 'session/prompt')).toHaveLength(1)
  } finally { await f.cleanup() }
})

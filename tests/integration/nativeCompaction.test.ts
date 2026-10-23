// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProtocol, ClaudeWritePending, type ClaudeFrame } from '../../src/main/agents/claudeProtocol'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('Grok does not claim to accept unsupported manual compaction', async () => {
  const f = await grokFixture(); cleanup.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 't', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  await expect(f.host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'thread' })).rejects.toThrow(/compaction/i)
  expect((await f.host.snapshot()).capabilities.compact).not.toBe(true)
})
it('Codex acknowledges native compaction without claiming completion, prevents duplicate work, and reports the actual boundary', async () => {
  const f = await codexFixture(); cleanup.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  expect(await f.host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'thread' })).toEqual({ accepted: true })
  expect((await f.host.snapshot()).threads[0]?.compaction?.status).toBe('running')
  await expect(f.host.execute({ type: 'compact-thread', commandId: 'duplicate', threadId: 'thread' })).rejects.toThrow(/compaction|working/i)
  await f.action('thread', { type: 'notify', method: 'item/completed', params: { threadId: await f.realId('thread'), turnId: 'compact-turn', item: { id: 'boundary', type: 'contextCompaction' } } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.compaction?.status).toBe('completed')
  expect((await f.driver.requests()).filter(row => row.method === 'thread/compact/start')).toHaveLength(1)
})
it.each([['Compact and continue', 'compact'], ['Keep full history', 'continue'], ["Don't ask again", 'never']])('Claude returns the native resume choice %s without submitting a prompt', async (label, result) => {
  const f = await claudeFixture(); cleanup.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  const requestId = randomUUID()
  await f.action('thread', { type: 'dialog', requestId, payload: { sessionAgeMinutes: 71, estimatedTokens: 120000 } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.requests.length).toBe(1)
  expect((await f.host.snapshot()).threads[0]?.requests[0]?.options.map(o => o.label)).toEqual(['Compact and continue', 'Keep full history', "Don't ask again"])
  await f.host.execute({ type: 'answer', commandId: 'answer', threadId: 'thread', requestId, answer: '', questionAnswers: { '0': { optionIds: [label!] } } })
  // A successful pipe write does not mean the child has consumed and recorded
  // the reply yet. Observe this exact native request instead of racing its log.
  await expect.poll(async () => (await f.driver.requests()).filter(row => row.method === 'control_response').map(row => row.params?.frame))
    .toContainEqual({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'completed', result } } })
  expect((await f.driver.requests()).filter(row => row.method === 'user')).toHaveLength(0)
  if (result === 'never') {
    expect((await f.host.snapshot()).threads[0]?.resumeCompactionDismissed).toBe(true)
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
    expect((await f.host.snapshot()).threads[0]?.resumeCompactionDismissed).toBe(true)
  }
})
it('Claude uses an advertised native slash command, requires a boundary, excludes native metadata and reports native failure', async () => {
  const f = await claudeFixture(); cleanup.push(f.cleanup)
  await writeFile(join(f.root, 'skills.json'), JSON.stringify([{ name: 'compact', description: 'Native compaction' }]))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  expect((await f.host.snapshot()).threads[0]?.manualCompactionSupported).toBe(true)
  expect(await f.host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'thread' })).toEqual({ accepted: true })
  await expect(f.host.execute({ type: 'compact-thread', commandId: 'duplicate', threadId: 'thread' })).rejects.toThrow(/compaction/i)
  await expect.poll(async () => (await f.driver.requests()).filter(row => row.method === 'user').at(-1)?.params?.frame).toMatchObject({ message: { content: '/compact' } })
  await f.action('thread', { type: 'raw', frame: { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 120000, post_tokens: 30000 } } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.compaction?.status).toBe('completed')
  expect((await f.host.snapshot()).threads[0]?.usage?.contextUsed).toBe(30000)
  // The transcript says a compaction happened and what it reclaimed, in the sizes the boundary itself reported.
  expect((await f.host.snapshot()).threads[0]?.activities?.filter(record => record.kind === 'compaction'))
    .toEqual([expect.objectContaining({ title: 'Context compacted', status: 'completed', context: { before: 120000, after: 30000 } })])
  // The CLI has not answered the /compact yet, so the thread is still at work until its result.
  expect((await f.host.snapshot()).threads[0]?.status).toBe('running')
  const summary = { type: 'user', uuid: randomUUID(), isSynthetic: true, message: { role: 'user', content: 'Generated native compaction summary.' } }
  await f.action('thread', { type: 'raw', frame: summary, persist: true })
  await f.driver.typeInProvider('thread', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>')
  await f.adapter.pollSessionLogs()
  expect((await f.host.snapshot()).threads[0]?.messages.filter(message => message.role === 'user')).toEqual([])
  expect((await f.host.snapshot()).threads[0]?.status).toBe('running')
  // Claude Code 2.1.303's result for a /compact names the prompt and ends the work as a finished turn.
  const compact = (await f.driver.requests()).filter(row => row.method === 'user').at(-1)!.params!.frame as { uuid: string }
  await f.action('thread', { type: 'raw', frame: { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', user_message_uuid: compact.uuid, user_message_uuids: [compact.uuid] } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  expect((await f.host.snapshot()).threads[0]?.lastTurn).toEqual({ id: compact.uuid, status: 'completed' })
  await f.host.execute({ type: 'compact-thread', commandId: 'fail', threadId: 'thread' })
  // As with the first compaction, the native answer comes after the child has the command: a real Claude
  // cannot report on a /compact it has not received, and scripting it sooner races the adapter's write.
  await expect.poll(async () => (await f.driver.requests()).filter(row => row.method === 'user' && (row.params?.frame as { message?: { content?: unknown } } | undefined)?.message?.content === '/compact').length).toBe(2)
  await f.action('thread', { type: 'raw', frame: { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.compaction).toMatchObject({ status: 'failed', error: 'Not enough messages to compact.' })
  // A failed compaction settles the thread at once, without waiting on a result Claude Code might not send.
  expect((await f.host.snapshot()).threads[0]?.status).toBe('error')
})
it('keeps a Claude thread at work until the result when an unconfirmed /compact reaches Claude Code late', async () => {
  const f = await claudeFixture(); cleanup.push(f.cleanup)
  await writeFile(join(f.root, 'skills.json'), JSON.stringify([{ name: 'compact' }]))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 't', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  // The bytes reach the CLI, but the write's deadline passes first, as a stalled pipe leaves it.
  const write = ClaudeProtocol.prototype.write
  const late = vi.spyOn(ClaudeProtocol.prototype, 'write').mockImplementation(function (this: ClaudeProtocol, frame: ClaudeFrame) {
    const sent = write.call(this, frame)
    return (frame.message as { content?: unknown } | undefined)?.content === '/compact' ? Promise.reject(new ClaudeWritePending(sent)) : sent
  })
  try { expect(await f.host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'thread' })).toEqual({ accepted: false, uncertain: true }) }
  finally { late.mockRestore() }
  expect((await f.host.snapshot()).threads[0]?.compaction?.status).toBe('uncertain')
  await expect.poll(async () => (await f.driver.requests()).filter(row => row.method === 'user').at(-1)?.params?.frame).toMatchObject({ message: { content: '/compact' } })
  const compact = (await f.driver.requests()).filter(row => row.method === 'user').at(-1)!.params!.frame as { uuid: string }
  await f.action('thread', { type: 'raw', frame: { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 120000, post_tokens: 30000 } } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.compaction?.status).toBe('completed')
  expect((await f.host.snapshot()).threads[0]?.status).toBe('running')
  await f.action('thread', { type: 'raw', frame: { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', user_message_uuid: compact.uuid, user_message_uuids: [compact.uuid] } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  expect((await f.host.snapshot()).threads[0]?.lastTurn).toEqual({ id: compact.uuid, status: 'completed' })
})
it('preserves explicit native Claude compaction environment overrides instead of supplying Sotto defaults', async () => {
  const overrides = { DISABLE_AUTO_COMPACT: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' }
  const f = await claudeFixture(undefined, 2000, { ...process.env, ...overrides }); cleanup.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  expect((await f.driver.requests()).filter(row => row.method === 'launch').at(-1)?.params?.frame).toMatchObject({ compactionEnvironment: overrides })
  await expect(f.host.execute({ type: 'compact-thread', commandId: 'unsupported', threadId: 'thread' })).rejects.toThrow(/does not expose/i)
})
it('reconciles Claude compaction from a missed persisted native boundary after restart without replaying it', async () => {
  const f = await claudeFixture(); cleanup.push(f.cleanup)
  await writeFile(join(f.root, 'skills.json'), JSON.stringify([{ name: 'compact' }]))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 't', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  await f.host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'thread' })
  f.host.disconnect(); await f.adapter.closed()
  const session = await f.realId('thread')
  const nativeLog = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'), `${session}.jsonl`)
  expect(await readFile(nativeLog, 'utf8')).toContain('/compact')
  await appendFile(nativeLog, JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), compactMetadata: { trigger: 'manual', preTokens: 120000 } }) + '\n')
  await f.host.connect()
  expect((await f.host.snapshot()).threads[0]?.compaction?.status).toBe('completed')
  expect((await f.driver.requests()).filter(row => row.method === 'user')).toHaveLength(1)
  expect((await f.host.snapshot()).threads[0]?.messages.filter(message => message.role === 'user')).toEqual([])
})

it('Codex brackets a compaction it reports without numbers using the context sizes either side of it', async () => {
  const f = await codexFixture(); cleanup.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  const threadId = await f.realId('thread')
  const reported = async (totalTokens: number, turnId: string): Promise<void> => {
    await f.action('thread', { type: 'notify', method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage: { total: { inputTokens: totalTokens, outputTokens: 1 }, last: { inputTokens: totalTokens, outputTokens: 1, totalTokens }, modelContextWindow: 258400 } } })
  }
  await reported(90000, 'turn-1')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.usage?.contextUsed).toBe(90000)
  await f.action('thread', { type: 'notify', method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { id: 'boundary', type: 'contextCompaction' } } })
  const compaction = async () => (await f.host.snapshot()).threads[0]?.activities?.find(record => record.kind === 'compaction')
  await expect.poll(async () => (await compaction())?.context).toEqual({ before: 90000 })
  await reported(12000, 'turn-2')
  await expect.poll(async () => (await compaction())?.context).toEqual({ before: 90000, after: 12000 })
  // Later growth is the next turn filling the context again, not this compaction reclaiming less.
  await reported(41000, 'turn-3')
  expect((await compaction())?.context).toEqual({ before: 90000, after: 12000 })
})

it('Codex clears the context figure its compaction leaves out of date, unless a reading came in while it ran', async () => {
  const f = await codexFixture(); cleanup.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  const threadId = await f.realId('thread')
  const usage = async () => (await f.host.snapshot()).threads[0]?.usage
  const reported = async (totalTokens: number, turnId: string): Promise<void> => {
    await f.action('thread', { type: 'notify', method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage: { total: { inputTokens: totalTokens, outputTokens: 1 }, last: { inputTokens: totalTokens, outputTokens: 1, totalTokens }, modelContextWindow: 258400 } } })
  }
  const boundary = async (method: 'item/started' | 'item/completed', id: string): Promise<void> => {
    await f.action('thread', { type: 'notify', method, params: { threadId, turnId: `${id}-turn`, item: { id, type: 'contextCompaction' } } })
  }
  await reported(120000, 'turn-1')
  await expect.poll(async () => (await usage())?.contextUsed).toBe(120000)
  const before = (await usage())?.contextUpdatedAt
  // Codex reports no size after a compaction, so the figure from before it is cleared, with a new time, wherever it started.
  await boundary('item/started', 'first'); await boundary('item/completed', 'first')
  await expect.poll(async () => (await usage())?.contextUsed).toBeUndefined()
  expect((await usage())?.contextUpdatedAt).not.toBe(before)
  await reported(130000, 'turn-2')
  await expect.poll(async () => (await usage())?.contextUsed).toBe(130000)
  // A reading that came in while the compaction ran is the size after it, and is kept.
  const compactions = async () => (await f.host.snapshot()).threads[0]?.activities?.filter(record => record.kind === 'compaction').length
  await boundary('item/started', 'second')
  await expect.poll(compactions).toBe(2)
  await reported(20000, 'turn-3')
  await expect.poll(async () => (await usage())?.contextUsed).toBe(20000)
  await boundary('item/completed', 'second')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.activities?.filter(record => record.kind === 'compaction' && record.status === 'completed').length).toBe(2)
  expect((await usage())?.contextUsed).toBe(20000)
})

it('Claude carries Sotto’s idle mark from the request to the compaction’s result (ADR-0123)', async () => {
  const f = await claudeFixture(); cleanup.push(f.cleanup)
  await writeFile(join(f.root, 'skills.json'), JSON.stringify([{ name: 'compact', description: 'Native compaction' }]))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', modelId: 'fixture-model', title: 'Work' })
  expect(await f.host.execute({ type: 'compact-thread', commandId: 'idle', threadId: 'thread', idle: true })).toEqual({ accepted: true })
  expect((await f.host.snapshot()).threads[0]?.compaction).toEqual({ commandId: 'idle', status: 'running', idle: true })
  await expect.poll(async () => (await f.driver.requests()).filter(row => row.method === 'user').at(-1)?.params?.frame).toMatchObject({ message: { content: '/compact' } })
  await f.action('thread', { type: 'raw', frame: { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 262000, post_tokens: 41000 } } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.compaction).toEqual({ commandId: 'idle', status: 'completed', idle: true })
})

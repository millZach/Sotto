// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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
  expect((await f.host.snapshot()).threads[0]?.status).toBe('idle')
  const summary = { type: 'user', uuid: randomUUID(), isSynthetic: true, message: { role: 'user', content: 'Generated native compaction summary.' } }
  await f.action('thread', { type: 'raw', frame: summary, persist: true })
  await f.driver.typeInProvider('thread', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>')
  await f.adapter.pollSessionLogs()
  expect((await f.host.snapshot()).threads[0]?.messages.filter(message => message.role === 'user')).toEqual([])
  await f.action('thread', { type: 'complete', text: '' })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  await f.host.execute({ type: 'compact-thread', commandId: 'fail', threadId: 'thread' })
  await f.action('thread', { type: 'raw', frame: { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' } })
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.compaction).toMatchObject({ status: 'failed', error: 'Not enough messages to compact.' })
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

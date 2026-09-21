// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SubagentStore } from '../../../src/main/agents/subagentStore'
import type { AgentActivity, ObservedAgent } from '../../../src/shared/agentActivity'
import { subagentAssignmentsPageSchema, subagentChangeSchema, subagentPageSchema } from '../../../src/shared/subagents'

const opened: SubagentStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-subagents-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-subagents-')); roots.push(root)
  const path = join(root, 'subagents.sqlite')
  const store = new SubagentStore(path); opened.push(store); store.open()
  return { store, root, path }
}
const at = (offset: number): string => new Date(Date.UTC(2026, 8, 20, 12, 0, offset)).toISOString()
const observation = (patch: Partial<ObservedAgent> = {}): ObservedAgent => ({ id: 'agent', assignmentId: 'first', title: 'Inspect the parser', prompt: 'Inspect the parser\nand report findings.', status: 'running', observedAt: at(0), startedAt: at(0), ...patch })
async function diskText(root: string): Promise<string> { return (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'latin1')))).join(' ') }

describe('retained subagent roster', () => {
  it.each([
    ['starting', 'running'], ['waiting', 'running'], ['pendingInit', 'running'],
    ['shutdown', 'interrupted'], ['closed', 'interrupted'], ['notFound', 'failed'],
  ] as const)('maps provider state %s to %s', async (status, expected) => {
    const { store } = await fixture()
    expect(store.ingest('thread', [observation({ status })])?.rows[0]?.status).toBe(expected)
  })
  it('retains nested agents in spawn order, normalizes status and keeps full task/results out of roster publications', async () => {
    const { store } = await fixture()
    const first = store.ingest('thread', [observation({ id: 'parent', model: 'reported-model' }), observation({ parentId: 'parent', description: 'A'.repeat(500) })])!
    expect(subagentChangeSchema.safeParse(first).success).toBe(true)
    expect(first.rows.map(row => row.id)).toEqual(['parent', 'agent'])
    expect(first.rows[1]).toMatchObject({ parentId: 'parent', description: 'A'.repeat(400) })
    expect(first.summary).toMatchObject({ total: 2, working: 2 })
    expect(first.rows.every(row => !('prompt' in row) && !('result' in row) && row.description.length <= 400)).toBe(true)
    const finished = store.ingest('thread', [observation({ status: 'completed', observedAt: at(4), completedAt: at(4), message: 'Exact result\nwith newlines.' })])!
    expect(finished.rows).toHaveLength(1)
    expect(finished.summary).toMatchObject({ total: 2, working: 1, completed: 1 })
    expect(store.page({ threadId: 'thread' }).rows.map(row => row.sequence)).toEqual([1, 2])
    const detail = store.assignments({ threadId: 'thread', agentId: 'agent' })
    expect(subagentAssignmentsPageSchema.safeParse(detail).success).toBe(true)
    expect(detail.assignments[0]).toMatchObject({ prompt: observation().prompt, result: 'Exact result\nwith newlines.' })
    expect(store.ingest('thread', [observation({ status: 'running', observedAt: at(5) })])).toBeUndefined()
  })
  it('preserves a complete prompt when later compact lifecycle observations only repeat the description', async () => {
    const { store } = await fixture()
    store.ingest('thread', [observation({ prompt: 'Full original task with detailed instructions', description: 'Brief task' })])
    store.ingest('thread', [observation({ prompt: undefined, description: 'Brief task', status: 'completed', message: 'Result', observedAt: at(1) })])
    expect(store.assignments({ threadId: 'thread', agentId: 'agent' }).assignments[0]?.prompt).toBe('Full original task with detailed instructions')
  })
  it('reuses a row while retaining old assignments, late results and independently reported models', async () => {
    const { store } = await fixture()
    store.ingest('thread', [observation({ status: 'completed', model: 'first-model', message: 'first result' })])
    store.ingest('thread', [observation({ assignmentId: 'second', title: 'Review changes', observedAt: at(2) })])
    expect(store.page({ threadId: 'thread' }).rows[0]).toMatchObject({ sequence: 1, assignmentCount: 2, assignmentId: 'second', title: 'Review changes', status: 'running' })
    expect(store.page({ threadId: 'thread' }).rows[0]!.model).toBeUndefined()
    store.ingest('thread', [observation({ status: 'completed', observedAt: at(3), message: 'amended first result' })])
    expect(store.page({ threadId: 'thread' }).rows[0]!.assignmentId).toBe('second')
    expect(store.assignments({ threadId: 'thread', agentId: 'agent' }).assignments.map(item => [item.id, item.result])).toEqual([['second', undefined], ['first', 'amended first result']])
    store.ingest('thread', [observation({ assignmentId: undefined, status: 'failed', observedAt: at(4), message: 'second failed' })])
    expect(store.summary('thread')).toMatchObject({ total: 1, failed: 1, working: 0 })
  })
  it('restores history as last seen working and requires fresh evidence before reviving a cached observation', async () => {
    const { store } = await fixture()
    const initial = observation()
    store.ingest('thread', [initial])
    store.close(); store.open()
    expect(store.page({ threadId: 'thread' }).rows[0]).toMatchObject({ status: 'unknown', lastObservedAt: at(0) })
    expect(store.summary('thread')).toMatchObject({ unknown: 1, working: 0 })
    expect(store.ingest('thread', [initial])).toBeUndefined()
    expect(store.ingest('thread', [observation({ title: 'Older cached description', observedAt: undefined })])).toBeUndefined()
    expect(store.ingest('thread', [observation({ observedAt: at(1) })])?.summary.working).toBe(1)
    expect(store.markUnknown('thread')?.rows[0]!.status).toBe('unknown')
    expect(store.markUnknown('thread')).toBeUndefined()
    expect(store.ingest('thread', [observation({ observedAt: at(2), status: 'completed', message: 'Recovered result' })])?.summary.completed).toBe(1)
    store.close(); store.open()
    expect(store.assignments({ threadId: 'thread', agentId: 'agent' }).assignments[0]!.result).toBe('Recovered result')
  })
  it('uses indexed cursors to page roster and assignment history without duplicates', async () => {
    const { store } = await fixture()
    store.ingest('thread', Array.from({ length: 123 }, (_, i) => observation({ id: `agent-${i}`, status: 'completed' })))
    const rows = []
    let before: number | undefined
    do {
      const page = store.page({ threadId: 'thread', before })
      expect(subagentPageSchema.safeParse(page).success).toBe(true)
      expect(page.rows.length).toBeLessThanOrEqual(50)
      rows.unshift(...page.rows); before = page.before
    } while (before)
    expect(rows.map(row => row.id)).toEqual(Array.from({ length: 123 }, (_, i) => `agent-${i}`))
    for (let i = 0; i < 25; i++) store.ingest('thread', [observation({ assignmentId: `job-${i}`, status: 'completed', observedAt: at(i), message: `result-${i}` })])
    const results: string[] = []
    do {
      const page = store.assignments({ threadId: 'thread', agentId: 'agent', before })
      expect(page.assignments.length).toBeLessThanOrEqual(10)
      results.push(...page.assignments.map(item => item.result!)); before = page.before
    } while (before)
    expect(results).toEqual(Array.from({ length: 25 }, (_, i) => `result-${24 - i}`))
  })
  it('rewinds just the selected thread with a monotonic reset revision', async () => {
    const { store } = await fixture()
    store.ingest('one', [observation()], 'epoch-one')
    store.ingest('two', [observation()], 'epoch-one')
    const before = store.state('one').revision
    const reset = store.ingest('one', [], 'epoch-two')!
    expect(reset).toMatchObject({ reset: true, rows: [], revision: before + 1, summary: { total: 0 } })
    expect(store.assignments({ threadId: 'one', agentId: 'agent' }).assignments).toEqual([])
    expect(store.summary('two').total).toBe(1)
  })
  it('securely removes retained words including WAL and does not retain ephemeral assignments', async () => {
    const { store, root } = await fixture()
    const secret = 'Private-subagent-content-unique-marker'
    store.ingest('thread', [observation({ prompt: secret, message: secret, title: secret, description: secret })])
    expect(await diskText(root)).toContain(secret)
    store.privacyChanged(false)
    expect(store.ephemeral).toBe(true)
    expect(await diskText(root)).not.toContain(secret)
    store.ingest('thread', [observation({ prompt: 'Ephemeral-private-marker' })])
    expect(await diskText(root)).not.toContain('Ephemeral-private-marker')
    store.close(); store.open({ ephemeral: true })
    expect(store.summary('thread').total).toBe(0)
    store.privacyChanged(true)
    store.ingest('thread', [observation({ assignmentId: 'new-after-private-run', status: 'completed', message: 'Newly retained result' })])
    store.close(); store.open()
    expect(store.assignments({ threadId: 'thread', agentId: 'agent' }).assignments[0]!.result).toBe('Newly retained result')
  })
  it('keeps erased assignments content-free through changed lifecycle, restart and repeated privacy toggles', async () => {
    const { store, root } = await fixture()
    const erased = observation({ title: 'Erased-title-marker', description: 'Erased-description-marker', prompt: 'Erased-prompt-marker', message: 'Erased-result-marker' })
    store.ingest('thread', [erased])
    store.privacyChanged(false)
    store.ingest('thread', [observation({ assignmentId: 'private-run', title: 'Private-run-title-marker', prompt: 'Private-run-prompt-marker', message: 'Private-run-result-marker' })])
    store.privacyChanged(true)
    store.ingest('thread', [{ ...erased, status: 'completed', observedAt: at(1) }])
    expect(store.page({ threadId: 'thread' }).rows[0]).toMatchObject({ title: 'Agent task', description: '', status: 'completed' })
    expect(store.assignments({ threadId: 'thread', agentId: 'agent' }).assignments[0]).toMatchObject({ title: 'Agent task', status: 'completed' })
    expect(JSON.stringify(store.assignments({ threadId: 'thread', agentId: 'agent' }))).not.toContain('Erased-')
    store.close(); store.open()
    store.ingest('thread', [{ ...erased, status: 'completed', observedAt: at(2), message: 'Erased-result-marker with a later addition' }])
    store.ingest('thread', [observation({ assignmentId: 'private-run', status: 'completed', observedAt: at(3), title: 'Private-run-title-marker', prompt: 'Private-run-prompt-marker', message: 'Private-run-result-marker' })])
    expect(await diskText(root)).not.toContain('Erased-')
    expect(await diskText(root)).not.toContain('Private-run-')
    store.privacyChanged(false); store.privacyChanged(true)
    // Omitted assignment identities cannot bypass an existing erased agent boundary.
    store.ingest('thread', [{ ...erased, assignmentId: undefined, observedAt: at(4), status: 'completed' }])
    store.ingest('thread', [{ ...erased, assignmentId: undefined, observedAt: at(5), status: 'completed' }])
    expect(await diskText(root)).not.toContain('Erased-')
    store.ingest('thread', [observation({ assignmentId: 'fresh-assignment', title: 'Fresh task', prompt: 'Fresh prompt', message: 'Fresh result', status: 'completed', observedAt: at(6) })])
    expect(store.assignments({ threadId: 'thread', agentId: 'agent' }).assignments[0]).toMatchObject({ title: 'Fresh task', prompt: 'Fresh prompt', result: 'Fresh result' })
    expect(await diskText(root)).toContain('Fresh result')
  })
  it('wipes earlier durable content when starting with local history disabled', async () => {
    const { store, root } = await fixture()
    store.ingest('thread', [observation({ prompt: 'Off-between-runs-marker' })]); store.close()
    store.open({ ephemeral: true })
    expect(store.summary('thread').total).toBe(0)
    expect(await diskText(root)).not.toContain('Off-between-runs-marker')
  })
  it('retains indexed text-free task classification beyond the activity window and respects epoch and privacy resets', async () => {
    const { store, root } = await fixture()
    const original: AgentActivity = {
      id: 'claude-task-old', turnId: 'turn', sequence: 0, kind: 'subagent', status: 'completed', parentId: 'parent',
      title: 'Classification-private-title', text: 'Classification-private-text', command: 'Classification-private-command',
      output: 'Classification-private-output', error: 'Classification-private-error',
      agents: [observation({ title: 'Classification-private-child-title', model: 'Classification-private-model', prompt: 'Classification-private-prompt', message: 'Classification-private-result' })],
    }
    store.ingest('thread', [], 'epoch', [original])
    store.ingest('thread', [], 'epoch', Array.from({ length: 2500 }, (_, index) => ({ ...original, id: `later-${index}`, sequence: index + 1 })))
    store.resetWorkCounters(); store.close(); store.open()
    expect(store.work).toEqual({ indexedReads: 0, rowWrites: 0, assignmentWrites: 0, classificationWrites: 0, pageRowsRead: 0 })
    expect(store.activity('thread', original.id, 'epoch')).toEqual({
      id: original.id, turnId: 'turn', sequence: 0, kind: 'subagent', status: 'completed', title: 'Subagent', parentId: 'parent',
      agents: [{ id: 'agent', assignmentId: 'first', status: 'running' }],
    })
    expect(store.work.indexedReads).toBe(2)
    expect(store.activity('thread', original.id, 'other-epoch')).toBeUndefined()
    expect(store.activity('another-thread', original.id, 'epoch')).toBeUndefined()
    expect(await diskText(root)).not.toContain('Classification-private-')
    store.resetWorkCounters()
    store.ingest('thread', [], 'epoch', [original])
    expect(store.work.classificationWrites).toBe(0)
    store.ingest('thread', [], 'epoch', [{ ...original, kind: 'tool', agents: undefined, taskUpdatesExcluded: true }])
    expect(store.activity('thread', original.id, 'epoch')).toMatchObject({ kind: 'tool', taskUpdatesExcluded: true, status: 'completed' })
    expect(store.work.classificationWrites).toBe(1)
    store.privacyChanged(false)
    expect(store.activity('thread', original.id, 'epoch')).toBeUndefined()
    store.ingest('thread', [], 'epoch', [original])
    expect(store.activity('thread', original.id, 'epoch')).toBeDefined()
    store.privacyChanged(true)
    expect(store.activity('thread', original.id, 'epoch')).toBeUndefined()
    store.ingest('thread', [], 'epoch', [original])
    store.ingest('thread', [], 'rewound', [])
    expect(store.activity('thread', original.id, 'epoch')).toBeUndefined()
    expect(store.activity('thread', original.id, 'rewound')).toBeUndefined()
    expect(await diskText(root)).not.toContain('Classification-private-')
  })
  it('indexes hashed agent aliases across restart and never redirects a reused agent to an earlier task', async () => {
    const { store, root } = await fixture()
    const alias = `claude-agent-alias-${'a'.repeat(64)}`
    const original: AgentActivity = { id: 'first-task', turnId: 'turn', sequence: 1, kind: 'subagent', status: 'completed', title: 'Private-alias-title',
      agents: [observation({ aliasIds: [alias, 'Private-unhashed-alias'], prompt: 'Private-alias-prompt' })] }
    store.ingest('thread', [], 'epoch', [original])
    store.close(); store.open()
    expect(store.activity('thread', alias, 'epoch')).toMatchObject({ id: 'first-task', agents: [{ id: 'agent', assignmentId: 'first', aliasIds: [alias] }] })
    expect(store.activity('thread', 'Private-unhashed-alias', 'epoch')).toBeUndefined()
    const reused = { ...original, id: 'second-task', sequence: 2, agents: [observation({ assignmentId: 'second', aliasIds: [alias] })] }
    store.ingest('thread', [], 'epoch', [reused])
    store.ingest('thread', [], 'epoch', [{ ...original, taskUpdatesExcluded: true }])
    expect(store.activity('thread', alias, 'epoch')).toMatchObject({ id: 'second-task', agents: [{ assignmentId: 'second' }] })
    store.ingest('thread', [], 'epoch', [{ ...reused, taskUpdatesExcluded: true }])
    expect(store.activity('thread', alias, 'epoch')?.taskUpdatesExcluded).toBe(true)
    expect(await diskText(root)).not.toContain('Private-')
  })
  it('keeps 600 progress updates bounded with 5000 saved assignments across three threads', async () => {
    const { store } = await fixture()
    const seed = (count: number) => {
      const byThread: ObservedAgent[][] = [[], [], []]
      for (let i = 0; i < count; i++) byThread[i % 3]!.push(observation({ id: `saved-${i % 100}`, assignmentId: `saved-job-${i}`, status: 'completed', message: `Saved output ${i}`, observedAt: at(i) }))
      byThread.forEach((records, index) => store.ingest(`thread-${index}`, records))
    }
    const active = Array.from({ length: 20 }, (_, i) => observation({ id: `active-${i}`, observedAt: at(6000) }))
    const updates = () => {
      store.resetWorkCounters()
      for (let i = 0; i < 30; i++) {
        const change = store.ingest('thread-0', active.map(agent => ({ ...agent, observedAt: at(6001 + i), durationMs: i * 1000 })))!
        expect(change.rows).toHaveLength(20)
        expect(JSON.stringify(change)).not.toContain('Saved output')
      }
      return store.work
    }
    seed(50); store.ingest('thread-0', active)
    const small = updates()
    seed(5000)
    // New assignment resets only the synthetic active cohort for the same update workload.
    active.forEach(agent => { agent.assignmentId = 'next'; agent.observedAt = at(6000) })
    store.ingest('thread-0', active)
    const untouched = store.page({ threadId: 'thread-1' })
    const large = updates()
    expect(large).toEqual(small)
    expect(large).toEqual({ indexedReads: 1830, rowWrites: 600, assignmentWrites: 600, classificationWrites: 0, pageRowsRead: 0 })
    expect(store.page({ threadId: 'thread-1' })).toEqual(untouched)
    expect(store.summary('thread-0').working).toBe(20)
    store.resetWorkCounters()
    const page = store.page({ threadId: 'thread-0' })
    const details = store.assignments({ threadId: 'thread-0', agentId: 'saved-0' })
    expect(page.rows.length).toBe(50)
    expect(details.assignments).toHaveLength(10)
    expect(store.work.pageRowsRead).toBeLessThanOrEqual(62)
    let resultCount = 0
    for (let thread = 0; thread < 3; thread++) for (let agent = 0; agent < 100; agent++) {
      let before: number | undefined
      do {
        const history = store.assignments({ threadId: `thread-${thread}`, agentId: `saved-${agent}`, before })
        for (const item of history.assignments) { expect(item.result).toBe(`Saved output ${item.id.replace('saved-job-', '')}`); resultCount++ }
        before = history.before
      } while (before)
    }
    expect(resultCount).toBe(5000)
    store.resetWorkCounters(); store.close(); store.open()
    // Restart touches the twenty formerly live assignments, never the saved archive.
    expect(store.work).toEqual({ indexedReads: 21, rowWrites: 20, assignmentWrites: 20, classificationWrites: 0, pageRowsRead: 0 })
    expect(store.summary('thread-0').unknown).toBe(20)
    expect(store.summary('thread-1').unknown).toBe(0)
  })
})
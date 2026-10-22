import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { briefExcerpt, threadDelegations } from '../../../src/main/agents/agentsView'
import { LocalHostService, type LocalHostControl } from '../../../src/main/agents/hostService'
import type { AgentState } from '../../../src/shared/agents'
import { HOST_DELEGATION_BRIEF_EXCERPT } from '../../../src/shared/agentsView'
import type { DelegatedView, DelegationView, RefusedView } from '../../../src/shared/delegation'

const view = (thread: string, fields: Partial<DelegatedView> = {}): DelegatedView => ({ id: randomUUID(), thread, action: 'start', work: 'code-review',
  rootUserMessageId: 'root', anchorMessageId: 'root', briefMessageId: 'brief', outcome: 'working', told: false, createdAt: '2026-10-21T10:00:00.000Z', waiting: false, ...fields })

/** A delegation record that answers from fixed views, and keeps each read it is asked for. */
function record(made: Record<string, DelegationView[]>, received: Record<string, DelegatedView[]> = {}, briefs: Record<string, string> = {}) {
  const viewReads: string[][] = [], briefReads: string[][] = []
  return {
    viewReads, briefReads,
    viewsOf(threadIds: readonly string[]) {
      viewReads.push([...threadIds])
      return new Map(threadIds.map(id => [id, { made: made[id] ?? [], received: received[id] ?? [] }]))
    },
    briefsOf(threadIds: readonly string[]) {
      briefReads.push([...threadIds])
      return new Map(threadIds.flatMap(id => briefs[id] === undefined ? [] : [[id, briefs[id]!] as const]))
    },
  }
}

describe('the iPhone’s read of a thread’s delegated threads (ADR-0103)', () => {
  it('lists both levels from the snapshot’s links with the start, newest outcome and brief, and never a refused start or a reply', () => {
    const review = view('review', { createdAt: '2026-10-21T10:01:00.000Z', outcome: 'answered', outcomeAt: '2026-10-21T10:03:00.000Z', told: true })
    const again = view('review', { action: 'send', work: 'research', createdAt: '2026-10-21T10:05:00.000Z', outcome: 'working', outcomeAt: '2026-10-21T10:04:00.000Z', waiting: true })
    const refused: RefusedView = { id: randomUUID(), action: 'start', work: 'building', outcome: 'refused', refusal: 'LEVEL_LIMIT', createdAt: '2026-10-21T10:02:00.000Z' }
    const check = view('check', { work: 'research', createdAt: '2026-10-21T10:06:00.000Z', outcome: 'stopped', outcomeAt: '2026-10-21T10:07:00.000Z' })
    const delegation = record({ owner: [review, refused, again], review: [check] }, {}, { review: 'Review the login fix.', check: 'Check the retry docs.' })
    const threads = [{ id: 'owner' }, { id: 'review', delegatedBy: 'owner' }, { id: 'check', delegatedBy: 'review' }, { id: 'elsewhere', delegatedBy: 'other' }]
    const read = threadDelegations(delegation, threads, 'owner')
    expect(read).toEqual({ threadId: 'owner', threads: [
      // Its start is the brief that started it; the outcome is its newest brief's, still working, so no finish time.
      { thread: 'review', by: 'owner', work: 'code-review', outcome: 'working', startedAt: '2026-10-21T10:01:00.000Z', waiting: true, brief: 'Review the login fix.' },
      { thread: 'check', by: 'review', work: 'research', outcome: 'stopped', startedAt: '2026-10-21T10:06:00.000Z', outcomeAt: '2026-10-21T10:07:00.000Z', waiting: false, brief: 'Check the retry docs.' },
    ] })
    expect(JSON.stringify(read)).not.toContain('reply')
    // The record is read once for every row's views and once for their briefs, and a thread below another owner's never.
    expect(delegation.viewReads).toEqual([['owner', 'review', 'check']])
    expect(delegation.briefReads).toEqual([['review', 'check']])
  })

  it('reads the record once for views and once for briefs however many rows it shows', () => {
    const made: Record<string, DelegationView[]> = { owner: [] }, threads: { id: string, delegatedBy?: string }[] = [{ id: 'owner' }]
    for (let index = 0; index < 40; index++) {
      const thread = `agent-${index}`, child = `helper-${index}`
      made.owner!.push(view(thread)); made[thread] = [view(child)]
      threads.push({ id: thread, delegatedBy: 'owner' }, { id: child, delegatedBy: thread })
    }
    const delegation = record(made)
    expect(threadDelegations(delegation, threads, 'owner').threads).toHaveLength(80)
    expect(delegation.viewReads).toHaveLength(1)
    expect(delegation.briefReads).toHaveLength(1)
  })

  it('reads a start its delegating thread’s record no longer holds from the thread’s own, and leaves out a thread the record does not know', () => {
    const start = view('old', { createdAt: '2026-10-20T09:00:00.000Z', outcome: 'answered', outcomeAt: '2026-10-20T09:05:00.000Z' })
    const latest = view('old', { action: 'send', createdAt: '2026-10-21T09:00:00.000Z', outcome: 'unknown', unknownWhy: 'restarted', outcomeAt: '2026-10-21T09:10:00.000Z' })
    const delegation = record({ owner: [latest] }, { old: [start, latest] })
    const read = threadDelegations(delegation, [{ id: 'old', delegatedBy: 'owner' }, { id: 'stranger', delegatedBy: 'owner' }, { id: 'owner', delegatedBy: 'owner' }], 'owner')
    expect(read.threads).toEqual([{ thread: 'old', by: 'owner', work: 'code-review', outcome: 'unknown', unknownWhy: 'restarted',
      startedAt: '2026-10-20T09:00:00.000Z', outcomeAt: '2026-10-21T09:10:00.000Z', waiting: false }])
  })

  it('is a host service’s only where its Owl answer turns it on, and reads the published threads without copying the shell', async () => {
    const threads = [{ id: 'owner' }, { id: 'review', delegatedBy: 'owner' }]
    let copies = 0
    const control = { broadcastShell: () => ({ host: { threads } }) as unknown as AgentState, shell: () => { copies++; return { host: { threads } } as unknown as AgentState } } as unknown as LocalHostControl
    expect(new LocalHostService({ control }).supportsAgentsView).toBe(false)
    await expect(new LocalHostService({ control }).threadDelegations('owner')).rejects.toThrow()
    // A host with no delegation, such as a headless host, offers the view and reads every thread as having none.
    const headless = new LocalHostService({ control, agentsView: {} })
    expect(headless.supportsAgentsView).toBe(true)
    expect(await headless.threadDelegations('owner')).toEqual({ threadId: 'owner', threads: [] })
    const seen: unknown[] = []
    const desktop = new LocalHostService({ control, agentsView: { delegations: (threadId, published) => { seen.push(published); return { threadId, threads: [] } } } })
    await desktop.threadDelegations('owner')
    expect(seen).toEqual([threads]); expect(seen[0]).toBe(threads)
    expect(copies).toBe(0)
  })

  it('cuts a brief to its start without splitting a character in two', () => {
    expect(briefExcerpt('short')).toBe('short')
    const long = 'a'.repeat(HOST_DELEGATION_BRIEF_EXCERPT - 1) + '😀' + 'tail'
    const cut = briefExcerpt(long)
    expect(cut).toBe('a'.repeat(HOST_DELEGATION_BRIEF_EXCERPT - 1))
    expect(briefExcerpt('b'.repeat(HOST_DELEGATION_BRIEF_EXCERPT + 10))).toHaveLength(HOST_DELEGATION_BRIEF_EXCERPT)
  })
})

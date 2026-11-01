// @vitest-environment node
/**
 * Which settled threads a phone that accepts `settled-threads-on-request` is not sent with its list, and how it reads
 * them a page at a time (ADR-0028, November 1 part 2). The owner's laptop held 584 settled threads of 632; the phone
 * shows them only on the Settled shelf, so it is sent this week's and reads older ones when the user asks.
 */
import { describe, expect, it } from 'vitest'
import { heldBackSettled, settledPage, SETTLED_KEPT_MS } from '../../../src/host/heldBackSettled'
import type { AgentProject, AgentRequest, AgentThread } from '../../../src/shared/agents'

const NOW = Date.parse('2026-11-01T12:00:00.000Z')
const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString()
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread =>
  ({ id, title: `Thread ${id}`, projectId: 'p', modelId: 'm', status: 'idle', messages: [], requests: [], ...fields })
const asking = [{ id: 'q', kind: 'question' }] as unknown as AgentRequest[]
const projects: AgentProject[] = [{ id: 'p', title: 'Sotto', path: 'C:/sotto' }, { id: 'shelved', title: 'Shelved', path: 'C:/shelved', workspaceSettledAt: ago(40) }]

describe('settled threads held back from a phone', () => {
  it('holds back a thread settled more than a week ago, and keeps one settled this week and every open one', () => {
    const threads = [thread('open'), thread('this-week', { settledAt: ago(2) }), thread('old', { settledAt: ago(30) }),
      thread('archived', { archivedAt: ago(30) }), thread('workspace', { workspaceSettledAt: ago(9) }),
      thread('in-shelved-project', { projectId: 'shelved' }), thread('edge', { settledAt: new Date(NOW - SETTLED_KEPT_MS + 1000).toISOString() })]
    expect([...heldBackSettled(threads, projects, { now: NOW, kept: new Set() })].sort()).toEqual(['archived', 'in-shelved-project', 'old', 'workspace'])
  })

  it('keeps a settled thread made active again, and one settled with no time named is held back', () => {
    const threads = [thread('reopened', { settledAt: ago(30), settledOverride: 'active' }), thread('untimed', { settledOverride: 'settled' })]
    expect([...heldBackSettled(threads, projects, { now: NOW, kept: new Set() })]).toEqual(['untimed'])
  })

  it('keeps an old settled thread that asks the user something, every thread it was delegated from, and one the phone has open', () => {
    const threads = [thread('top', { settledAt: ago(30) }), thread('middle', { settledAt: ago(30), delegatedBy: 'top' }),
      thread('asks', { settledAt: ago(30), delegatedBy: 'middle', requests: asking }), thread('open-here', { settledAt: ago(30) }),
      thread('quiet', { settledAt: ago(30) })]
    expect([...heldBackSettled(threads, projects, { now: NOW, kept: new Set(['open-here']) })]).toEqual(['quiet'])
  })

  it('reads held-back threads newest settled first, a page at a time, and finds them by title or project', () => {
    const threads = Array.from({ length: 7 }, (_, index) => thread(`t${index}`, { settledAt: ago(10 + index), title: index % 2 ? `Billing ${index}` : `Docs ${index}` }))
    const first = settledPage(threads, projects, { limit: 3 })
    expect(first.threads.map(item => item.id)).toEqual(['t0', 't1', 't2'])
    const second = settledPage(threads, projects, { limit: 3, after: first.next! })
    expect(second.threads.map(item => item.id)).toEqual(['t3', 't4', 't5'])
    const last = settledPage(threads, projects, { limit: 3, after: second.next! })
    expect(last.threads.map(item => item.id)).toEqual(['t6'])
    expect(last.next).toBeNull()
    expect(settledPage(threads, projects, { limit: 30, query: 'billing' }).threads.map(item => item.id)).toEqual(['t1', 't3', 't5'])
    expect(settledPage(threads, projects, { limit: 30, query: 'sotto' }).threads).toHaveLength(7)
    // A page after a thread that has since left the held-back list starts from where that thread was.
    const moved = threads.filter(item => item.id !== 't2')
    expect(settledPage(moved, projects, { limit: 3, after: first.next! }).threads.map(item => item.id)).toEqual(['t3', 't4', 't5'])
  })

  it('pages through threads in any order, some settled at the same time, as one ordered list', () => {
    // A fixed shuffle: settled times repeat every 37 threads, so ties fall back to the ID.
    const threads = Array.from({ length: 200 }, (_, index) => thread(`t${String((index * 73) % 200).padStart(3, '0')}`, { settledAt: ago(10 + ((index * 73) % 37)) }))
    const expected = [...threads].sort((left, right) => Date.parse(right.settledAt!) - Date.parse(left.settledAt!) || (left.id < right.id ? -1 : 1)).map(item => item.id)
    const read: string[] = []
    let after: string | undefined
    for (let pages = 0; pages < 10; pages++) {
      const page = settledPage(threads, projects, { limit: 50, after })
      read.push(...page.threads.map(item => item.id))
      if (!page.next) break
      after = page.next
    }
    expect(read).toEqual(expected)
  })
})

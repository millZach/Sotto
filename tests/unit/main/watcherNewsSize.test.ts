import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { watcherNewsText, watcherPullRequestWords, watcherReplyStart, type WatcherNewsDetail } from '../../../src/main/agents/watcherNews'
import type { WatcherEvent, WatcherNews } from '../../../src/shared/watcherNews'

// A wake-up's news as the audit of 14 Oct - 5 Nov 2026 saw it (#2232): turn ends with their replies, a card, pull request
// news, and evidence news that rode along with nothing to tell. IDs have the shapes Sotto gives them: UUIDs and digests.
const hostId = '6f1c2a5e-8d3b-4c7a-9e21-0b5d7f3a1c42', requestId = '3b9e7d21-4a6c-4f8e-b1d2-7c5a9e0f3b18'
const thread = (n: number) => ({ hostId, threadId: `0d4f${String(n).padStart(4, '0')}-2b7e-4c1a-9f3d-5e8a6b2c7d10` })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const at = '2026-11-05T12:00:00.000Z'
const event = (n: number, kind: WatcherEvent['kind'], extra: Partial<WatcherEvent> = {}): WatcherEvent =>
  ({ id: digest(`${kind}-${n}-${JSON.stringify(extra)}`), kind, requestId, target: thread(n), generation: 1, observedAt: at, ...extra })
const reply = 'Pushed the fix to fix/watcher-news and opened the pull request. Typecheck, lint and the targeted tests pass; CI is running now.'
const events: WatcherEvent[] = [
  event(1, 'turn-finished', { turnId: 'turn-1', operationId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }),
  event(1, 'evidence-changed', { evidenceIds: ['e1'] }),
  event(2, 'turn-finished', { turnId: 'turn-2' }),
  event(2, 'evidence-changed', { evidenceIds: ['e2'] }),
  event(3, 'needs-user', { requestCardId: 'card-3', requestCardKind: 'question' }),
  event(3, 'needs-user', { requestCardId: 'card-3b', requestCardKind: 'question' }),
  event(4, 'evidence-changed', { evidenceIds: ['e4'] }),
  event(5, 'work-settled', { turnId: 'turn-5' }),
  event(6, 'request-closed', { requestCardId: 'card-6', requestCardKind: 'question' }),
  event(7, 'evidence-changed', { evidenceIds: ['e7'] }),
  event(7, 'evidence-changed', { evidenceIds: ['e7b'], generation: 2 }),
]
const prThread = { pullRequests: [{ url: 'https://github.com/millZach/Sotto/pull/2260', number: 2260, title: 'x', state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: at }] }
const detail: WatcherNewsDetail = item => item.kind === 'turn-finished' || item.kind === 'work-settled'
  ? watcherReplyStart({ status: 'idle', lastTurn: { id: item.turnId!, status: 'completed' } }, item.turnId, { text: reply }, item.operationId !== undefined)
  // Thread 4's pull request moved; the others' evidence news rode along with nothing to tell.
  : item.kind === 'evidence-changed' && item.target.threadId === thread(4).threadId
    ? watcherPullRequestWords(new Map([['millzach/sotto#2260', new Set(['checks-failed' as const])]]), prThread) : undefined
const note = (items: WatcherEvent[]): WatcherNews => ({ source: 'watcher', watcher: { hostId, threadId: 'watcher' }, events: items, omitted: 0 })

// The same three wake-ups measured 508 characters per item on main before #2232 (1,097, 2,188 and 4,849 characters).
const BEFORE_PER_ITEM = 508

it('says each thing in Watcher\'s news once: no closing paragraph, no event IDs, no empty evidence lines, repeats merged (#2232)', () => {
  const wakeUps = [[events[0]!], events.slice(0, 4), events]
  const total = wakeUps.reduce((sum, items) => sum + watcherNewsText(note(items), detail).length, 0)
  const items = wakeUps.reduce((sum, items) => sum + items.length, 0)
  expect(total / items).toBeLessThanOrEqual(BEFORE_PER_ITEM * 2 / 3)
  const text = watcherNewsText(note(events), detail)
  for (const item of events) expect(text).not.toContain(item.id)
  expect(text).not.toContain('Sotto observed changed evidence')
  expect(text).not.toContain('A reply given whole here is enough to act on')
  // Evidence news is what changed: thread 4's pull request, and nothing for the threads whose evidence had nothing to tell.
  expect(text).toContain(`${JSON.stringify(thread(4))}: Pull request #2260: checks failed on its newest commit. Use requestId ${requestId} for this thread.`)
  expect(text).not.toContain(JSON.stringify(thread(7)))
  // Two cards on one thread say the same, once, with a count.
  expect(text).toContain(`${JSON.stringify(thread(3))}, 2 times: This thread waits on the user to answer its request`)
  expect(text.split('\n').filter(line => line.startsWith(JSON.stringify(thread(3))))).toHaveLength(1)
})

it('keeps an evidence line\'s words while replies give way to room (#2232)', () => {
  // Thirty finished turns whose replies cannot all fit, and a pull request whose checks failed.
  const finished = Array.from({ length: 30 }, (_, n) => event(100 + n, 'turn-finished', { turnId: `turn-${n}` }))
  const crowded: WatcherNewsDetail = item => item.kind === 'evidence-changed' ? detail(item) : 'x'.repeat(2_000)
  const text = watcherNewsText(note([...finished, events[6]!]), crowded)
  expect(text).toContain(`${JSON.stringify(thread(4))}: Pull request #2260: checks failed on its newest commit.`)
  expect(text).not.toContain('omitted')
})

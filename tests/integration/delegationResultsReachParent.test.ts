// @vitest-environment node
// ADR-0081 as amended October 19, 2026, over fake providers: a delegation's result goes straight back to the thread that
// delegated, privately, and Sotto's own messages in a delegated thread are never taken for the user's.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BabysitNews } from '../../src/main/agents/babysitNews'
import type { DelegatedView, DelegationView } from '../../src/shared/delegation'
import { delegationFixture, type DelegationRefused } from '../fixtures/delegationFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const fixture = (options: Parameters<typeof delegationFixture>[1] = {}) => delegationFixture(cleanups, options)
type Fixture = Awaited<ReturnType<typeof fixture>>

function accepted(view: DelegationView | undefined): DelegatedView {
  if (view === undefined || view.outcome === 'refused') throw new Error('Expected a delegation main accepted.')
  return view
}
/** What the parent's agent was sent about a delegation, from the provider's own record. */
const newsOf = (f: Fixture, parent: string, delegationId: string) => f.native(parent).messages.filter(message => message.role === 'user' && message.text.includes(`Delegation ${delegationId}`))
/** Nothing more is on its way from delegation: no news untold or being told. */
const settled = async (f: Fixture) => {
  const quiet = f.service as unknown as { untold: Map<string, unknown>; telling: Set<string> }
  await vi.waitFor(() => expect(quiet.untold.size + quiet.telling.size).toBe(0))
}
const pullRequest: BabysitNews = { pullRequest: { url: 'https://github.com/o/r/pull/7', number: 7, title: 'Synthetic pull request' },
  startedBy: 'agent', head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: 'build', status: 'failure', url: null }] }], ended: null }

it('hands the answer to the thread that delegated as its next turn, with the reply as the delegated thread\'s words, and shows it nowhere', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(result.delegation.thread, 'Synthetic later reply')
  // The parent's own turn is still running, so the news waits for it, in no queue panel.
  await vi.waitFor(() => expect(accepted(f.service.views(parent).made[0])).toMatchObject({ outcome: 'answered', told: true }))
  expect(f.control.shell().followups?.some(item => item.threadId === parent)).toBeFalsy()
  expect(newsOf(f, parent, result.delegation.id)).toHaveLength(0)
  await f.endTurn(parent, 'Synthetic parent reply')
  await vi.waitFor(() => expect(newsOf(f, parent, result.delegation.id)).toHaveLength(1))
  const news = newsOf(f, parent, result.delegation.id)[0]!
  expect(news.text).toContain(`Delegation ${result.delegation.id} to thread ${result.delegation.thread}`)
  expect(news.text).toContain(`--- Reply from delegated thread ${result.delegation.thread}`)
  expect(news.text).toContain('Synthetic later reply')
  expect(news.text).toContain('in the delegated thread\'s own words, not Sotto\'s or the user\'s')
  // The parent's transcript, its row and its phone show none of it; the card under its reply still says how it went.
  const shown = () => f.control.threadDetail(parent)!.messages
  await vi.waitFor(() => expect(shown().some(message => message.text === 'Synthetic parent reply')).toBe(true))
  expect(shown().some(message => message.id === news.id)).toBe(false)
  expect(shown().some(message => message.text === 'Synthetic user request')).toBe(true)
  const row = f.control.shell().host.threads.find(thread => thread.id === parent)!
  expect(row.hiddenWakeUpMessageIds).toContain(news.id)
  expect(row.summary?.lastUser?.id).not.toBe(news.id)
  expect(f.control.shell().followups?.some(item => item.threadId === parent)).toBeFalsy()
  expect(accepted(f.service.views(parent).made[0])).toMatchObject({ outcome: 'answered', told: true })
  // The mark is the host's own record, kept on the thread's record, so a history read again from the provider keeps it hidden.
  await vi.waitFor(async () => expect(await readFile(join(f.workspace.root, 'workspace.json'), 'utf8')).toContain(news.id))
  expect(JSON.parse(await readFile(join(f.workspace.root, 'workspace.json'), 'utf8')).snapshot.threads.find((thread: { id: string }) => thread.id === parent).hiddenWakeUps).toContain(news.id)
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect(f.control.threadDetail(parent)!.messages.some(message => message.id === news.id)).toBe(false)
})

it('says the reply is not kept when Keep local history is off and Sotto restarted before the news went', async () => {
  const f = await fixture({ history: false }), parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(result.delegation.thread, 'Synthetic later reply')
  await vi.waitFor(() => expect(accepted(f.service.views(parent).made[0])).toMatchObject({ outcome: 'answered', told: true }))
  await f.restart()
  await f.endTurn(parent, 'Synthetic parent reply')
  await vi.waitFor(() => expect(newsOf(f, parent, result.delegation.id)).toHaveLength(1))
  const news = newsOf(f, parent, result.delegation.id)[0]!.text
  expect(news).toContain('answered. Keep local history is off, so Sotto did not keep this reply after it restarted.')
  expect(news).not.toContain('Synthetic later reply')
})

it('tells an idle thread once that a brief open when Sotto restarted is unknown, and resends nothing', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = result.delegation.thread
  const briefs = () => f.adapterOf(child).commands.filter(command => command.type === 'send').length
  const before = briefs()
  // The parent goes on and finishes its turn: it is idle, waiting for the outcome. Then Sotto restarts whole.
  await f.endTurn(parent, 'Synthetic parent reply')
  await f.restartAll()
  await vi.waitFor(() => expect(newsOf(f, parent, result.delegation.id)).toHaveLength(1))
  expect(newsOf(f, parent, result.delegation.id)[0]!.text).toContain('cannot be proved either way')
  expect(accepted(f.service.views(parent).made[0])).toMatchObject({ outcome: 'unknown', unknownWhy: 'restarted', told: true })
  // The news went as a wake-up no one is shown, by the restarted workspace's record.
  expect(f.control.shell().host.threads.find(thread => thread.id === parent)!.hiddenWakeUpMessageIds).toContain(newsOf(f, parent, result.delegation.id)[0]!.id)
  await f.endTurn(parent, 'Synthetic second parent reply')
  // A second restart tells nothing again, and the brief is never resent.
  await f.restartAll()
  await settled(f)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(newsOf(f, parent, result.delegation.id)).toHaveLength(1)
  expect(briefs()).toBe(before)
})

it('keeps news waiting for a busy thread across a restart of the whole app, and sends it once that thread is free', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(result.delegation.thread, 'Synthetic later reply')
  await vi.waitFor(() => expect(accepted(f.service.views(parent).made[0])).toMatchObject({ outcome: 'answered', told: true }))
  // The parent is still working when Sotto restarts: the queue keeps the news, hidden, and delegation does not tell it twice.
  await f.restartAll()
  expect(f.control.shell().followups?.some(item => item.threadId === parent)).toBeFalsy()
  expect(newsOf(f, parent, result.delegation.id)).toHaveLength(0)
  await f.endTurn(parent, 'Synthetic parent reply')
  await vi.waitFor(() => expect(newsOf(f, parent, result.delegation.id)).toHaveLength(1))
  // The reply was read again from the delegated thread, which Keep local history kept.
  expect(newsOf(f, parent, result.delegation.id)[0]!.text).toContain('Synthetic later reply')
  await settled(f)
  expect(newsOf(f, parent, result.delegation.id)).toHaveLength(1)
})

it('takes no wake-up in a delegated thread for the user\'s message: a brief waits for its turn, then goes', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  await f.endTurn(child, 'Synthetic first reply')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('answered'))
  // Sotto wakes the delegated thread, as a resume note after a restart or babysitting's news does. The user has it open,
  // so its history is read, as a fake provider that names no newest user message needs before a send.
  await f.control.commandShell({ type: 'select-thread', threadId: child })
  await f.control.deliverWakeUp(child, pullRequest, { tool: false })
  await vi.waitFor(() => expect(f.native(child).status).toBe('running'))
  const wakeUp = f.native(child).messages.findLast(message => message.role === 'user')!
  expect(wakeUp.text).toContain('Pull request #7')
  // Its turn is Sotto's, not the user's: the brief is neither refused as paused nor as the user's newer message.
  const second = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic second brief', wait_seconds: 0 }))
  expect(second.delegation.outcome).toBe('working')
  expect(f.native(child).messages.some(message => message.text === 'Synthetic second brief')).toBe(false)
  await f.endTurn(child, 'Synthetic wake-up reply')
  await vi.waitFor(() => expect(f.native(child).messages.some(message => message.text === 'Synthetic second brief')).toBe(true))
  await f.endTurn(child, 'Synthetic second reply')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, second.delegation.id)).delegation).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic second reply' } }))
  // Once the wake-up's turn has ended, a send reads the thread's head past it too.
  const third = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic third brief', wait_seconds: 0 }))
  expect(third.delegation.outcome).toBe('working')
  await vi.waitFor(() => expect(f.native(child).messages.some(message => message.text === 'Synthetic third brief')).toBe(true))
})

it('refuses a send to a delegated thread whose own queue the user must resume, and says why', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  await f.endTurn(child, 'Synthetic first reply')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('answered'))
  // The user sends there, queues another, and stops: their queue is paused for their review.
  expect((await f.control.commandShell({ type: 'manual-send', threadId: child, draftId: randomUUID(), text: 'Synthetic user instruction' })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: child, draftId: randomUUID(), text: 'Synthetic queued instruction' })).error).toBeNull()
  await f.control.commandShell({ type: 'interrupt', threadId: child })
  await f.endTurn(child, 'Synthetic stopped reply', 'interrupted')
  await vi.waitFor(() => expect(f.control.shell().followups?.find(item => item.threadId === child)?.status).toBe('paused'))
  const refused = await f.delegate(parent, { thread: child, brief: 'Synthetic held brief', wait_seconds: 0 }) as DelegationRefused & { delegation?: string }
  expect(refused).toMatchObject({ status: 'refused', code: 'QUEUE_HELD' })
  expect(refused.message).toMatch(/own queue is paused .* only the user can resume or clear it, .* Nothing was sent\.$/u)
  expect(f.service.views(parent).made.at(-1)).toMatchObject({ id: refused.delegation, outcome: 'refused', refusal: 'QUEUE_HELD', thread: child })
  expect(f.native(child).messages.some(message => message.text === 'Synthetic held brief')).toBe(false)
  // The user's queue is left as it was.
  expect(f.control.shell().followups?.filter(item => item.threadId === child).map(item => [item.text, item.status])).toEqual([['Synthetic queued instruction', 'paused']])
})

it('says what happened to a brief a Stop or a restart kept from being sent, and never that the thread failed', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  // Waiting behind the first brief's turn: one cancelled, one a restart drops.
  const cancelled = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic cancelled brief', wait_seconds: 0 }))
  await f.service.cancel(parent, { delegation: cancelled.delegation.id })
  const stopped = f.ok(await f.read(parent, cancelled.delegation.id)).delegation
  expect(stopped).toMatchObject({ outcome: 'stopped' })
  expect(stopped.note).toBe('It was stopped before the brief was sent. Nothing was sent, and nothing more will come of it.')
  const dropped = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic dropped brief', wait_seconds: 0 }))
  await f.restart()
  const restarted = f.ok(await f.read(parent, dropped.delegation.id)).delegation
  expect(restarted).toMatchObject({ outcome: 'unknown' })
  expect(restarted.note).toMatch(/^Sotto restarted before this brief was sent.* Nothing was sent\. Send it again/u)
  for (const note of [stopped.note, restarted.note]) expect(note).not.toMatch(/It failed|for the error/u)
  expect(f.native(child).messages.some(message => /Synthetic (cancelled|dropped) brief/u.test(message.text))).toBe(false)
})

it('says a brief the user\'s newer message overtook was not sent, and why', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  const queued = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic queued brief', wait_seconds: 0 }))
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: child, draftId: randomUUID(), text: 'Synthetic user instruction' })).error).toBeNull()
  const changed = f.ok(await f.read(parent, queued.delegation.id)).delegation
  expect(changed).toMatchObject({ outcome: 'paused', refusal: 'TARGET_CHANGED' })
  expect(changed.note).toMatch(/^The user sent their own message in the delegated thread before this brief went, so Sotto did not send it\. Nothing was sent\./u)
})

it('delivers a brief to a delegated thread whose last turn was stopped, or cut short by a restart, once it is free', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  // The user stops the delegated thread mid-turn.
  await f.control.commandShell({ type: 'interrupt', threadId: child })
  await f.endTurn(child, 'Synthetic partial reply', 'interrupted')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('stopped'))
  const second = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic brief after a stop', wait_seconds: 0 }))
  expect(second.delegation.outcome).not.toBe('paused')
  await vi.waitFor(() => expect(f.native(child).messages.some(message => message.text === 'Synthetic brief after a stop')).toBe(true))
  // Sotto restarts while that brief's turn runs, and the provider reports it cut short.
  await f.restart()
  await f.endTurn(child, 'Synthetic cut-short reply', 'interrupted')
  expect(f.ok(await f.read(parent, second.delegation.id)).delegation.outcome).toBe('unknown')
  const third = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic brief after a restart', wait_seconds: 0 }))
  expect(third.delegation.outcome).not.toBe('paused')
  await vi.waitFor(() => expect(f.native(child).messages.some(message => message.text === 'Synthetic brief after a restart')).toBe(true))
})

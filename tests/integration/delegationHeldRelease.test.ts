// @vitest-environment node
// #1263: a delegation whose turn ended with background work that is never seen to end does not wait for good. Once its
// thread has sat idle for twenty minutes, the thread that delegated is told so once, plainly, with how its reply began.
import { afterEach, expect, it, vi } from 'vitest'
import { delegationFixture } from '../fixtures/delegationFixture'
import { markTurnActivity } from '../../src/main/agents/turnActivity'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('tells the thread that delegated once when a background outcome has waited twenty minutes with its thread idle', async () => {
  let offset = 0
  const waits: { at: number; run: () => void }[] = []
  const f = await delegationFixture(cleanups, { delegation: { now: () => Date.now() + offset,
    schedule: (run, delay) => { const wait = { at: Date.now() + offset + delay, run }; waits.push(wait); return () => { waits.splice(waits.indexOf(wait), 1) } } } })
  const advance = (ms: number) => { offset += ms; for (const wait of waits.filter(item => item.at <= Date.now() + offset)) { waits.splice(waits.indexOf(wait), 1); wait.run() } }
  const parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(parent, 'Synthetic parent reply')
  const child = result.delegation.thread
  // The delegated turn ends with a monitor still running, and nothing more happens there.
  f.native(child).monitoring = [{ id: 'synthetic-monitor', label: 'Synthetic monitor' }]
  await f.endTurn(child, 'Synthetic review is running in the background.')
  const news = () => f.native(parent).messages.filter(message => message.role === 'user' && message.text.includes(`Delegation ${result.delegation.id}`))
  await vi.waitFor(() => expect(news()).toHaveLength(1))
  expect(news()[0]!.text).toContain('ended its turn with background work or monitoring still running')
  await f.endTurn(parent, 'Synthetic parent reply to the news')
  // Nineteen minutes is not yet twenty.
  advance(19 * 60_000); await f.emit(child)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(news()).toHaveLength(1)
  advance(2 * 60_000); await f.emit(child)
  await vi.waitFor(() => expect(news()).toHaveLength(2))
  const released = news()[1]!.text
  expect(released).toContain('held 21 minutes, thread idle')
  expect(released).toContain('Its last reply is, in the delegated thread\'s own words, not Sotto\'s or the user\'s: "Synthetic review is running in the background."')
  expect(f.ok(await f.read(parent, result.delegation.id)).delegation).toMatchObject({ outcome: 'background', note: expect.stringContaining('Held 21 minutes, thread idle') })
  // Once: more time passing tells nothing more.
  await f.endTurn(parent, 'Synthetic parent reply to the release')
  advance(60 * 60_000); await f.emit(child)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(news()).toHaveLength(2)
})

async function held(cleanups: (() => Promise<void>)[]) {
  let offset = 0
  const waits: { at: number; run: () => void }[] = []
  const f = await delegationFixture(cleanups, { delegation: { now: () => Date.now() + offset,
    schedule: (run, delay) => { const wait = { at: Date.now() + offset + delay, run }; waits.push(wait); return () => { waits.splice(waits.indexOf(wait), 1) } } } })
  const advance = (ms: number) => { offset += ms; for (const wait of waits.filter(item => item.at <= Date.now() + offset)) { waits.splice(waits.indexOf(wait), 1); wait.run() } }
  const parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(parent, 'Synthetic parent reply')
  const child = result.delegation.thread, native = f.native(child)
  const brief = native.messages.find(message => message.role === 'user')!
  native.monitoring = [{ id: 'synthetic-monitor', label: 'Synthetic monitor' }]
  native.activities = markTurnActivity(native.activities, { provider: 'claude', turnId: brief.id, status: 'completed', at: Date.now() })
  await f.endTurn(child, 'Synthetic review is running in the background.')
  const news = () => f.native(parent).messages.filter(message => message.role === 'user' && message.text.includes(`Delegation ${result.delegation.id}`))
  await vi.waitFor(() => expect(news()).toHaveLength(1))
  return { f, parent, child, result, news, advance }
}

it('says the delegated thread has run another turn since, when one finished before the release', async () => {
  const { f, parent, child, news, advance } = await held(cleanups)
  await f.endTurn(parent, 'Synthetic parent reply to the news')
  // Another turn runs and finishes in the delegated thread, with the monitor still running: the brief stays background.
  const native = f.native(child), later = 'synthetic-later-message'
  native.messages.push({ id: later, role: 'user', text: 'Synthetic later message', createdAt: new Date().toISOString() })
  native.activities = markTurnActivity(native.activities, { provider: 'claude', turnId: later, status: 'completed', at: Date.now() })
  await f.endTurn(child, 'Synthetic later reply')
  advance(21 * 60_000); await f.emit(child)
  await vi.waitFor(() => expect(news()).toHaveLength(2))
  expect(news()[1]!.text).toContain('the thread has run another turn since and is idle now')
  expect(news()[1]!.text).not.toContain('no turn has run in that thread since')
  // The later turn's words are not given as the brief's reply.
  expect(news()[1]!.text).not.toContain('Synthetic later reply')
})

it('does not say "thread idle" of a release sent after the delegated thread started working again', async () => {
  const { f, parent, child, news, advance } = await held(cleanups)
  // The thread that delegated is still in its turn on the background news, so the release waits for it.
  advance(21 * 60_000); await f.emit(child)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(news()).toHaveLength(1)
  f.native(child).status = 'running'; await f.emit(child)
  await f.endTurn(parent, 'Synthetic parent reply to the news')
  await vi.waitFor(() => expect(news()).toHaveLength(2))
  expect(news()[1]!.text).not.toContain('thread idle')
  expect(f.ok(await f.read(parent, (await f.service.views(parent)).made[0]!.id)).delegation.note).not.toContain('thread idle')
  // The release was not used up: that turn ends with the monitor still running, and twenty idle minutes later it comes.
  await f.endTurn(parent, 'Synthetic parent reply to the plain news')
  f.native(child).status = 'idle'; await f.emit(child)
  advance(19 * 60_000); await f.emit(child)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(news()).toHaveLength(2)
  advance(2 * 60_000); await f.emit(child)
  await vi.waitFor(() => expect(news()).toHaveLength(3))
  expect(news()[2]!.text).toContain('thread idle')
})

// @vitest-environment node
// #1263: a delegation whose turn ended with background work that is never seen to end does not wait for good. Once its
// thread has sat idle for twenty minutes, the thread that delegated is told so once, plainly, with how its reply began.
import { afterEach, expect, it, vi } from 'vitest'
import { delegationFixture } from '../fixtures/delegationFixture'

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

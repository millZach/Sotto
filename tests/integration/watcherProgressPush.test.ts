// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import type { WatcherHostProgress, WatcherHostProjection } from '../../src/shared/watcherHost'
import { watcherProgressHost, type WatcherProgressHost } from '../fixtures/watcherProgressHost'

/**
 * A paired desktop's Watcher is sent its watched threads' progress apart from the record (ADR-0073, November 10, 2026
 * amendment, #2391). On forge a step in one watched thread sent the laptop every request and operation again, 1.98 MB a
 * push. A desktop that accepts `watcher-progress` is sent what moved in the progress alone, and the projection whole once
 * anything else in it moved; one that does not is sent every projection whole, as before.
 */
const hosts: WatcherProgressHost[] = []
afterEach(async () => { for (const host of hosts.splice(0)) await host.close() })
const SIZE = { requests: 60, operations: 61, targets: 12 }
async function host() { const made = await watcherProgressHost(SIZE); hosts.push(made); return made }

type Frame = { event?: string; projection?: WatcherHostProjection; progress?: WatcherHostProgress }
const watcherFrames = (frames: readonly string[]): { text: string; frame: Frame }[] => frames
  .map(text => ({ text, frame: JSON.parse(text) as Frame })).filter(({ frame }) => frame.event === 'watcher-state' || frame.event === 'watcher-progress')
/** The next Watcher frame the desktop is sent after `seen` of them. */
async function next(frames: readonly string[], seen: number): Promise<{ text: string; frame: Frame }> {
  await expect.poll(() => watcherFrames(frames).length).toBeGreaterThan(seen)
  return watcherFrames(frames)[seen]!
}

it('sends a desktop that accepted watcher-progress only what moved in the progress, and the projection whole once anything else moved', async () => {
  const made = await host()
  const { client, frames, hello } = await made.desktop()
  expect(hello.features).toContain('watcher-progress')
  // The scope read registers this desktop's Watcher, and its answer is what the first push is measured from.
  expect(await client.watcherRead({ master: made.master })).toEqual(made.projection())
  // A shell pushed while the read was answered may have carried the same projection whole first.
  const start = watcherFrames(frames).length
  let seen = start
  for (let step = 0; step < 5; step++) {
    made.step()
    const { text, frame } = await next(frames, seen++)
    // One thread's step: its one entry, and not one request or operation.
    expect(frame.event).toBe('watcher-progress')
    expect(text).not.toMatch(/"requests"|"operations"|"evidence"/u)
    expect(frame.progress!.changed).toHaveLength(1)
    expect(Buffer.byteLength(text)).toBeLessThan(1_000)
    // The client hands its Watcher the projection the host would have sent whole.
    expect(client.cachedWatcherProjection(made.master)).toEqual(made.projection())
  }
  // A changed record goes whole, and so does new evidence.
  for (const change of [() => made.record(), () => made.evidence()]) {
    change()
    const { frame } = await next(frames, seen++)
    expect(frame.event).toBe('watcher-state')
    expect(frame.projection).toEqual(made.projection())
    expect(client.cachedWatcherProjection(made.master)).toEqual(made.projection())
  }
  // Progress after them is measured from the whole they carried.
  made.step()
  expect((await next(frames, seen++)).frame.event).toBe('watcher-progress')
  expect(client.cachedWatcherProjection(made.master)).toEqual(made.projection())
  // A thread that stops being watched goes by its target; one that starts above the others brings the list in order.
  made.unwatchLast()
  const gone = (await next(frames, seen++)).frame.progress!
  expect(gone).toMatchObject({ changed: [], removed: [expect.objectContaining({ threadId: 'synthetic-worker-11' })] })
  expect(client.cachedWatcherProjection(made.master)).toEqual(made.projection())
  made.watchFirst()
  const first = (await next(frames, seen)).frame.progress!
  expect(first.whole).toBe(true)
  expect(client.cachedWatcherProjection(made.master)).toEqual(made.projection())
  // Nothing went whole but the record and the evidence.
  expect(watcherFrames(frames).slice(start).map(({ frame }) => frame.event)).toEqual(['watcher-progress', 'watcher-progress', 'watcher-progress', 'watcher-progress', 'watcher-progress',
    'watcher-state', 'watcher-state', 'watcher-progress', 'watcher-progress', 'watcher-progress'])
})

it('sends a desktop that did not accept it every projection whole, as before', async () => {
  const made = await host()
  const peer = await made.rawDesktop(['detail-delta', 'watcher-reads'])
  expect(await peer.call('scope', { op: 'watcher-read', request: { master: made.master } })).toMatchObject({ ok: true, result: made.projection() })
  const start = peer.messages.length
  const frames = () => peer.messages.slice(start).filter(message => message.event === 'watcher-state' || message.event === 'watcher-progress')
  for (let step = 0; step < 3; step++) {
    made.step()
    await expect.poll(() => frames().length).toBe(step + 1)
    expect(frames()[step]).toEqual({ v: 1, event: 'watcher-state', projection: made.projection() })
  }
  made.record()
  await expect.poll(() => frames().length).toBe(4)
  expect(frames()[3]).toEqual({ v: 1, event: 'watcher-state', projection: made.projection() })
})

it('lets go of a projection a progress push does not follow, and measures from the projection a read answers with', async () => {
  const made = await host()
  const { client, frames } = await made.desktop()
  const told: (WatcherHostProjection | undefined)[] = []
  client.subscribeWatcher!(projection => told.push(projection))
  await client.watcherRead({ master: made.master })
  const start = watcherFrames(frames).length
  told.length = 0
  // The desktop comes to hold another revision than the host last wrote it, as a lost answer would leave it.
  const internal = client as unknown as { cachedWatcher: WatcherHostProjection | undefined }
  internal.cachedWatcher = { ...internal.cachedWatcher!, revision: 'not-what-the-host-wrote' }
  made.step()
  expect((await next(frames, start)).frame.event).toBe('watcher-progress')
  // Its Watcher is told the projection is gone, and its next reconcile reads it again.
  expect(client.cachedWatcherProjection(made.master)).toBeUndefined()
  expect(told).toEqual([undefined])
  expect(await client.watcherRead({ master: made.master })).toEqual(made.projection())
  made.step()
  expect((await next(frames, start + 1)).frame.event).toBe('watcher-progress')
  expect(client.cachedWatcherProjection(made.master)).toEqual(made.projection())
  expect(told.at(-1)).toEqual(made.projection())
})

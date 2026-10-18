// @vitest-environment node
/**
 * An unchanged native observation must not copy and parse retained Watcher history once per watch/participant.
 * Counts real AgentControl.watcherRecord calls, including read-only callers, rather than substituting a cheap mutator.
 * One copy covers the final operation mutation. Pruning private runtime guards only reads operation identities.
 */
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { centerTime } from '../fixtures/watcher'
import { watcherObservePerformance } from '../fixtures/watcherObservePerformance'

it.each([1, 6])('copies at most one Watcher record for unchanged observations with %i watches and retained takeovers', async watches => {
  const f = await watcherObservePerformance({ watches, olderMessages: 20, retainedTakeovers: 200,
    includeTakeoverMetadata: true, operationOutcome: 'unknown' })
  const copies = vi.spyOn(f.control, 'watcherRecord'), mutations = vi.spyOn(f.control, 'mutateWatcher')
  // This fixture has no queued sends. Keep unrelated asynchronous queue persistence/publication outside the loop.
  const cancelQueue = vi.spyOn(f.control, 'cancelWatcherQueue').mockResolvedValue(undefined)
  const observeWork = () => {
    copies.mockClear(); mutations.mockClear()
    // Keep setup, state assertions, cleanup and any later asynchronous publication outside this synchronous count.
    f.observe()
    return { copies: copies.mock.calls.length, mutations: mutations.mock.calls.length }
  }
  try {
    expect(f.state().localTakeovers).toHaveLength(200)
    expect(f.state().watches).toHaveLength(watches)
    const beforeHuman = observeWork()
    expect(f.state().watches!.every(watch => watch.pausedByUserMessageId === null)).toBe(true)

    // A newer Watcher send must advance live participant heads without rewriting older taken-over participants.
    const historical = structuredClone(f.state().requests[1]!.participants)
    f.control.mutateWatcher(record => {
      for (const [index, thread] of f.snapshot.threads.entries()) {
        const head = `next-machine-${index}`, operation = record.operations[index]!
        record.operations.push({ ...operation, id: randomUUID(), retryKey: randomUUID(), draftId: randomUUID(), messageId: head,
          turnMessageId: head, nativeTurnId: `next-native-turn-${index}` })
        thread.messages.push({ id: head, role: 'user', text: 'Synthetic newer Watcher instruction', createdAt: centerTime })
        thread.lastUserMessageId = head
        thread.lastTurn = { id: `next-native-turn-${index}`, messageId: head, status: 'running' }
      }
    })
    const changedMachine = observeWork()
    for (let index = 0; index < watches; index++) {
      expect(f.state().requests[0]!.participants[index]).toMatchObject({ state: 'participating', lastUserMessageId: `next-machine-${index}` })
      expect(f.state().watches![index]).toMatchObject({ lastUserMessageId: `next-machine-${index}`, pausedByUserMessageId: null })
    }
    expect(f.state().requests[1]!.participants).toEqual(historical)
    const afterMachine = observeWork()

    // This is an actual newer native human head, unlike the separate stale-head classification regression.
    // It must still fence earlier participation and refresh the authoritative head/pause despite the optimization.
    for (const [index, thread] of f.snapshot.threads.entries()) {
      const head = `native-human-${index}`
      thread.messages.push({ id: head, role: 'user', text: 'Synthetic direct human instruction', createdAt: centerTime })
      thread.lastUserMessageId = head
      thread.lastTurn = { id: `human-turn-${index}`, messageId: head, status: 'running' }
    }
    const changedHuman = observeWork()
    for (let index = 0; index < watches; index++) {
      expect(f.state().watches![index]).toMatchObject({ lastUserMessageId: `native-human-${index}`, pausedByUserMessageId: `native-human-${index}` })
      expect(f.state().requests[0]!.participants[index]).toMatchObject({ state: 'taken-over', takeover: { reason: 'native-user-send' } })
    }
    const afterHuman = observeWork()
    for (let index = 0; index < watches; index++) expect(f.state().watches![index]).toMatchObject({
      lastUserMessageId: `native-human-${index}`, pausedByUserMessageId: `native-human-${index}`,
    })
    const takenOver = structuredClone(f.state().requests[0]!.participants)
    // A completed idle native turn with no pending user work releases its standing pause as before.
    for (const thread of f.snapshot.threads) { thread.status = 'idle'; thread.lastTurn!.status = 'completed' }
    const completedHuman = observeWork()
    expect(f.state().watches!.every(watch => watch.pausedByUserMessageId === null)).toBe(true)
    expect(f.state().requests[0]!.participants).toEqual(takenOver)
    expect(f.state().requests[1]!.participants).toEqual(historical)
    const afterCompleted = observeWork()
    // Collect both steady passes and prove changed-head behavior before the expected initial RED assertion.
    const seen = JSON.stringify({ watches, retainedTakeovers: 200, beforeHuman, changedMachine, afterMachine, changedHuman, afterHuman,
      completedHuman, afterCompleted })
    for (const work of [beforeHuman, afterMachine, afterHuman, afterCompleted]) {
      expect(work.copies, `unchanged observation copies retained records per watch/participant: ${seen}`).toBeLessThanOrEqual(1)
      expect(work.mutations, `unchanged observation reparses retained records per watch/participant: ${seen}`).toBeLessThanOrEqual(1)
    }
  } finally { cancelQueue.mockRestore(); copies.mockRestore(); mutations.mockRestore(); await f.close() }
})

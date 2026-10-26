// @vitest-environment node
/**
 * The notes that say a host snapshot's thread list was made from an earlier one in place (#925, step 5). A reader follows
 * them from the snapshot it is given back to the one it last made something of; a note it cannot follow is read whole.
 * The notes must never keep earlier snapshots alive: each broadcast notes the one before it, and a chain held strongly
 * kept every broadcast since the last whole one, with every record each replaced (#925 review).
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { noteThreadsReplaced, threadsReplacedSince } from '../../../src/shared/threadListPatches'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('notes of thread lists made in place', () => {
  it('names the positions replaced between a snapshot and an earlier one the reader still holds', () => {
    const first = { threads: [] }, second = { threads: [] }, third = { threads: [] }
    noteThreadsReplaced(second, first, [1])
    noteThreadsReplaced(third, second, [3, 1])
    expect([...threadsReplacedSince(third, first)!].sort()).toEqual([1, 3])
    expect(threadsReplacedSince(third, third)!.size).toBe(0)
    expect(threadsReplacedSince(first, third)).toBeUndefined()
    expect(threadsReplacedSince({ threads: [] }, first)).toBeUndefined()
  })

  it('keeps no earlier snapshot alive: holding the latest of a long chain lets every earlier one go', async () => {
    const earlier: WeakRef<object>[] = []
    let latest: object | undefined
    ;(() => {
      let previous: object = { threads: [{ id: 'record-0' }] }
      earlier.push(new WeakRef(previous))
      for (let index = 1; index <= 60; index++) {
        const host = { threads: [{ id: `record-${index}` }] }
        noteThreadsReplaced(host, previous, [0])
        earlier.push(new WeakRef(host))
        previous = host
      }
      latest = previous
    })()
    // A WeakRef holds its target until the job that read it ends.
    await turn(); gc(); await turn(); gc()
    const alive = earlier.slice(0, -1).filter(ref => ref.deref() !== undefined).length
    expect(alive, 'snapshots before the latest still alive').toBe(0)
    expect(earlier.at(-1)!.deref()).toBe(latest)
  })

  it('finds the snapshot a reader holds though the ones between it and the latest have gone (#925 step 6)', async () => {
    // The window's broadcast skips the publishes a coalesced send passed over, and nothing holds those: the chain from the
    // latest back to the one it was last sent must not depend on when they are collected.
    const reader: { held?: object } = {}
    const between: WeakRef<object>[] = []
    let latest: object | undefined
    ;(() => {
      const held = { threads: [] }
      reader.held = held
      let previous: object = held
      for (let index = 0; index < 3; index++) {
        const host = { threads: [] }
        noteThreadsReplaced(host, previous, [index])
        between.push(new WeakRef(host))
        previous = host
      }
      latest = previous
    })()
    await turn(); gc(); await turn(); gc()
    expect(between.slice(0, -1).filter(ref => ref.deref() !== undefined).length, 'snapshots between still alive').toBe(0)
    expect([...threadsReplacedSince(latest!, reader.held!)!].sort()).toEqual([0, 1, 2])
  })

  it('reads whole past the steps a note carries, or from a snapshot noted nowhere', () => {
    const first = { threads: [] }
    let previous: object = first
    const chain: object[] = [first]
    for (let index = 0; index < 9; index++) {
      const host = { threads: [] }
      noteThreadsReplaced(host, previous, [index])
      chain.push(host)
      previous = host
    }
    expect([...threadsReplacedSince(previous, chain[1]!)!].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(threadsReplacedSince(previous, first)).toBeUndefined()
    expect(threadsReplacedSince(previous, chain[5]!, 2)).toBeUndefined()
    expect([...threadsReplacedSince(previous, chain[7]!, 2)!].sort()).toEqual([7, 8])
    // A snapshot made afresh, noted nowhere, breaks the chain for every reader after it.
    const fresh = { threads: [] }
    const after = { threads: [] }
    noteThreadsReplaced(after, fresh, [0])
    expect(threadsReplacedSince(after, previous)).toBeUndefined()
  })
})

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

  it('reads a snapshot whole once the one it was made from has gone', async () => {
    const reader: { held?: object } = {}
    let latest: object | undefined
    ;(() => {
      const held = { threads: [] }
      reader.held = held
      let previous: object = held
      for (let index = 0; index < 3; index++) {
        const host = { threads: [] }
        noteThreadsReplaced(host, previous, [index])
        previous = host
      }
      latest = previous
    })()
    await turn(); gc(); await turn(); gc()
    // The reader still holds the snapshot it made something of, but the ones between it and the latest have gone.
    expect(threadsReplacedSince(latest!, reader.held!)).toBeUndefined()
  })
})

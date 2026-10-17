import { describe, expect, it } from 'vitest'
import { OpenCodeTooOld, opencodeVersionRefusal, orphanedDescendants } from '../../../src/main/agents/opencodeServer'

describe('which OpenCode Sotto drives (ADR-0087)', () => {
  it.each([
    ['1.19.3', 'This is OpenCode 1.19.3, and Sotto works with OpenCode 2 only.'],
    ['opencode v2.0.30', 'OpenCode 2.0.31 or newer is required, and this client is 2.0.30.'],
    ['opencode v3.0.0', 'This is OpenCode 3.0.0, and Sotto works with OpenCode 2 only.'],
  ])('refuses %s in words', (said, words) => {
    expect(opencodeVersionRefusal(said)?.message).toContain(words)
  })
  it('names the version of a client that is only too old, so connect can offer the floor', () => {
    expect(opencodeVersionRefusal('opencode v2.0.30')).toBeInstanceOf(OpenCodeTooOld)
    expect(opencodeVersionRefusal('opencode v3.0.0')).not.toBeInstanceOf(OpenCodeTooOld)
  })
  it.each(['opencode v2.0.31', 'opencode v2.4.0', '2.0.31'])('drives %s', said => {
    expect(opencodeVersionRefusal(said)).toBeUndefined()
  })
})

describe('the processes a server that has exited leaves behind', () => {
  const started = 1_000_000
  it('finds its children and theirs, started after it, and nothing else', () => {
    expect(orphanedDescendants([
      { pid: 20, parent: 10, created: started + 500 },
      { pid: 30, parent: 20, created: started + 900 },
      { pid: 40, parent: 30, created: started + 950 },
      // A process whose parent once had this PID, before the server did: not the server's.
      { pid: 50, parent: 10, created: started - 60_000 },
      { pid: 60, parent: 50, created: started + 100 },
      // Unrelated.
      { pid: 70, parent: 4, created: started + 10 },
      { pid: 0, parent: 0, created: 0 },
    ], 10, started).sort()).toEqual([20, 30, 40])
  })
  it('leaves alone the children of a process that took the server’s PID after it exited', () => {
    expect(orphanedDescendants([
      { pid: 20, parent: 10, created: started + 500 },
      // PID 10 now belongs to another process, started after the server died; its own child is not the server's.
      { pid: 10, parent: 4, created: started + 5_000 },
      { pid: 80, parent: 10, created: started + 6_000 },
    ], 10, started)).toEqual([20])
  })
  it('never names Sotto itself', () => {
    expect(orphanedDescendants([{ pid: process.pid, parent: 10, created: started + 1 }], 10, started)).toEqual([])
  })
})

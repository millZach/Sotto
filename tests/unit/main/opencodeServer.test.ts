import { describe, expect, it } from 'vitest'
import { isRecordedServer, loopbackServerUrl, OpenCodeTooOld, opencodeVersionRefusal, orphanedDescendants, parseProcessStart } from '../../../src/main/agents/opencodeServer'

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

describe('a server a crash left, as the next connect knows it', () => {
  const startedAt = Date.parse('2026-10-16T21:48:03.400')
  const record = { pid: 4242, startedAt, owner: 99 }
  const command = '/home/zach/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=0'
  it('reads a start time and command line from ps, to the second', () => {
    expect(parseProcessStart('Fri Oct 16 21:48:03 2026 ' + command)).toEqual({ started: Date.parse('2026-10-16T21:48:03'), command })
    expect(parseProcessStart('Fri Oct  6 09:01:02 2026 sleep 1')).toEqual({ started: Date.parse('2026-10-06T09:01:02'), command: 'sleep 1' })
    expect(parseProcessStart('')).toBeUndefined()
  })
  it('is the process with its PID only when it started then and runs OpenCode’s server', () => {
    expect(isRecordedServer(record, parseProcessStart('Fri Oct 16 21:48:03 2026 ' + command))).toBe(true)
    // Started an hour later: another process took the PID.
    expect(isRecordedServer(record, parseProcessStart('Fri Oct 16 22:48:03 2026 ' + command))).toBe(false)
    // Started then, but not OpenCode's server.
    expect(isRecordedServer(record, parseProcessStart('Fri Oct 16 21:48:03 2026 /usr/bin/python3 -m http.server'))).toBe(false)
    // A command line the system will not show is no proof.
    expect(isRecordedServer(record, { started: startedAt })).toBe(false)
    expect(isRecordedServer(record, undefined)).toBe(false)
  })
  it('matches the start ps reported when Sotto started it, however far ps reads from the clock', () => {
    // Linux's ps adds ticks since boot to a boot time kept in whole seconds, then drops the fraction again: on a machine
    // measured for this, it read up to 1.8 s before the clock Sotto wrote down, and a stepped clock moves it further.
    const reported = Date.parse('2026-10-16T21:48:01')
    const written = { ...record, started: reported }
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:01 2026 ' + command))).toBe(true)
    // ps reads a second later than it did: the boot time it adds to was rounded the other way.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:02 2026 ' + command))).toBe(true)
    // Any further, and it is another process that took the PID, whatever the clock said.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:03 2026 ' + command))).toBe(false)
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:47:59 2026 ' + command))).toBe(false)
    // The command line still has to be OpenCode's server.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:01 2026 /usr/bin/python3 -m http.server'))).toBe(false)
  })
})

describe('where a server says it listens', () => {
  it.each([['http://127.0.0.1:4096', 'http://127.0.0.1:4096'], ['http://127.0.0.1:4096/', 'http://127.0.0.1:4096'], ['http://localhost:51', 'http://localhost:51'], ['http://[::1]:7', 'http://[::1]:7']])('takes %s', (said, url) => {
    expect(loopbackServerUrl(said)).toBe(url)
  })
  it.each(['http://10.0.0.2:4096', 'http://127.0.0.1.nip.io:4096', 'http://127.0.0.1:4096/api', 'ftp://127.0.0.1:21', 'not a url'])('refuses %s', said => {
    expect(loopbackServerUrl(said)).toBeUndefined()
  })
})

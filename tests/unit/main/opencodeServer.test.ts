// @vitest-environment node
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { endServersLeftBehind, isRecordedServer, loopbackServerUrl, OpenCodeTooOld, opencodeVersionRefusal, orphanedDescendants, parseProcessStart, recordOpenCodeServer } from '../../../src/main/agents/opencodeServer'

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
    // ps reads a second later or earlier than it did: the boot time it adds to was rounded the other way.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:02 2026 ' + command))).toBe(true)
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:00 2026 ' + command))).toBe(true)
    // Further from both what ps said then and Sotto's clock, and it is another process that took the PID.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:47:59 2026 ' + command))).toBe(false)
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:14 2026 ' + command))).toBe(false)
    // The command line still has to be OpenCode's server.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:01 2026 /usr/bin/python3 -m http.server'))).toBe(false)
  })
  it('knows its server by the record written at once, before ps answered, however far behind the clock ps reads', () => {
    // A crash while ps was still answering leaves the first record only. Linux's ps reads up to two seconds behind the
    // clock Sotto wrote down: 1.8 s on a machine measured for this, read here as the whole second before it.
    expect(isRecordedServer(record, parseProcessStart('Fri Oct 16 21:48:01 2026 ' + command))).toBe(true)
    // Further behind than ps ever reads, it is not the server's start.
    expect(isRecordedServer(record, parseProcessStart('Fri Oct 16 21:48:00 2026 ' + command))).toBe(false)
  })
  it('still knows its server after the clock steps forward, by Sotto’s clock', () => {
    // ps read 1.4 s behind Sotto's clock when the server was written down. Then the wall clock stepped 2 s forward, as
    // NTP or a WSL2 resync steps it, and what ps reads moved with it, since it adds ticks since boot to the wall clock's boot time.
    const written = { ...record, started: Date.parse('2026-10-16T21:48:02') }
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:04 2026 ' + command))).toBe(true)
    // Up to ten seconds after Sotto's clock said it started the server.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:13 2026 ' + command))).toBe(true)
    // A step past that leaves both rules behind, and the server is not ended.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:14 2026 ' + command))).toBe(false)
    // Either rule needs OpenCode's server on the command line.
    expect(isRecordedServer(written, parseProcessStart('Fri Oct 16 21:48:04 2026 /usr/bin/python3 -m http.server'))).toBe(false)
    expect(isRecordedServer(written, { started: Date.parse('2026-10-16T21:48:04') })).toBe(false)
  })
})

describe('the record of each server, while Sotto writes it and a sweep reads it', () => {
  const ledgerFolder = (): Promise<string> => mkdtemp(join(tmpdir(), 'sotto-opencode-ledger-'))
  it('loses no record while records are written and swept at once', { timeout: 60_000 }, async () => {
    const ledger = await ledgerFolder()
    try {
      // Records of this Sotto's servers, each written twice as a start writes it, while other connects sweep the folder.
      const pids = Array.from({ length: 40 }, (_, index) => 900_000 + index)
      let writing = true
      const writes = (async () => {
        try {
          for (let round = 0; round < 10; round++) {
            await Promise.all(pids.map(async pid => {
              await recordOpenCodeServer(ledger, { pid, startedAt: Date.now(), owner: process.pid })
              await recordOpenCodeServer(ledger, { pid, startedAt: Date.now(), started: Date.now() - 1_000, owner: process.pid })
            }))
          }
        } finally { writing = false }
      })()
      const sweeps = (async () => { while (writing) await Promise.all([endServersLeftBehind(ledger), endServersLeftBehind(ledger)]) })()
      await Promise.all([writes, sweeps])
      expect((await readdir(ledger)).sort()).toEqual(pids.map(pid => `${pid}.json`).sort())
    } finally { await rm(ledger, { recursive: true, force: true }) }
  })
  it('keeps a record it cannot read while it may still be being written, and clears one long left', async () => {
    const ledger = await ledgerFolder()
    try {
      // A Sotto that has gone: no process ever has this PID. Windows PIDs are multiples of four, Linux's stop at 2^22 and macOS's below 100,000.
      const owner = 2 ** 31 - 1
      await writeFile(join(ledger, '900101.json'), '{"pid":900101,"start')
      await writeFile(join(ledger, '900102.json'), '{"pid":900102,"start')
      const long = new Date(Date.now() - 60_000)
      await utimes(join(ledger, '900102.json'), long, long)
      // A write a Sotto that has gone never finished, and one this Sotto is still making.
      await writeFile(join(ledger, `900103.json.${owner}.1.tmp`), '{"pid":900103')
      await writeFile(join(ledger, `900104.json.${process.pid}.1.tmp`), '{"pid":900104')
      // Nothing runs at these PIDs. The real table is PowerShell's CIM query, which on a loaded Windows runner took the
      // whole 15 s test limit to answer (#1356, #1376); what this tests is the records, so the table is scripted.
      let tableReads = 0
      await endServersLeftBehind(ledger, undefined, () => { tableReads++; return Promise.resolve([]) })
      expect((await readdir(ledger)).sort()).toEqual(['900101.json', `900104.json.${process.pid}.1.tmp`])
      expect(tableReads).toBe(process.platform === 'win32' ? 1 : 0)
    } finally { await rm(ledger, { recursive: true, force: true }) }
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

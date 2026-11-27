// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseLsof, parseNetstat, parseProcesses, parseSs, startedFromSotto } from '../../../src/main/tools/localServers'

describe('local servers (ADR-0220)', () => {
  it('reads listening loopback and any-address sockets from netstat on Windows', () => {
    const text = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242',
      '  TCP    192.168.1.20:8080      0.0.0.0:0              LISTENING       77',
      '  TCP    127.0.0.1:5173         127.0.0.1:50001        ESTABLISHED     4242',
      '  TCP    [::1]:3000             [::]:0                 LISTENING       5151',
    ].join('\r\n')
    expect(parseNetstat(text)).toEqual([{ port: 135, pid: 1100 }, { port: 5173, pid: 4242 }, { port: 3000, pid: 5151 }])
  })

  it('reads lsof on macOS and ss on Linux', () => {
    expect(parseLsof('p4242\nn127.0.0.1:5173\nn*:5174\np99\nn10.0.0.2:22\n')).toEqual([{ port: 5173, pid: 4242 }, { port: 5174, pid: 4242 }])
    const ss = [
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 128 [::1]:3000 [::]:* users:(("node",pid=1235,fd=21))',
      'LISTEN 0 128 10.0.0.2:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
    ].join('\n')
    expect(parseSs(ss)).toEqual([{ port: 5173, pid: 1234 }, { port: 3000, pid: 1235 }])
  })

  it('reads the process table from ps or PowerShell', () => {
    const table = parseProcesses('  10     1 Sotto.exe\r\n  20    10 C:\\Windows\\System32\\cmd.exe\n  30    20 node\nnot a row\n')
    expect([...table.values()]).toEqual([{ pid: 10, parentPid: 1, name: 'Sotto.exe' }, { pid: 20, parentPid: 10, name: 'cmd.exe' }, { pid: 30, parentPid: 20, name: 'node' }])
  })

  it('counts a server started from Sotto, and never Sotto itself or a server started elsewhere', () => {
    const table = parseProcesses(['10 1 Sotto.exe', '11 10 Sotto.exe', '20 10 pwsh.exe', '30 20 node', '40 1 explorer.exe', '50 40 node', '60 60 loop'].join('\n'))
    expect(startedFromSotto(30, table, 10, 'sotto.exe')).toBe(true)
    expect(startedFromSotto(20, table, 10, 'Sotto.exe')).toBe(true)
    expect(startedFromSotto(10, table, 10, 'Sotto.exe')).toBe(false)
    expect(startedFromSotto(11, table, 10, 'Sotto.exe')).toBe(false)
    expect(startedFromSotto(50, table, 10, 'Sotto.exe')).toBe(false)
    expect(startedFromSotto(60, table, 10, 'Sotto.exe')).toBe(false)
    expect(startedFromSotto(999, table, 10, 'Sotto.exe')).toBe(false)
  })
})

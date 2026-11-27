// @vitest-environment node
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLsof, parseNetstat, parseProcesses, parseSs, probeLocalPage, probeTargets, startedFromSotto } from '../../../src/main/tools/localServers'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })
})
/** A web server on one loopback address only, answering each request as `answer` says; null where the address cannot be used. */
async function serve(host: '127.0.0.1' | '::1', answer: (response: ServerResponse) => void): Promise<number | null> {
  const server = createServer((_request, response) => answer(response))
  const port = await new Promise<number | null>(done => {
    server.once('error', () => done(null))
    server.listen(0, host, () => done((server.address() as AddressInfo).port))
  })
  if (port !== null) servers.push(server)
  return port
}

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
    expect(parseNetstat(text)).toEqual([{ port: 135, pid: 1100, address: '127.0.0.1' }, { port: 5173, pid: 4242, address: '127.0.0.1' }, { port: 3000, pid: 5151, address: '::1' }])
  })

  it('reads netstat in another language by the shape of its rows, not the word for listening', () => {
    const german = [
      'Aktive Verbindungen',
      '',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN         1100',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         4242',
      '  TCP    127.0.0.1:5173         127.0.0.1:50001        HERGESTELLT     4242',
      '  TCP    127.0.0.1:50001        127.0.0.1:5173         HERGESTELLT     4300',
      '  TCP    127.0.0.1:50002        127.0.0.1:5173         WARTEND         0',
      '  TCP    [::]:5174              [::]:0                 ABHÖREN         5150',
      '  TCP    [::1]:3000             [::]:0                 ABHÖREN         5151',
      '  TCP    [fe80::1%5]:139        [::]:0                 ABHÖREN         4',
    ].join('\r\n')
    expect(parseNetstat(german)).toEqual([
      { port: 135, pid: 1100, address: '127.0.0.1' }, { port: 5173, pid: 4242, address: '127.0.0.1' },
      { port: 5174, pid: 5150, address: '::1' }, { port: 3000, pid: 5151, address: '::1' },
    ])
    // The console's code page can garble the word, and a state may take two words: neither matters.
    const garbled = ['  TCP    127.0.0.1:5173         0.0.0.0:0              ABH\uFFFDREN         4242', '  TCP    [::1]:3000             [::]:0                 EN ÉCOUTE       5151'].join('\r\n')
    expect(parseNetstat(garbled)).toEqual([{ port: 5173, pid: 4242, address: '127.0.0.1' }, { port: 3000, pid: 5151, address: '::1' }])
  })

  it('reads lsof on macOS and ss on Linux', () => {
    expect(parseLsof('p4242\nn127.0.0.1:5173\nn*:5174\nn[::1]:5175\np99\nn10.0.0.2:22\n')).toEqual([
      { port: 5173, pid: 4242, address: '127.0.0.1' }, { port: 5174, pid: 4242, address: '127.0.0.1' }, { port: 5175, pid: 4242, address: '::1' },
    ])
    const ss = [
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 128 [::1]:3000 [::]:* users:(("node",pid=1235,fd=21))',
      'LISTEN 0 128 10.0.0.2:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
    ].join('\n')
    expect(parseSs(ss)).toEqual([{ port: 5173, pid: 1234, address: '127.0.0.1' }, { port: 3000, pid: 1235, address: '::1' }])
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

  it('reads when each process started from PowerShell, and leaves it out where Windows has none', () => {
    const table = parseProcesses(['10 4 134090000000000000 Sotto.exe', '4 0 0 System', '336 4 0 Secure System'].join('\r\n'), true)
    expect(table.get(10)).toEqual({ pid: 10, parentPid: 4, name: 'Sotto.exe', started: 134090000000000000 })
    expect(table.get(336)).toEqual({ pid: 336, parentPid: 4, name: 'Secure System' })
  })

  it('does not take a process for Sotto\'s child when Windows gave its exited parent\'s ID to Sotto', () => {
    // A test runner (20) started a server (30) and then Sotto; the runner's own parent (10) had exited, and Sotto got
    // its ID. Sotto started after both, so neither is its child. Its real child (40) still is.
    const table = parseProcesses(['10 1 300 Sotto.exe', '20 10 100 node.exe', '30 20 110 node.exe', '40 10 310 node.exe', '50 40 320 node.exe'].join('\n'), true)
    expect(startedFromSotto(30, table, 10, 'Sotto.exe')).toBe(false)
    expect(startedFromSotto(20, table, 10, 'Sotto.exe')).toBe(false)
    expect(startedFromSotto(40, table, 10, 'Sotto.exe')).toBe(true)
    expect(startedFromSotto(50, table, 10, 'Sotto.exe')).toBe(true)
  })

  it('asks a server that listens only on IPv6 at ::1, and a server on both at IPv4 first', () => {
    const table = parseProcesses(['10 1 Sotto.exe', '30 10 node', '31 10 node', '50 1 node'].join('\n'))
    const targets = probeTargets([
      { port: 5173, pid: 30, address: '::1' },
      { port: 3000, pid: 31, address: '::1' }, { port: 3000, pid: 31, address: '127.0.0.1' },
      // Another program on the same port at the other address is never asked.
      { port: 8080, pid: 50, address: '127.0.0.1' }, { port: 8080, pid: 30, address: '::1' },
    ], table, 10, 'Sotto.exe')
    expect([...targets]).toEqual([[5173, { pid: 30, addresses: ['::1'] }], [3000, { pid: 31, addresses: ['127.0.0.1', '::1'] }], [8080, { pid: 30, addresses: ['::1'] }]])
  })

  it('reads the title of a page served only on IPv6\'s loopback', async () => {
    const port = await serve('::1', response => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Vite app</title>') })
    // A machine without IPv6 has no ::1 to listen on.
    if (port === null) return
    expect(await probeLocalPage('::1', port, false)).toBe('Vite app')
    expect(await probeLocalPage('127.0.0.1', port, false)).toBeNull()
  })

  it('takes a content type in any case, and nothing that is not a web page', async () => {
    const page = await serve('127.0.0.1', response => { response.writeHead(200, { 'Content-Type': 'Text/HTML; Charset=UTF-8' }); response.end('<title>Shouting server</title>') })
    const json = await serve('127.0.0.1', response => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"title":"no"}') })
    expect(await probeLocalPage('127.0.0.1', page!, false)).toBe('Shouting server')
    expect(await probeLocalPage('127.0.0.1', json!, false)).toBeNull()
  })

  it('gives up on a page that never finishes at its deadline, once, and closes the request', async () => {
    let closed = false
    const port = await serve('127.0.0.1', response => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<p>still going')
      response.on('close', () => { closed = true })
    })
    expect(await probeLocalPage('127.0.0.1', port!, false, 100)).toBeNull()
    await expect.poll(() => closed).toBe(true)
  })
})

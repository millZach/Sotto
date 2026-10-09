// @vitest-environment node
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { createOwnedProofProcesses } from '../../scripts/owned-proof-processes.mjs'
import { fetchProofJson, openProofDebugger } from '../../scripts/proof-debugger.mjs'

async function fakeDebugger(mode, check) {
  const sockets = new Set()
  const server = createServer(() => { /* Deliberately drop HTTP replies. */ })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (request, socket) => {
    if (mode === 'connect-timeout') return
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.once('data', () => {
      if (mode === 'close') socket.end(Buffer.from([0x88, 0]))
      if (mode === 'error') socket.destroy()
      if (mode === 'reply') {
        const json = Buffer.from(JSON.stringify({ id: 1, result: { result: { value: 42 } } }))
        socket.write(Buffer.concat([Buffer.from([0x81, json.length]), json]))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  try { await check(`127.0.0.1:${address.port}`) } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

describe('proof debugger deadlines and disconnects', () => {
  it('bounds HTTP discovery', async () => {
    await fakeDebugger('drop', address => expect(fetchProofJson(`http://${address}/json/list`, 100)).rejects.toThrow())
  })
  it('bounds an unanswered WebSocket connection', async () => {
    await fakeDebugger('connect-timeout', address => expect(openProofDebugger(`ws://${address}`, 100)).rejects.toThrow('connection deadline'))
  })
  it.each(['drop', 'close', 'error'])('rejects an evaluation on %s and closes its socket', async mode => {
    await fakeDebugger(mode, async address => {
      const debuggerClient = await openProofDebugger(`ws://${address}`)
      try { await expect(debuggerClient.evaluate('42', 100)).rejects.toThrow(/deadline|closed|error/u) }
      finally { debuggerClient.close() }
    })
  })
  it('returns a matching reply', async () => {
    await fakeDebugger('reply', async address => {
      const debuggerClient = await openProofDebugger(`ws://${address}`)
      try { await expect(debuggerClient.evaluate('42')).resolves.toBe(42) }
      finally { debuggerClient.close() }
    })
  })
})

describe.skipIf(process.platform !== 'linux')('proof process ownership', () => {
  it('stops a reparented owned child without stopping an unrelated process', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    const owned = createOwnedProofProcesses(() => undefined)
    try {
      const childCode = 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'
      const parentCode = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); c.once("message", () => { console.log(c.pid); c.disconnect(); c.unref() })`
      const parent = owned.start('forking fixture', process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let errors = ''
      parent.stderr.on('data', chunk => { errors += chunk.toString() })
      parent.stdout.on('data', chunk => { output += chunk.toString() })
      await once(parent, 'close')
      expect(parent.exitCode, errors).toBe(0)
      const pid = Number(output.trim())
      expect(pid).toBeGreaterThan(0)
      expect(() => process.kill(pid, 0)).not.toThrow()
      await owned.stop()
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
    } finally {
      await owned.stop()
      const exited = once(unrelated, 'exit')
      process.kill(-unrelated.pid, 'SIGKILL')
      await exited
    }
  })
})

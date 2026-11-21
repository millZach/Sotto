// @vitest-environment node
// Cross-language parity test (ADR-0212): seeds a data folder using Sotto's TypeScript stores and pairing,
// then launches the compiled Rust `sotto-host` binary against that folder and speaks protocol v1 + RFC 7692
// `permessage-deflate` using Sotto's real `SocketFrames`.
// Runs when `SOTTO_TEST_RUST_HOST=1` (enabled in the Rust host CI job and locally after `cargo build`).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOST_LOCK_HELD_EXIT_CODE } from '../../src/host/lock'
import { DEFLATE_OFFER, deflateAccepted, SocketFrames } from '../../src/host/socketFrames'
import { loadHostIdentity } from '../../src/main/agents/hostIdentity'
import { PairedClients } from '../../src/main/agents/pairing'
import { SubagentStore } from '../../src/main/agents/subagentStore'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { migrateDatabase } from '../../src/main/memory/migrations.mjs'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const BIN_NAME = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'

function locateRustHostBinary(): string {
  const targetDir = process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : resolve('target')
  const candidate = join(targetDir, 'debug', BIN_NAME)
  if (!existsSync(candidate)) {
    execFileSync('cargo', ['build', '-p', 'sotto-host', '--bin', 'sotto-host'], { stdio: 'inherit' })
  }
  return candidate
}

async function waitForFile<T>(filePath: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = await readFile(filePath, 'utf8')
      return JSON.parse(text) as T
    } catch {
      await new Promise(r => setTimeout(r, 50))
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function openWebSocket(port: number, session: string): Promise<{ frames: SocketFrames; messages: string[]; close: () => void }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const key = randomBytes(16).toString('base64')
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/socket',
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Authorization: `Bearer ${session}`,
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Extensions': DEFLATE_OFFER,
      },
    })
    req.on('error', rejectPromise)
    req.on('upgrade', (res, socket) => {
      expect(res.statusCode).toBe(101)
      const deflate = deflateAccepted(res.headers['sec-websocket-extensions'])
      expect(deflate).toBe(true)
      const messages: string[] = []
      const frames = new SocketFrames(socket, true, text => { messages.push(text) }, { deflate: true })
      resolvePromise({ frames, messages, close: () => { frames.close(); socket.destroy() } })
    })
    req.end()
  })
}

async function waitForReply(messages: string[], id: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const raw of messages) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.id === id) return parsed
    }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for WebSocket reply ${id}`)
}

describe.skipIf(!RUN_RUST_HOST)('Rust sotto-host foundation parity with TypeScript stores', () => {
  let dir: string
  let hostBinary: string
  let child: ChildProcess | undefined

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-host-'))
    hostBinary = locateRustHostBinary()
  }, 180_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise(r => child?.once('exit', r))
    }
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('reuses TS host identity, verifies TS pairing token, reads TS SQLite stores over permessage-deflate WS, and enforces lock exit 75', async () => {
    // 1. Seed the folder with Sotto's real TypeScript stores and pairing.
    const tsHostId = await loadHostIdentity(dir)
    const tsPairing = new PairedClients(dir)
    await tsPairing.load()
    const { code } = tsPairing.issuePairingCode()
    const { token: tsToken } = await tsPairing.redeem(code, 'TypeScript Desktop')

    const tsThreadStore = new ThreadStore(join(dir, 'threads.sqlite'), undefined, null)
    tsThreadStore.open({ onMain: true })
    const longBody = 'Rust reads TypeScript SQLite cleanly. '.repeat(60)
    tsThreadStore.append('thread-alpha', {
      kind: 'message-added',
      at: '2026-11-20T12:00:00.000Z',
      message: {
        id: 'msg-1',
        role: 'user',
        text: longBody,
        createdAt: '2026-11-20T12:00:00.000Z',
      },
    })
    tsThreadStore.close()

    const tsSubagents = new SubagentStore(join(dir, 'subagents.sqlite'))
    tsSubagents.open()
    tsSubagents.close()

    const memDb = new DatabaseSync(join(dir, 'memory.sqlite'))
    migrateDatabase(memDb)
    memDb.close()

    // 2. Spawn the real compiled Rust sotto-host binary on the same folder.
    child = spawn(hostBinary, ['--data', dir, '--port', '0'], { stdio: 'pipe' })
    const descriptor = await waitForFile<{ v: number; hostId: string; port: number; pid: number; adminToken: string }>(
      join(dir, 'host-listener.json'),
    )
    expect(descriptor.v).toBe(1)
    expect(descriptor.hostId).toBe(tsHostId)
    expect(descriptor.port).toBeGreaterThan(0)

    // 3. Health + session using the token TypeScript created!
    const healthRes = await fetch(`http://127.0.0.1:${descriptor.port}/v1/health`)
    expect(healthRes.status).toBe(200)
    const health = await healthRes.json() as { hostId: string; runtime: string; status: string }
    expect(health.hostId).toBe(tsHostId)
    expect(health.runtime).toBe('rust')
    expect(health.status).toBe('ready')

    const sessionRes = await fetch(`http://127.0.0.1:${descriptor.port}/v1/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tsToken}` },
    })
    expect(sessionRes.status).toBe(200)
    const { session } = await sessionRes.json() as { session: string }

    // 4. WebSocket with RFC 7692 permessage-deflate via Sotto's real SocketFrames!
    const ws = await openWebSocket(descriptor.port, session)
    try {
      ws.frames.send({ v: 1, id: 'r1', op: 'hello' })
      const hello = await waitForReply(ws.messages, 'r1')
      expect(hello.ok).toBe(true)
      const helloResult = hello.result as {
        hostId: string
        runtime: string
        threadIds: string[]
        stores: { memorySchemaVersion: number; subagentsOk: boolean }
      }
      expect(helloResult.hostId).toBe(tsHostId)
      expect(helloResult.runtime).toBe('rust')
      expect(helloResult.threadIds).toContain('thread-alpha')
      expect(helloResult.stores.memorySchemaVersion).toBe(4)
      expect(helloResult.stores.subagentsOk).toBe(true)

      // Detail response exceeds DEFLATE_MIN_BYTES (1024 B), exercising live Rust->Node deflate interop!
      ws.frames.send({ v: 1, id: 'r2', op: 'detail', threadId: 'thread-alpha' })
      const detail = await waitForReply(ws.messages, 'r2')
      expect(detail.ok).toBe(true)
      const detailResult = detail.result as { messages: Array<{ id: string; text: string }> }
      expect(detailResult.messages).toHaveLength(1)
      expect(detailResult.messages[0]!.id).toBe('msg-1')
      expect(detailResult.messages[0]!.text).toBe(longBody)

      ws.frames.send({ v: 1, id: 'r3', op: 'events', threadId: 'thread-alpha', afterSeq: 0 })
      const events = await waitForReply(ws.messages, 'r3')
      expect(events.ok).toBe(true)
      expect((events.result as { events: unknown[] }).events).toHaveLength(1)
    } finally {
      ws.close()
    }

    // 5. Second Rust host on the same folder exits with HOST_LOCK_HELD_EXIT_CODE (75).
    const second = spawn(hostBinary, ['--data', dir, '--port', '0'], { stdio: 'pipe' })
    const secondCode = await new Promise<number | null>(resolveCode => { second.once('exit', resolveCode) })
    expect(secondCode).toBe(HOST_LOCK_HELD_EXIT_CODE)
  }, 30_000)
})

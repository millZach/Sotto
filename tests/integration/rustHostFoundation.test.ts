// @vitest-environment node
// Cross-language parity test (ADR-0214): verifies two-way on-disk and wire parity between
// TypeScript Sotto and the compiled Rust `sotto-host` binary (SQLite stores, pairing,
// SOTTO1 credentials, protocol v1 HTTP + RFC 7692 permessage-deflate WS, and referee startup).
// Runs when `SOTTO_TEST_RUST_HOST=1` (enabled in the Rust host CI job and locally after `cargo build`).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { HOST_LOCK_HELD_EXIT_CODE } from '../../src/host/lock'
import { DEFLATE_OFFER, deflateAccepted, SocketFrames } from '../../src/host/socketFrames'
import { loadHostIdentity } from '../../src/main/agents/hostIdentity'
import { PairedClients } from '../../src/main/agents/pairing'
import { SubagentStore } from '../../src/main/agents/subagentStore'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { migrateDatabase } from '../../src/main/memory/migrations.mjs'
import { PolicyStore } from '../../src/main/memory/policies'
import { MemoryStore } from '../../src/main/memory/store'
import { DESKTOP_DEFLATE_OFFER, openSocket, pairClient, startHost } from '../referee/wire'

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
  let freshDir: string
  let hostBinary: string
  let child: ChildProcess | undefined

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-host-'))
    freshDir = await mkdtemp(join(tmpdir(), 'sotto-rust-fresh-'))
    hostBinary = locateRustHostBinary()
  }, 180_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise(r => child?.once('exit', r))
    }
    if (dir) await rm(dir, { recursive: true, force: true })
    if (freshDir) await rm(freshDir, { recursive: true, force: true })
  })

  it('reuses TS identity, pairing, SOTTO1 credentials, and SQLite stores over permessage-deflate WS, and enforces lock exit 75', async () => {
    // 1. Seed the folder with Sotto's real TypeScript stores, pairing, and encrypted credentials.
    const tsHostId = await loadHostIdentity(dir)
    const tsPairing = new PairedClients(dir)
    await tsPairing.load()
    const { code } = tsPairing.issuePairingCode()
    const { token: tsToken } = await tsPairing.redeem(code, 'TypeScript Desktop')

    const keySecret = 'sotto-cross-language-key-0123456789'
    const keyFile = join(dir, 'host.key')
    const wrongKeyFile = join(dir, 'wrong.key')
    await writeFile(keyFile, `${keySecret}\n`, 'utf8')
    await writeFile(wrongKeyFile, 'wrong-cross-language-key-9876543210\n', 'utf8')
    const tsEncryption = new HostCredentialEncryption(keySecret)
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ formatting: tsEncryption.encryptString('sk-parity-secret').toString('base64') }),
      'utf8',
    )

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

    // 1b. Wrong key file must fail closed on startup rather than silently wiping credentials.
    const badKeyProc = spawn(hostBinary, ['--data', dir, '--port', '0', '--key-file', wrongKeyFile], { stdio: 'pipe' })
    const badKeyCode = await new Promise<number | null>(resolveCode => { badKeyProc.once('exit', resolveCode) })
    expect(badKeyCode).toBe(1)

    // 2. Spawn the real compiled Rust sotto-host binary on the same folder with the matching key file.
    child = spawn(hostBinary, ['--data', dir, '--port', '0', '--key-file', keyFile], { stdio: 'pipe' })
    const descriptor = await waitForFile<{ v: number; hostId: string; port: number; pid: number; adminToken: string; sottoVersion: string }>(
      join(dir, 'host-listener.json'),
    )
    expect(descriptor.v).toBe(1)
    expect(descriptor.hostId).toBe(tsHostId)
    expect(descriptor.port).toBeGreaterThan(0)
    expect(descriptor.sottoVersion).toBeTruthy()

    // 3. Health + session using the token TypeScript created!
    const healthRes = await fetch(`http://127.0.0.1:${descriptor.port}/v1/health`)
    expect(healthRes.status).toBe(200)
    const health = await healthRes.json() as { hostId: string; sottoVersion: string; status: string; features: string[]; adminToken?: unknown }
    expect(health.hostId).toBe(tsHostId)
    expect(health.sottoVersion).toBe(descriptor.sottoVersion)
    expect(health.status).toBe('ready')
    expect(Array.isArray(health.features)).toBe(true)
    expect(health.adminToken).toBeUndefined()

    const sessionRes = await fetch(`http://127.0.0.1:${descriptor.port}/v1/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tsToken}` },
    })
    expect(sessionRes.status).toBe(200)
    const { session, clientId } = await sessionRes.json() as { session: string; clientId: string }
    expect(clientId).toBeTruthy()

    // 4. WebSocket with RFC 7692 permessage-deflate via Sotto's real SocketFrames!
    const ws = await openWebSocket(descriptor.port, session)
    try {
      ws.frames.send({ v: 1, id: 'r1', op: 'hello' })
      const hello = await waitForReply(ws.messages, 'r1')
      expect(hello.ok).toBe(true)
      const helloResult = hello.result as {
        hostId: string
        clientId: string
        threadIds: string[]
        capabilities: { mayAnswer: boolean }
        stores: { memorySchemaVersion: number; subagentsOk: boolean; credentialsSecure: boolean }
      }
      expect(helloResult.hostId).toBe(tsHostId)
      expect(helloResult.clientId).toBe(clientId)
      expect(helloResult.capabilities.mayAnswer).toBe(false)
      expect(helloResult.threadIds).toContain('thread-alpha')
      expect(helloResult.stores.memorySchemaVersion).toBe(4)
      expect(helloResult.stores.subagentsOk).toBe(true)
      expect(helloResult.stores.credentialsSecure).toBe(true)

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
    const second = spawn(hostBinary, ['--data', dir, '--port', '0', '--key-file', keyFile], { stdio: 'pipe' })
    const secondCode = await new Promise<number | null>(resolveCode => { second.once('exit', resolveCode) })
    expect(secondCode).toBe(HOST_LOCK_HELD_EXIT_CODE)
  }, 30_000)

  it('starts via the referee wire harness, grants remote-answer policies readable by TS PolicyStore, and initializes TS-compatible SQLite databases', async () => {
    const running = await startHost(
      [hostBinary, '--data', '{data}', '--port', '0', '--sotto-version', '0.1.44-owl.20261118.2'],
      freshDir,
      'codex',
    )
    let pairedClientId: string
    try {
      const paired = await pairClient(running.port, freshDir, 'Referee Desktop')
      pairedClientId = paired.clientId
      const socket = await openSocket(running.port, paired.session, DESKTOP_DEFLATE_OFFER)
      try {
        socket.send({ v: 1, id: 'h1', op: 'hello', session: paired.session })
        const reply = await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => rejectPromise(new Error('Timed out waiting for hello')), 5_000)
          const check = (): void => {
            const hit = socket.crossings.find(c => c.dir === 'in' && c.frame.id === 'h1')
            if (hit) { clearTimeout(timer); off(); resolvePromise(hit.frame) }
          }
          const off = socket.onArrival(check)
          check()
        })
        expect(reply.ok).toBe(true)
        const result = reply.result as { clientId: string; capabilities: { mayAnswer: boolean }; sottoVersion: string }
        expect(result.clientId).toBe(pairedClientId)
        expect(result.capabilities.mayAnswer).toBe(true)
        expect(result.sottoVersion).toBe('0.1.44-owl.20261118.2')
      } finally {
        socket.close()
      }
    } finally {
      await running.stop()
    }

    // TypeScript's real MemoryStore + PolicyStore and ThreadStore open the Rust-created databases in place!
    const tsMemory = new MemoryStore(join(freshDir, 'memory.sqlite'))
    tsMemory.open()
    try {
      const tsPolicy = new PolicyStore(tsMemory)
      const verdict = tsPolicy.mayGrant({ clientId: pairedClientId, user: 'Referee Desktop', transport: 'socket' })
      expect(verdict.allowed).toBe(true)
      expect(verdict.reason).toBe('paired-client')
    } finally {
      tsMemory.close()
    }

    const tsThreads = new ThreadStore(join(freshDir, 'threads.sqlite'), undefined, null)
    tsThreads.open({ onMain: true })
    try {
      expect(tsThreads.latestSeq()).toBe(0)
    } finally {
      tsThreads.close()
    }
  }, 30_000)
})

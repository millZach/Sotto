// @vitest-environment node
// Cross-language parity test (ADR-0214): verifies two-way on-disk and wire parity between
// TypeScript Sotto and the compiled Rust `sotto-host` binary (SQLite stores, pairing,
// SOTTO1 credentials, protocol v1 HTTP + RFC 7692 permessage-deflate WS, and referee startup).
// Runs when `SOTTO_TEST_RUST_HOST=1` (enabled in the Rust host CI job and locally after `cargo build`).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { ThreadRegistry } from '../../src/main/agents/threads'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { UsageStore } from '../../src/main/agents/usageStore'
import { migrateDatabase } from '../../src/main/memory/migrations.mjs'
import { PolicyStore } from '../../src/main/memory/policies'
import { MemoryStore } from '../../src/main/memory/store'
import { agentAttachmentHandleSchema } from '../../src/shared/agents'
import { fileListingSchema, filePreviewSchema } from '../../src/shared/files'
import { gitChangedFilesSchema } from '../../src/shared/gitChangedFiles'
import { gitListingSchema, gitReviewSchema } from '../../src/shared/gitChanges'
import { gitRefsPageSchema } from '../../src/shared/gitRefs'
import { hostMachineReportSchema } from '../../src/shared/hostFacts'
import { hostFoldersResultSchema } from '../../src/shared/hostFolders'
import { protocolAgentStateSchema } from '../../src/shared/hostProtocol'
import { subagentAssignmentsPageSchema, subagentPageSchema } from '../../src/shared/subagents'
import { agentThreadWordsSchema } from '../../src/shared/threadWords'
import { toolsResultSchema } from '../../src/shared/tools'
import { usageLocalClearResultSchema, usageLocalHostReadSchema } from '../../src/shared/usageDashboard'
import { ClientFold } from '../referee/fold'
import { PROFILES } from '../referee/scenario'
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
    expect(health.features).not.toContain('answer-receipts')
    expect(health.features).not.toContain('provider-deepseek')
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
        capabilities: { mayAnswer: boolean }
        shell: { host: { hostId: string } }
        stores: { memorySchemaVersion: number; subagentsOk: boolean; credentialsSecure: boolean }
      }
      expect(helloResult.hostId).toBe(tsHostId)
      expect(helloResult.clientId).toBe(clientId)
      expect(helloResult.capabilities.mayAnswer).toBe(false)
      expect(helloResult.shell.host.hostId).toBe(tsHostId)
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
        socket.send({
          v: 1,
          id: 'h1',
          op: 'hello',
          session: paired.session,
          accepts: ['provider-deepseek', 'provider-hermes'],
        })
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
        const result = reply.result as {
          clientId: string
          capabilities: { mayAnswer: boolean }
          sottoVersion: string
          shell: { host: { providers: Array<{ id: string }> } }
        }
        expect(result.clientId).toBe(pairedClientId)
        expect(result.capabilities.mayAnswer).toBe(true)
        expect(result.sottoVersion).toBe('0.1.44-owl.20261118.2')
        const providerIds = result.shell.host.providers.map(p => p.id)
        expect(providerIds).not.toContain('deepseek')
        expect(providerIds).toContain('hermes')
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

  it('drives desktop, iphone, and plain clients through ClientFold with zero protocol violations', async () => {
    const foldDir = await mkdtemp(join(tmpdir(), 'sotto-rust-fold-'))
    const running = await startHost(
      [hostBinary, '--data', '{data}', '--port', '0', '--sotto-version', '0.1.44-owl.20261118.2', '--mock-provider', 'codex'],
      foldDir,
      'codex',
    )
    try {
      const desktopPair = await pairClient(running.port, foldDir, 'Referee desktop')
      const iphonePair = await pairClient(running.port, foldDir, 'Referee iphone')
      const plainPair = await pairClient(running.port, foldDir, 'Referee plain')

      const desktopSock = await openSocket(running.port, desktopPair.session, PROFILES.desktop.offer)
      const iphoneSock = await openSocket(running.port, iphonePair.session, PROFILES.iphone.offer)
      const plainSock = await openSocket(running.port, plainPair.session, PROFILES.plain.offer)

      const folds = {
        desktop: new ClientFold(),
        iphone: new ClientFold(),
        plain: new ClientFold(),
      }
      const processed = { desktop: 0, iphone: 0, plain: 0 }
      const drain = (name: 'desktop' | 'iphone' | 'plain', sock: typeof desktopSock): void => {
        while (processed[name] < sock.crossings.length) {
          const item = sock.crossings[processed[name]++]!
          if (item.dir === 'in' && typeof item.frame.event === 'string') {
            folds[name].push(item.frame)
          }
        }
      }
      desktopSock.onArrival(() => drain('desktop', desktopSock))
      iphoneSock.onArrival(() => drain('iphone', iphoneSock))
      plainSock.onArrival(() => drain('plain', plainSock))

      const rpc = async (
        name: 'desktop' | 'iphone' | 'plain',
        sock: typeof desktopSock,
        session: string,
        id: string,
        body: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        sock.send({ v: 1, id, session, ...body })
        return await new Promise((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => rejectPromise(new Error(`Timed out waiting for ${id}`)), 5_000)
          const check = (): void => {
            drain(name, sock)
            const hit = sock.crossings.find(c => c.dir === 'in' && c.frame.id === id)
            if (hit) { clearTimeout(timer); off(); resolvePromise(hit.frame) }
          }
          const off = sock.onArrival(check)
          check()
        })
      }

      try {
        // 1. All three clients say hello with their real referee profiles.
        const hDesktop = await rpc('desktop', desktopSock, desktopPair.session, 'd1', { op: 'hello', ...PROFILES.desktop.hello })
        expect(hDesktop.ok).toBe(true)
        folds.desktop.hello(hDesktop.result)

        const hIphone = await rpc('iphone', iphoneSock, iphonePair.session, 'i1', { op: 'hello', ...PROFILES.iphone.hello })
        expect(hIphone.ok).toBe(true)
        folds.iphone.hello(hIphone.result)

        const hPlain = await rpc('plain', plainSock, plainPair.session, 'p1', { op: 'hello', ...PROFILES.plain.hello })
        expect(hPlain.ok).toBe(true)
        folds.plain.hello(hPlain.result)

        // 2. Desktop creates a project and a thread.
        const projReply = await rpc('desktop', desktopSock, desktopPair.session, 'd2', {
          op: 'command',
          command: { type: 'create-project', provider: 'codex', title: 'Referee project', path: foldDir, useExisting: true },
        })
        expect(projReply.ok).toBe(true)
        const projShell = folds.desktop.commandAnswer(projReply.result) as { host: { projects: Array<{ id: string }> } }
        const projectId = projShell.host.projects[0]!.id

        const threadId = '00000000-0000-4000-8000-00000000000a'
        const threadReply = await rpc('desktop', desktopSock, desktopPair.session, 'd3', {
          op: 'command',
          command: {
            type: 'create-thread',
            threadId,
            projectId,
            title: 'Referee thread',
            titleSource: 'user',
            modelId: 'native:codex:model:fixture-model',
            workingCopy: 'shared',
            managed: false,
          },
        })
        expect(threadReply.ok).toBe(true)
        folds.desktop.commandAnswer(threadReply.result)

        // 3. All three clients observe the thread; detail MUST be pushed before observe answers!
        for (const [name, sock, sess, id] of [
          ['desktop', desktopSock, desktopPair.session, 'd4'],
          ['iphone', iphoneSock, iphonePair.session, 'i2'],
          ['plain', plainSock, plainPair.session, 'p2'],
        ] as const) {
          folds[name].observing([threadId])
          const obsReply = await rpc(name, sock, sess, id, { op: 'observe', threadIds: [threadId] })
          expect(obsReply.ok).toBe(true)
          const detailIdx = sock.crossings.findIndex(c => c.dir === 'in' && c.frame.event === 'detail' && c.frame.threadId === threadId)
          const answerIdx = sock.crossings.findIndex(c => c.dir === 'in' && c.frame.id === id)
          expect(detailIdx).toBeGreaterThanOrEqual(0)
          expect(detailIdx).toBeLessThan(answerIdx)
        }

        // 4. Desktop sends a prompt and interrupts the turn; wait for coalesced pushes to reach all 3 clients.
        const sendReply = await rpc('desktop', desktopSock, desktopPair.session, 'd5', {
          op: 'command',
          command: { type: 'manual-send', threadId, text: 'Referee prompt one' },
        })
        expect(sendReply.ok).toBe(true)
        folds.desktop.commandAnswer(sendReply.result)

        const stopReply = await rpc('desktop', desktopSock, desktopPair.session, 'd6', {
          op: 'command',
          command: { type: 'interrupt', threadId },
        })
        expect(stopReply.ok).toBe(true)
        folds.desktop.commandAnswer(stopReply.result)

        await new Promise(r => setTimeout(r, 150))
        drain('desktop', desktopSock)
        drain('iphone', iphoneSock)
        drain('plain', plainSock)

        // 5. Unknown op and disallowed extra command field return invalid_request.
        const badOp = await rpc('desktop', desktopSock, desktopPair.session, 'd7', { op: 'referee-no-such-operation' })
        expect(badOp.ok).toBe(false)
        expect((badOp.error as { code: string }).code).toBe('invalid_request')

        const badField = await rpc('iphone', iphoneSock, iphonePair.session, 'i3', {
          op: 'command',
          command: { type: 'interrupt', threadId, refereeField: true },
        })
        expect(badField.ok).toBe(false)
        expect((badField.error as { code: string }).code).toBe('invalid_request')

        // 6. Verify zero protocol violations across all 3 ClientFold instances and exact converged state!
        expect(folds.desktop.problems).toEqual([])
        expect(folds.iphone.problems).toEqual([])
        expect(folds.plain.problems).toEqual([])
        expect((folds.desktop.held.details[threadId]?.messages as Array<{ text: string }>)?.[0]?.text).toBe('Referee prompt one')
        expect((folds.iphone.held.details[threadId]?.messages as Array<{ text: string }>)?.[0]?.text).toBe('Referee prompt one')
        expect((folds.plain.held.details[threadId]?.messages as Array<{ text: string }>)?.[0]?.text).toBe('Referee prompt one')
      } finally {
        desktopSock.close()
        iphoneSock.close()
        plainSock.close()
      }
    } finally {
      await running.stop()
      await rm(foldDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('validates shells, ThreadRegistry, attachment handles, v1 remote ops, detail-read-held, and security containment against TS schemas', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-v1-contract-'))
    const projectDir = join(dataDir, 'project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'readme.md'), '# Contract test\nhello world\n', 'utf8')
    await writeFile(join(projectDir, 'oversized.txt'), Buffer.alloc(512 * 1024 + 32, 0x61))

    const threadId = '00000000-0000-4000-8000-0000000000c1'
    // Seed real TypeScript `SubagentStore` and `UsageStore` databases before starting Rust `sotto-host`
    // so we prove real cross-language SQLite reads, rollups, pagination, and transactional clear parity.
    const seedSubagents = new SubagentStore(join(dataDir, 'subagents.sqlite'))
    seedSubagents.open()
    seedSubagents.ingest(threadId, [
      {
        id: 'agent-1',
        assignmentId: 'asgn-1',
        title: 'Inspect Rust store',
        description: 'Verify subagent page rows',
        prompt: 'Check subagents.sqlite parity',
        message: 'Parity verified',
        status: 'completed',
        model: 'claude-opus-4-6',
        observedAt: '2026-11-22T10:00:00.000Z',
        startedAt: '2026-11-22T09:59:00.000Z',
        completedAt: '2026-11-22T10:00:00.000Z',
        durationMs: 60_000,
      },
    ])
    seedSubagents.close()

    const seedUsage = new UsageStore(join(dataDir, 'usage.sqlite'))
    seedUsage.open()
    const recordHash = createHash('sha256').update('rust-usage-parity-1').digest('hex')
    seedUsage.observeTokens({
      providerId: 'codex',
      threadId,
      recordKey: recordHash,
      modelId: 'native:codex:model:gpt-5.2-2026-01-15',
      tokens: { input: 420, output: 80, cached: 100 },
      at: '2026-11-22T12:15:00.000Z',
      phase: 'live',
      partial: false,
    })
    seedUsage.submitPrompt({
      providerId: 'codex',
      threadId,
      messageId: 'prompt-msg-1',
      modelId: 'native:codex:model:gpt-5.2-2026-01-15',
      at: '2026-11-22T12:14:00.000Z',
      kind: 'user',
      inputKind: 'send',
    })
    seedUsage.acceptSubmittedPrompt(threadId, 'prompt-msg-1')
    const seededUsageRevision = seedUsage.metadata().revision
    seedUsage.close()

    const running = await startHost(
      [hostBinary, '--data', '{data}', '--port', '0', '--sotto-version', '0.1.44-owl.20261118.2', '--mock-provider', 'codex'],
      dataDir,
      'codex',
    )
    try {
      const pair = await pairClient(running.port, dataDir, 'Contract Desktop')
      const sock = await openSocket(running.port, pair.session, PROFILES.desktop.offer)
      let seq = 0
      const rpc = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const id = `c-${++seq}`
        sock.send({ v: 1, id, session: pair.session, ...payload })
        return await new Promise((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => rejectPromise(new Error(`Timeout waiting for ${id} (${String(payload.op)})`)), 5_000)
          const check = (): void => {
            const hit = sock.crossings.find(c => c.dir === 'in' && c.frame.id === id)
            if (hit) { clearTimeout(timer); off(); resolvePromise(hit.frame) }
          }
          const off = sock.onArrival(check)
          check()
        })
      }

      try {
        // 1. Hello shell must satisfy TS `protocolAgentStateSchema`.
        const baseAccepts = (PROFILES.desktop.hello.accepts as readonly string[] | undefined) ?? []
        const hello = await rpc({ op: 'hello', accepts: [...baseAccepts, 'detail-read-held'] })
        expect(hello.ok).toBe(true)
        const helloShell = (hello.result as { shell: unknown }).shell
        const parsedHello = protocolAgentStateSchema.parse(helloShell)
        expect(parsedHello.notice).toBe('')
        expect(parsedHello.host.version.length).toBeGreaterThan(0)

        // 2. Create project + thread and verify command shell passes `protocolAgentStateSchema`
        // (re-attaching cached `models` when `model-catalog-revision` elides an unchanged catalog, as `SocketHostService` does).
        const withCachedModels = (raw: unknown): unknown => {
          const obj = raw as { host?: { models?: unknown; modelsRevision?: number } }
          if (obj.host && obj.host.models === undefined && obj.host.modelsRevision === parsedHello.host.modelsRevision) {
            return { ...obj, host: { ...obj.host, models: parsedHello.host.models } }
          }
          return raw
        }
        const createProj = await rpc({
          op: 'command',
          command: { type: 'create-project', provider: 'codex', title: 'Contract Project', path: projectDir, useExisting: true },
        })
        expect(createProj.ok).toBe(true)
        const afterProj = protocolAgentStateSchema.parse(withCachedModels(createProj.result))
        const projectId = afterProj.host.projects.find(p => p.path === projectDir)!.id

        const createThread = await rpc({
          op: 'command',
          command: {
            type: 'create-thread',
            threadId,
            projectId,
            title: 'Contract Thread',
            titleSource: 'user',
            modelId: 'native:codex:model:fixture-model',
            workingCopy: 'shared',
            managed: false,
          },
        })
        expect(createThread.ok).toBe(true)
        const afterThread = protocolAgentStateSchema.parse(withCachedModels(createThread.result))
        expect(afterThread.host.threads[0]?.worktree?.status).toBe('ready')

        // 3. Direct `detail` read before `observe` honors `detail-read-held` (no redundant whole detail push).
        const preRead = await rpc({ op: 'detail', threadId })
        expect(preRead.ok).toBe(true)
        const crossingsBeforeObs = sock.crossings.length
        const obs = await rpc({ op: 'observe', threadIds: [threadId] })
        expect(obs.ok).toBe(true)
        const redundantWhole = sock.crossings
          .slice(crossingsBeforeObs)
          .some(c => c.dir === 'in' && c.frame.event === 'detail' && c.frame.threadId === threadId)
        expect(redundantWhole).toBe(false)

        // 4. Attachment handle schema + oversized upload rejection (must NOT crash coordinator!).
        const pixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        const imgStage = await rpc({ op: 'stage-attachment', image: { name: 'dot.png', mimeType: 'image/png', data: pixelPng } })
        expect(imgStage.ok).toBe(true)
        const imgHandle = agentAttachmentHandleSchema.parse(imgStage.result)

        const contentRes = await rpc({ op: 'attachment-content', digest: imgHandle.digest })
        expect(contentRes.ok).toBe(true)
        expect((contentRes.result as { mimeType: string; data: string }).data).toBe(pixelPng)

        const hugeUpload = await rpc({
          op: 'stage-file-part',
          part: {
            uploadId: '00000000-0000-4000-8000-0000000000f9',
            index: 0,
            count: 1,
            name: 'bomb.txt',
            mimeType: 'text/plain',
            sizeBytes: Number.MAX_SAFE_INTEGER,
            digest: createHash('sha256').update('x').digest('hex'),
            data: Buffer.from('x').toString('base64'),
          },
        })
        expect(hugeUpload.ok).toBe(false)

        // 5. Security containment & exact v1 op contracts.
        const listRes = await rpc({ op: 'thread-files', request: { threadId, path: '' } })
        expect(listRes.ok).toBe(true)
        const listing = toolsResultSchema(fileListingSchema).parse(listRes.result)
        expect(listing.ok).toBe(true)
        if (!listing.ok) throw new Error('expected ok listing')
        const workspaceId = listing.value.workspace.workspaceId

        // Preview valid file inside thread workspace.
        const previewRes = await rpc({ op: 'thread-file-preview', request: { threadId, path: 'readme.md', workspaceId } })
        expect(previewRes.ok).toBe(true)
        const preview = toolsResultSchema(filePreviewSchema).parse(previewRes.result)
        expect(preview.ok).toBe(true)
        if (preview.ok && preview.value.content.kind === 'markdown') {
          expect(preview.value.content.text).toContain('# Contract test')
        }

        // Security: attempting to read host-listener.json or supply mismatched workspaceId MUST be refused!
        const secretAttempt = await rpc({
          op: 'thread-file-preview',
          request: { threadId, path: '../host-listener.json', workspaceId },
        })
        expect(secretAttempt.ok).toBe(true)
        const secretParsed = toolsResultSchema(filePreviewSchema).parse(secretAttempt.result)
        expect(secretParsed.ok).toBe(false)

        const wrongWsAttempt = await rpc({
          op: 'thread-file-preview',
          request: { threadId, path: 'readme.md', workspaceId: '0'.repeat(64) },
        })
        const wrongWsParsed = toolsResultSchema(filePreviewSchema).parse(wrongWsAttempt.result)
        expect(wrongWsParsed.ok).toBe(false)
        if (!wrongWsParsed.ok) expect(wrongWsParsed.error.code).toBe('workspace-changed')

        // Oversized text preview (> 512 KiB) must be refused with too-large.
        const hugePreview = await rpc({ op: 'thread-file-preview', request: { threadId, path: 'oversized.txt', workspaceId } })
        const hugePreviewParsed = toolsResultSchema(filePreviewSchema).parse(hugePreview.result)
        expect(hugePreviewParsed.ok).toBe(false)
        if (!hugePreviewParsed.ok) expect(hugePreviewParsed.error.code).toBe('too-large')

        // All remaining v1 remote ops validate cleanly against their TS Zod schemas.
        gitRefsPageSchema.parse((await rpc({ op: 'git-refs', request: { threadId } })).result)
        gitChangedFilesSchema.parse((await rpc({ op: 'git-changed-files', request: { threadId } })).result)
        toolsResultSchema(gitListingSchema).parse((await rpc({ op: 'thread-changes', request: { threadId, workspaceId } })).result)
        toolsResultSchema(gitReviewSchema).parse((await rpc({ op: 'thread-changes-review', request: { threadId, workspaceId, scope: { kind: 'working' } } })).result)
        hostFoldersResultSchema.parse((await rpc({ op: 'host-folders', request: { path: projectDir } })).result)
        hostMachineReportSchema.parse((await rpc({ op: 'host-facts' })).result)
        const subPage = subagentPageSchema.parse((await rpc({ op: 'subagent-page', request: { threadId } })).result)
        expect(subPage.revision).toBeGreaterThan(0)
        expect(subPage.rows).toHaveLength(1)
        expect(subPage.rows[0]).toMatchObject({ id: 'agent-1', title: 'Inspect Rust store', status: 'completed' })
        expect(subPage.summary).toMatchObject({ total: 1, completed: 1 })
        const subAsgn = subagentAssignmentsPageSchema.parse(
          (await rpc({ op: 'subagent-assignments', request: { threadId, agentId: 'agent-1' } })).result,
        )
        expect(subAsgn.assignments).toHaveLength(1)
        expect(subAsgn.assignments[0]).toMatchObject({
          id: 'asgn-1',
          prompt: 'Check subagents.sqlite parity',
          result: 'Parity verified',
        })

        // Send a prompt so thread-words finds a match matching `agentThreadWordsSchema`.
        await rpc({ op: 'command', command: { type: 'manual-send', threadId, text: 'UniqueNeedleWord42', attachments: [imgHandle] } })
        const words = agentThreadWordsSchema.parse((await rpc({ op: 'thread-words', query: 'UniqueNeedleWord42' })).result)
        expect(words.found).toHaveLength(1)
        expect(words.found[0]!.threadId).toBe(threadId)

        // Usage dashboard real v1 ops (`usage-read`, `usage-refresh`, `usage-clear`) reading TS-seeded `usage.sqlite`.
        const uRead = usageLocalHostReadSchema.parse((await rpc({ op: 'usage-read', query: { timeZone: 'UTC' } })).result)
        expect(uRead.status).toBe('ready')
        expect(uRead.activity?.totals.tokens.input.value).toBe(420)
        expect(uRead.activity?.totals.tokens.output.value).toBe(80)
        expect(uRead.activity?.totals.tokens.total.value).toBe(500)
        expect(uRead.activity?.totals.prompts.user).toBe(1)
        expect(uRead.activity?.models[0]).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.2' })
        expect(uRead.activity?.daily).toHaveLength(1)
        expect(uRead.activity?.daily[0]?.day).toBe('2026-11-22')
        expect(uRead.activity?.hourly).toHaveLength(1)
        expect(uRead.activity?.hourly[0]).toMatchObject({ weekday: 6, hour: 12 })
        expect(uRead.quotas.find(q => q.providerId === 'codex')?.reason).toBe('unsupported')
        expect(uRead.quotas.find(q => q.providerId === 'claude')?.reason).toBe('not-connected')

        const uRefresh = usageLocalHostReadSchema.parse((await rpc({ op: 'usage-refresh' })).result)
        expect(uRefresh.status).toBe('ready')
        expect(uRefresh.quotas.some(q => q.providerId === 'codex')).toBe(true)

        const uStale = usageLocalClearResultSchema.parse(
          (await rpc({ op: 'usage-clear', request: { expectedRevision: seededUsageRevision + 99 } })).result,
        )
        expect(uStale.status).toBe('stale')
        const uClear = usageLocalClearResultSchema.parse(
          (await rpc({ op: 'usage-clear', request: { expectedRevision: seededUsageRevision } })).result,
        )
        expect(uClear.status).toBe('cleared')
        expect(uClear.metadata.revision).toBe(seededUsageRevision + 1)
        const uAfterClear = usageLocalHostReadSchema.parse((await rpc({ op: 'usage-read', query: { timeZone: 'UTC' } })).result)
        expect(uAfterClear.activity?.totals.tokenRecords).toBe(0)
        expect(uAfterClear.activity?.totals.prompts.total).toBe(0)
      } finally {
        sock.close()
      }
    } finally {
      await running.stop()
    }

    // 6. Verify TS `ThreadRegistry` loads Rust's `threads.json` with zero lost bindings!
    const tsRegistry = new ThreadRegistry(dataDir)
    await tsRegistry.load()
    const binding = tsRegistry.byThread(threadId)
    expect(binding).toBeDefined()
    expect(binding?.provider).toBe('codex')
    expect(binding?.createdAt).toBeTruthy()

    // 7. Verify TS `UsageStore` honors Rust's `usage-clear` exclusions so cleared records never resurrect!
    const verifyUsage = new UsageStore(join(dataDir, 'usage.sqlite'))
    verifyUsage.open()
    try {
      expect(verifyUsage.metadata().revision).toBe(seededUsageRevision + 1)
      const reingest = verifyUsage.observeTokens({
        providerId: 'codex',
        threadId,
        recordKey: recordHash,
        modelId: 'native:codex:model:gpt-5.2-2026-01-15',
        tokens: { input: 420, output: 80, cached: 100 },
        at: '2026-11-22T12:15:00.000Z',
        phase: 'replay',
        partial: false,
      })
      expect(reingest.status).toBe('suppressed')
    } finally {
      verifyUsage.close()
    }

    await rm(dataDir, { recursive: true, force: true })
  }, 30_000)
})

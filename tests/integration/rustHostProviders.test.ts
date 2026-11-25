// @vitest-environment node
// Cross-language live provider parity tests for the native Rust `sotto-host` binary (ADR-0214, Phase 3.3).
// Runs the compiled Rust `sotto-host` against Sotto's real `fakeCodexAppServer.mjs` and `fakeClaudeThread.mjs`
// fixtures using the referee harness's wire client (`wire.ts`), client fold (`fold.ts`), and file-based
// fake driver (`providers.ts`), asserting zero protocol violations and zero fake schema violations.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectWatcherWorkerModels } from '../../src/main/agents/watcher'
import {
  agentAttachmentHandleSchema,
  isThreadProviderConnected,
  publicProviderEntityId,
  type AgentHostSnapshot,
  type AgentThread,
} from '../../src/shared/agents'
import { ClientFold, FOLDED_PUSHES } from '../referee/fold'
import { drive, nativeSession, prepareFake, type RefereeProvider } from '../referee/providers'
import { CLIENTS, PROFILES, THREAD, type ClientName } from '../referee/scenario'
import { openSocket, pairClient, startHost, type Socket } from '../referee/wire'
import { expectNodeReadsRustRecord } from './rustHostNodeStores'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const PIXEL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const NOTES_BYTES = Buffer.from('Referee notes from Rust provider test\n')

async function findRustHostBinary(): Promise<string> {
  const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
  const cargoTargetDir = process.env.CARGO_TARGET_DIR
  const candidates = [
    ...(cargoTargetDir ? [join(cargoTargetDir, 'debug', exe), join(cargoTargetDir, 'release', exe)] : []),
    resolve('target', 'debug', exe),
    resolve('target', 'release', exe),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try next build location.
    }
  }
  throw new Error(`Could not find compiled Rust ${exe}. Run cargo build -p sotto-host --bin sotto-host first.`)
}

interface TestClient {
  readonly name: ClientName
  readonly session: string
  readonly socket: Socket
  readonly fold: ClientFold
  read: number
  next: number
  readonly pending: Map<string, { op: string; resolve: (frame: Record<string, unknown>) => void }>
}

function drain(client: TestClient): void {
  const { crossings } = client.socket
  for (; client.read < crossings.length; client.read++) {
    const crossing = crossings[client.read]!
    if (crossing.dir !== 'in') continue
    const frame = crossing.frame
    if (typeof frame.event === 'string' && FOLDED_PUSHES.has(frame.event)) {
      client.fold.push(frame)
      continue
    }
    const id = typeof frame.id === 'string' ? frame.id : undefined
    const waiting = id ? client.pending.get(id) : undefined
    if (id && waiting) {
      client.pending.delete(id)
      if (frame.ok === true) {
        if (waiting.op === 'hello') client.fold.hello(frame.result)
        else if (waiting.op === 'shell') client.fold.shellRead(frame.result)
        else if (waiting.op === 'command') client.fold.commandAnswer(frame.result)
      }
      waiting.resolve(frame)
    }
  }
}

function sendReq(client: TestClient, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${client.name}-${++client.next}`
  const op = String(body.op ?? '')
  if (op === 'observe') client.fold.observing(body.threadIds as string[])
  return new Promise((resolveReq, rejectReq) => {
    const timer = setTimeout(() => {
      client.pending.delete(id)
      rejectReq(new Error(`${client.name} timed out waiting for ${op}`))
    }, 15_000)
    client.pending.set(id, {
      op,
      resolve: frame => {
        clearTimeout(timer)
        resolveReq(frame)
      },
    })
    client.socket.send({ v: 1, id, session: client.session, ...body })
  })
}

async function waitFor(clients: readonly TestClient[], pred: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const c of clients) drain(c)
    if (pred()) return
    await new Promise(r => setTimeout(r, 15))
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

describe.skipIf(!RUN_RUST_HOST)('Rust sotto-host native Codex and Claude Code adapters (Phase 3.3c)', () => {
  for (const provider of ['codex', 'claude'] as const satisfies readonly RefereeProvider[]) {
    it(`runs full 3-client conversation, question, permission, interrupt, and attachments on ${provider}`, async () => {
      const binary = await findRustHostBinary()
      const dataDir = await mkdtemp(join(tmpdir(), `sotto-rust-${provider}-`))
      await prepareFake(dataDir, provider)

      const host = await startHost(
        [binary, '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures')],
        dataDir,
        provider,
        30_000,
      )
      const clients: TestClient[] = []
      try {
        for (const name of CLIENTS) {
          const paired = await pairClient(host.port, dataDir, `Rust test ${name}`)
          const socket = await openSocket(host.port, paired.session, PROFILES[name].offer)
          const client: TestClient = {
            name,
            session: paired.session,
            socket,
            fold: new ClientFold(),
            read: 0,
            next: 0,
            pending: new Map(),
          }
          socket.onArrival(() => drain(client))
          clients.push(client)
        }
        const byName = (name: ClientName): TestClient => clients.find(c => c.name === name)!
        const desktop = byName('desktop')
        const iphone = byName('iphone')
        const plain = byName('plain')

        for (const c of clients) {
          const hello = await sendReq(c, { op: 'hello', ...PROFILES[c.name].hello })
          expect(hello.ok).toBe(true)
        }

        // Wait for provider startup connect + model catalog.
        await waitFor(clients, () => {
          const providers = ((desktop.fold.held.shell?.host as { providers?: { id: string; connection: string }[] } | undefined)?.providers) ?? []
          const models = ((desktop.fold.held.shell?.host as { models?: { providerId: string }[] } | undefined)?.models) ?? []
          return providers.some(p => p.id === provider && p.connection === 'connected')
            && models.some(m => m.providerId === provider)
        }, `${provider} connected with models`)

        // Create project + thread.
        const projRes = await sendReq(desktop, {
          op: 'command',
          command: { type: 'create-project', provider, title: 'Rust Test Project', path: dataDir, useExisting: true },
        })
        expect(projRes.ok).toBe(true)
        await waitFor(clients, () => {
          const projects = ((desktop.fold.held.shell?.host as { projects?: { path: string }[] } | undefined)?.projects) ?? []
          return projects.some(p => p.path === dataDir)
        }, 'project visible')

        const projectId = (((desktop.fold.held.shell?.host as { projects?: { id: string; path: string }[] }).projects) ?? [])
          .find(p => p.path === dataDir)!.id

        const threadRes = await sendReq(desktop, {
          op: 'command',
          command: {
            type: 'create-thread',
            threadId: THREAD,
            projectId,
            title: 'Rust Test Thread',
            titleSource: 'user',
            modelId: publicProviderEntityId(provider, 'model', 'fixture-model'),
            workingCopy: 'shared',
            managed: false,
          },
        })
        expect(threadRes.ok).toBe(true)

        // All 3 clients observe the thread; detail must arrive before observe answers.
        for (const c of clients) {
          const obs = await sendReq(c, { op: 'observe', threadIds: [THREAD] })
          expect(obs.ok).toBe(true)
          expect(c.fold.held.details[THREAD]).toBeDefined()
        }

        const threadOf = (c: TestClient) =>
          (((c.fold.held.shell?.host as { threads?: Record<string, unknown>[] } | undefined)?.threads) ?? [])
            .find(t => t.id === THREAD) as { status?: string; requests?: { id: string; kind: string }[] } | undefined
        const messagesText = (c: TestClient) => JSON.stringify(c.fold.held.details[THREAD]?.messages ?? [])

        // 1. Standard send + streamed completion.
        const send1 = await sendReq(desktop, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Referee prompt one' },
        })
        expect(send1.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running' && messagesText(c).includes('Referee prompt one')), 'prompt one running')

        // Verify native session record was persisted on disk (`codex-threads.json` / `claude-threads.json`).
        const nativeId = await nativeSession(dataDir, provider, THREAD, 10_000)
        expect(nativeId.length).toBeGreaterThan(0)

        await drive(dataDir, provider, { type: 'complete', thread: THREAD, text: 'Referee reply one' })
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle' && messagesText(c).includes('Referee reply one')), 'reply one completed')

        // 2. Question raised by fake, answered by iPhone.
        const send2 = await sendReq(iphone, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Referee prompt two' },
        })
        expect(send2.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running'), 'prompt two running')

        await drive(dataDir, provider, { type: 'question', thread: THREAD, text: 'Which colour?' })
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 1), 'question visible')
        const questionId = threadOf(iphone)!.requests![0]!.id
        expect(threadOf(iphone)!.requests![0]!.kind).toBe('question')

        const ansQ = await sendReq(iphone, {
          op: 'command',
          command: { type: 'answer', threadId: THREAD, requestId: questionId, answer: 'Blue' },
        })
        expect(ansQ.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 0), 'question cleared')

        await drive(dataDir, provider, { type: 'complete', thread: THREAD, text: 'Referee reply two' })
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle' && messagesText(c).includes('Referee reply two')), 'reply two completed')

        // 3. Permission raised by fake, allowed by plain client.
        const send3 = await sendReq(plain, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Referee prompt three' },
        })
        expect(send3.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running'), 'prompt three running')

        await drive(dataDir, provider, { type: 'permission', thread: THREAD, text: 'Run the referee build?' })
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 1), 'permission visible')
        const permId = threadOf(plain)!.requests![0]!.id
        expect(threadOf(plain)!.requests![0]!.kind).toBe('permission')

        const ansP = await sendReq(plain, {
          op: 'command',
          command: { type: 'answer', threadId: THREAD, requestId: permId, answer: '', approved: true },
        })
        expect(ansP.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 0), 'permission cleared')

        await drive(dataDir, provider, { type: 'complete', thread: THREAD, text: 'Referee reply three' })
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle' && messagesText(c).includes('Referee reply three')), 'reply three completed')

        // 4. Staged image + staged text file attachments on a turn, then interrupt.
        const imgHandle = await sendReq(desktop, {
          op: 'stage-attachment',
          image: { name: 'Referee.png', mimeType: 'image/png', data: PIXEL_PNG_B64 },
        })
        expect(imgHandle.ok).toBe(true)
        const parsedImg = agentAttachmentHandleSchema.parse(imgHandle.result)
        const fileHandle = await sendReq(desktop, {
          op: 'stage-file-part',
          part: {
            uploadId: '00000000-0000-4000-8000-0000000000f1',
            index: 0,
            count: 1,
            name: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: NOTES_BYTES.byteLength,
            digest: createHash('sha256').update(NOTES_BYTES).digest('hex'),
            data: NOTES_BYTES.toString('base64'),
          },
        })
        expect(fileHandle.ok).toBe(true)
        const parsedFile = agentAttachmentHandleSchema.parse(fileHandle.result)

        const send4 = await sendReq(desktop, {
          op: 'command',
          command: {
            type: 'manual-send',
            threadId: THREAD,
            text: 'Referee prompt four',
            attachments: [parsedImg, parsedFile],
          },
        })
        expect(send4.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running' && messagesText(c).includes('Referee prompt four')), 'prompt four running')
        const userMessages = (desktop.fold.held.details[THREAD]?.messages ?? []) as { text?: string; attachments?: { id: string }[] }[]
        const promptFour = userMessages.find(m => m.text === 'Referee prompt four')
        expect(promptFour?.attachments?.map(a => a.id)).toEqual([parsedImg.id, parsedFile.id])

        const stopRes = await sendReq(desktop, {
          op: 'command',
          command: { type: 'interrupt', threadId: THREAD },
        })
        expect(stopRes.ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle'), 'turn interrupted')

        // 5. Read events from threads.sqlite & confirm zero protocol fold problems and zero fake schema violations.
        const evRes = await sendReq(plain, { op: 'events', afterSeq: 0, threadId: THREAD })
        expect(evRes.ok).toBe(true)
        const evList = (evRes.result as { events: unknown[] }).events
        expect(evList.length).toBeGreaterThanOrEqual(8)

        for (const c of clients) {
          expect(c.fold.problems, `${c.name} ClientFold problems on ${provider}`).toEqual([])
        }

        const violations = await readFile(join(dataDir, 'violations.jsonl'), 'utf8').catch(() => '')
        expect(violations, `${provider} fake reported schema/protocol violations`).toBe('')

        // The record this host made for the thread reads in Node after a rollback (ADR-0214).
        await expectNodeReadsRustRecord(dataDir, provider, THREAD, { projectId, title: 'Rust Test Thread' })
      } finally {
        for (const c of clients) c.socket.close()
        await host.stop()
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }, 60_000)

    it(`recovers across host restart and handles lost acknowledgement on ${provider}`, async () => {
      const binary = await findRustHostBinary()
      const dataDir = await mkdtemp(join(tmpdir(), `sotto-rust-restart-${provider}-`))
      await prepareFake(dataDir, provider)

      const cmd = [binary, '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures')] as const
      let host = await startHost(cmd, dataDir, provider, 30_000)
      let client: TestClient | undefined
      try {
        const paired = await pairClient(host.port, dataDir, 'Restart Desktop')
        const openClient = async (port: number, session: string): Promise<TestClient> => {
          const socket = await openSocket(port, session, PROFILES.desktop.offer)
          const c: TestClient = {
            name: 'desktop',
            session,
            socket,
            fold: new ClientFold(),
            read: 0,
            next: 0,
            pending: new Map(),
          }
          socket.onArrival(() => drain(c))
          const hello = await sendReq(c, { op: 'hello', ...PROFILES.desktop.hello })
          expect(hello.ok).toBe(true)
          return c
        }

        client = await openClient(host.port, paired.session)
        await waitFor([client], () => {
          const providers = ((client!.fold.held.shell?.host as { providers?: { id: string; connection: string }[] } | undefined)?.providers) ?? []
          return providers.some(p => p.id === provider && p.connection === 'connected')
        }, `${provider} connected`)

        await sendReq(client, {
          op: 'command',
          command: { type: 'create-project', provider, title: 'Restart Project', path: dataDir, useExisting: true },
        })
        await waitFor([client], () => (((client!.fold.held.shell?.host as { projects?: unknown[] } | undefined)?.projects) ?? []).length > 0, 'project created')
        const projectId = (((client.fold.held.shell?.host as { projects: { id: string }[] }).projects)[0]!).id

        await sendReq(client, {
          op: 'command',
          command: {
            type: 'create-thread',
            threadId: THREAD,
            projectId,
            title: 'Restart Thread',
            titleSource: 'user',
            modelId: publicProviderEntityId(provider, 'model', 'fixture-model'),
            workingCopy: 'shared',
            managed: false,
          },
        })
        await sendReq(client, { op: 'observe', threadIds: [THREAD] })

        // First turn before restart.
        await sendReq(client, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Before restart prompt' },
        })
        const nativeBefore = await nativeSession(dataDir, provider, THREAD, 10_000)
        await drive(dataDir, provider, { type: 'complete', thread: THREAD, text: 'Before restart reply' })
        await waitFor([client], () => JSON.stringify(client!.fold.held.details[THREAD]?.messages ?? []).includes('Before restart reply'), 'reply before restart')

        // Stop host and restart against the exact same data directory.
        client.socket.close()
        await host.stop()
        host = await startHost(cmd, dataDir, provider, 30_000)
        const session2 = await (await import('../referee/wire')).openSession(host.port, paired.token)
        client = await openClient(host.port, session2)
        await waitFor([client], () => {
          const providers = ((client!.fold.held.shell?.host as { providers?: { id: string; connection: string }[] } | undefined)?.providers) ?? []
          return providers.some(p => p.id === provider && p.connection === 'connected')
        }, `${provider} reconnected after restart`)

        await sendReq(client, { op: 'observe', threadIds: [THREAD] })
        expect(JSON.stringify(client.fold.held.details[THREAD]?.messages ?? [])).toContain('Before restart reply')

        // Send a second turn after restart: must resume the SAME native session ID!
        await sendReq(client, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'After restart prompt' },
        })
        const nativeAfter = await nativeSession(dataDir, provider, THREAD, 10_000)
        expect(nativeAfter).toBe(nativeBefore)
        await drive(dataDir, provider, { type: 'complete', thread: THREAD, text: 'After restart reply' })
        await waitFor([client], () => JSON.stringify(client!.fold.held.details[THREAD]?.messages ?? []).includes('After restart reply'), 'reply after restart')

        // Lost acknowledgement: fake delays ack past the 2s request timeout -> delivery marked `uncertain`.
        await drive(dataDir, provider, { type: 'lose-acknowledgement' })
        const uncertainRes = await sendReq(client, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Delayed prompt' },
        })
        expect(uncertainRes.ok).toBe(true)
        await waitFor([client], () => {
          const deliveries = ((client!.fold.held.shell?.deliveries ?? []) as { status?: string }[])
          return deliveries.some(d => d.status === 'uncertain')
        }, 'uncertain delivery visible')
        await drive(dataDir, provider, { type: 'acknowledge-again' })

        expect(client.fold.problems).toEqual([])
        const violations = await readFile(join(dataDir, 'violations.jsonl'), 'utf8').catch(() => '')
        expect(violations).toBe('')
      } finally {
        client?.socket.close()
        await host.stop()
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }, 60_000)
  }

  it('connects native providers under stripped bare PATH, populates workers/models, and completes send', async () => {
    const binary = await findRustHostBinary()
    const root = await mkdtemp(join(tmpdir(), 'sotto-rust-bare-path-'))
    const fakeHome = join(root, 'home')
    const dataDir = join(root, 'data')
    await mkdir(fakeHome, { recursive: true })
    await mkdir(dataDir, { recursive: true })

    // Restrict startup to claude, codex, devin (installed in user dirs) + muse (intentionally missing)
    // so developer-installed system binaries for other providers cannot interfere.
    await writeFile(
      join(dataDir, 'agents.json'),
      JSON.stringify({
        configuration: {
          provider: 'codex',
          disconnectedProviders: ['grok', 'opencode', 'cursor', 'hermes', 'antigravity'],
        },
      }),
    )

    const windows = process.platform === 'win32'
    const fixtures = resolve('tests/fixtures')
    const writeFakeBin = async (dir: string, name: string, fixtureFile: string, extraArgs = ''): Promise<void> => {
      await mkdir(dir, { recursive: true })
      const script = join(fixtures, fixtureFile)
      if (windows) {
        const file = join(dir, `${name}.cmd`)
        const body = `@echo off\r\n"${process.execPath}" "${script}" "${dataDir}" ${extraArgs}%*\r\n`
        await writeFile(file, body, 'utf8')
      } else {
        const file = join(dir, name)
        const body = `#!/bin/sh\nexec "${process.execPath}" "${script}" "${dataDir}" ${extraArgs}"$@"\n`
        await writeFile(file, body, { encoding: 'utf8', mode: 0o755 })
        await chmod(file, 0o755)
      }
    }

    // 1) Claude installed ONLY in $HOME/.local/bin
    await writeFakeBin(join(fakeHome, '.local', 'bin'), 'claude', 'fakeClaudeThread.mjs')
    // 2) Codex installed ONLY in mise installs (matching real forge layout)
    const miseBase = windows
      ? join(fakeHome, 'AppData', 'Local', 'mise')
      : join(fakeHome, '.local', 'share', 'mise')
    await writeFakeBin(
      join(miseBase, 'installs', 'codex', 'latest', 'bin'),
      'codex',
      'fakeCodexAppServer.mjs',
    )
    // 3) Devin installed ONLY in mise shims (fallback coverage)
    await writeFakeBin(join(miseBase, 'shims'), 'devin', 'fakeDevinAgent.mjs')

    const strippedEnv: NodeJS.ProcessEnv = windows
      ? {
          PATH: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : 'C:\\Windows\\System32',
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
          USERPROFILE: fakeHome,
          HOME: fakeHome,
          LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
          APPDATA: join(fakeHome, 'AppData', 'Roaming'),
          TEMP: root,
          TMP: root,
          SOTTO_HOST_ENABLE_PROVIDERS: '1',
          SOTTO_HOST_STARTED_BY: 'launch-script',
          SOTTO_FAKE_CLAUDE_HOME: join(dataDir, 'claude-home'),
        }
      : {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: fakeHome,
          SHELL: '/bin/sh',
          XDG_DATA_HOME: join(fakeHome, '.local', 'share'),
          MISE_DATA_DIR: miseBase,
          TMPDIR: root,
          SOTTO_HOST_ENABLE_PROVIDERS: '1',
          SOTTO_HOST_STARTED_BY: 'launch-script',
          SOTTO_FAKE_CLAUDE_HOME: join(dataDir, 'claude-home'),
        }

    const child = spawn(binary, ['--data', dataDir, '--port', '0'], {
      env: strippedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })

    let client: TestClient | undefined
    try {
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        const timer = setTimeout(() => rejectPort(new Error(`sotto-host did not print ready line; stderr=${stderr}`)), 30_000)
        let buf = ''
        child.stdout?.setEncoding('utf8').on('data', chunk => {
          buf += chunk
          for (const line of buf.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('{')) continue
            try {
              const parsed = JSON.parse(trimmed) as { port?: number }
              if (typeof parsed.port === 'number' && parsed.port > 0) {
                clearTimeout(timer)
                resolvePort(parsed.port)
                return
              }
            } catch {
              // Wait for full JSON line.
            }
          }
        })
        child.once('exit', code => {
          clearTimeout(timer)
          rejectPort(new Error(`sotto-host exited early (${String(code)}); stderr=${stderr}`))
        })
      })

      const paired = await pairClient(port, dataDir, 'Bare PATH Desktop')
      const socket = await openSocket(port, paired.session, PROFILES.desktop.offer)
      client = {
        name: 'desktop',
        session: paired.session,
        socket,
        fold: new ClientFold(),
        read: 0,
        next: 0,
        pending: new Map(),
      }
      socket.onArrival(() => drain(client!))
      const hello = await sendReq(client, { op: 'hello', ...PROFILES.desktop.hello })
      expect(hello.ok).toBe(true)

      await waitFor([client], () => {
        const hostSnap = client!.fold.held.shell?.host as AgentHostSnapshot | undefined
        const providers = hostSnap?.providers ?? []
        return providers.some(p => p.id === 'claude' && p.connection === 'connected')
          && providers.some(p => p.id === 'codex' && p.connection === 'connected')
          && providers.some(p => p.id === 'devin' && p.connection === 'connected')
      }, 'claude, codex, and devin connected under bare PATH', 20_000)

      const hostSnap = client.fold.held.shell?.host as AgentHostSnapshot
      expect(hostSnap.connected).toBe(true)

      // Missing provider (`muse`) must record an error instead of silently staying disconnected.
      const muse = hostSnap.providers?.find(p => p.id === 'muse')
      expect(muse?.connection).toBe('error')
      expect(typeof muse?.error).toBe('string')
      expect((muse?.error ?? '').length).toBeGreaterThan(0)

      // Watcher `list_projects` worker catalog must be populated with ready models for all 3 providers.
      const workers = selectWatcherWorkerModels(hostSnap.models, 100)
      expect(workers.length).toBeGreaterThan(0)
      expect(workers.some(m => m.providerId === 'claude')).toBe(true)
      expect(workers.some(m => m.providerId === 'codex')).toBe(true)
      expect(workers.some(m => m.providerId === 'devin')).toBe(true)

      // Create project + thread on Claude and verify Watcher's connected predicate + live send.
      const projRes = await sendReq(client, {
        op: 'command',
        command: { type: 'create-project', provider: 'claude', title: 'Bare Path Repo', path: dataDir, useExisting: true },
      })
      expect(projRes.ok).toBe(true)
      await waitFor([client], () => (((client!.fold.held.shell?.host as AgentHostSnapshot | undefined)?.projects) ?? []).length > 0, 'project created')
      const projectId = ((client.fold.held.shell?.host as AgentHostSnapshot).projects[0]!).id

      const threadId = '00000000-0000-4000-8000-0000000000f1'
      const threadRes = await sendReq(client, {
        op: 'command',
        command: {
          type: 'create-thread',
          threadId,
          projectId,
          title: 'Bare Path Claude Thread',
          titleSource: 'user',
          modelId: publicProviderEntityId('claude', 'model', 'fixture-model'),
          workingCopy: 'shared',
          managed: false,
        },
      })
      expect(threadRes.ok).toBe(true)
      await sendReq(client, { op: 'observe', threadIds: [threadId] })

      const latestHost = client.fold.held.shell?.host as AgentHostSnapshot
      const createdThread = latestHost.threads.find(t => t.id === threadId) as AgentThread | undefined
      expect(createdThread).toBeDefined()
      expect(isThreadProviderConnected(latestHost, createdThread!)).toBe(true)

      const sendRes = await sendReq(client, {
        op: 'command',
        command: { type: 'manual-send', threadId, text: 'Ping under bare PATH' },
      })
      expect(sendRes.ok).toBe(true)
      await nativeSession(dataDir, 'claude', threadId, 10_000)
      await drive(dataDir, 'claude', { type: 'complete', thread: threadId, text: 'Pong under bare PATH' })
      await waitFor(
        [client],
        () => JSON.stringify(client!.fold.held.details[threadId]?.messages ?? []).includes('Pong under bare PATH'),
        'bare-PATH Claude turn reply',
      )
      expect(client.fold.problems).toEqual([])
    } finally {
      client?.socket.close()
      child.kill('SIGTERM')
      await new Promise<void>(resolveExit => {
        const force = setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 3_000)
        child.once('exit', () => { clearTimeout(force); resolveExit() })
      })
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 60_000)
})

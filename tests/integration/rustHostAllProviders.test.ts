// @vitest-environment node
// Cross-language live provider parity tests for Phase 3.4a: Grok Build, Devin, Muse, OpenCode,
// Cursor, and Antigravity running natively inside the compiled Rust `sotto-host` binary against
// Sotto's real JS fake provider fixtures.
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publicProviderEntityId } from '../../src/shared/agents'
import { ClientFold, FOLDED_PUSHES } from '../referee/fold'
import { drive, nativeSession, type RefereeProvider } from '../referee/providers'
import { CLIENTS, PROFILES, THREAD, type ClientName } from '../referee/scenario'
import { expectNodeReadsRustRecord } from './rustHostNodeStores'
import { openSocket, pairClient, startHost, type Socket } from '../referee/wire'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'

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

const PROVIDER_MODELS: Record<RefereeProvider | 'antigravity', string> = {
  codex: 'fixture-model',
  claude: 'fixture-model',
  grok: 'fixture-model',
  devin: 'fixture-model',
  muse: 'fixture-model',
  opencode: 'opencode/fixture-model',
  cursor: 'gpt-fixture',
  antigravity: 'gemini-3.8-flash',
}

async function driveProvider(
  dataDir: string,
  provider: RefereeProvider | 'antigravity',
  action: { type: 'complete' | 'question' | 'permission'; text: string },
): Promise<void> {
  if (provider !== 'antigravity') {
    await drive(dataDir, provider, { ...action, thread: THREAD })
    return
  }
  const records = JSON.parse(await readFile(join(dataDir, 'antigravity-threads.json'), 'utf8')) as Record<string, { antigravitySessionId?: string }>
  const sessionId = records[THREAD]?.antigravitySessionId
  if (!sessionId) throw new Error('antigravity-threads.json has no antigravitySessionId')
  await writeFile(join(dataDir, 'control.json'), JSON.stringify({ id: randomUUID(), sessionId, ...action }))
}

describe.skipIf(!RUN_RUST_HOST)('Rust sotto-host Phase 3.4a all remaining providers', () => {
  const providers: readonly (RefereeProvider | 'antigravity')[] = ['grok', 'devin', 'muse', 'opencode', 'cursor', 'antigravity']

  for (const provider of providers) {
    it(`runs full conversation, question, permission, and interrupt on ${provider}`, async () => {
      const binary = await findRustHostBinary()
      const dataDir = await mkdtemp(join(tmpdir(), `sotto-rust-${provider}-`))
      const host = await startHost(
        [binary, '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures')],
        dataDir,
        provider,
        30_000,
      )
      const clients: TestClient[] = []
      try {
        for (const name of CLIENTS) {
          const paired = await pairClient(host.port, dataDir, `Rust ${provider} ${name}`)
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
        const desktop = clients.find(c => c.name === 'desktop')!
        const iphone = clients.find(c => c.name === 'iphone')!
        const plain = clients.find(c => c.name === 'plain')!

        for (const c of clients) {
          const baseAccepts = (PROFILES[c.name].hello.accepts as string[] | undefined) ?? []
          const accepts = provider === 'antigravity' ? [...baseAccepts, 'provider-antigravity'] : baseAccepts
          const hello = await sendReq(c, { op: 'hello', ...PROFILES[c.name].hello, accepts })
          expect(hello.ok).toBe(true)
        }

        await waitFor(clients, () => {
          const rows = ((desktop.fold.held.shell?.host as { providers?: { id: string; connection: string }[] } | undefined)?.providers) ?? []
          const models = ((desktop.fold.held.shell?.host as { models?: { providerId: string }[] } | undefined)?.models) ?? []
          return rows.some(p => p.id === provider && p.connection === 'connected')
            && models.some(m => m.providerId === provider)
        }, `${provider} connected with models`)

        const projRes = await sendReq(desktop, {
          op: 'command',
          command: { type: 'create-project', provider, title: 'Rust Project', path: dataDir, useExisting: true },
        })
        expect(projRes.ok).toBe(true)
        await waitFor(clients, () => (((desktop.fold.held.shell?.host as { projects?: unknown[] } | undefined)?.projects) ?? []).length > 0, 'project created')
        const projectId = (((desktop.fold.held.shell?.host as { projects: { id: string }[] }).projects)[0]!).id

        const threadRes = await sendReq(desktop, {
          op: 'command',
          command: {
            type: 'create-thread',
            threadId: THREAD,
            projectId,
            title: `Rust ${provider} thread`,
            titleSource: 'user',
            modelId: publicProviderEntityId(provider, 'model', PROVIDER_MODELS[provider]),
            workingCopy: 'shared',
            managed: false,
          },
        })
        expect(threadRes.ok).toBe(true)

        for (const c of clients) {
          const obs = await sendReq(c, { op: 'observe', threadIds: [THREAD] })
          expect(obs.ok).toBe(true)
          expect(c.fold.held.details[THREAD]).toBeDefined()
        }

        const threadOf = (c: TestClient) =>
          (((c.fold.held.shell?.host as { threads?: Record<string, unknown>[] } | undefined)?.threads) ?? [])
            .find(t => t.id === THREAD) as { status?: string; requests?: { id: string; kind: string }[] } | undefined
        const messagesText = (c: TestClient) => JSON.stringify(c.fold.held.details[THREAD]?.messages ?? [])

        // 1. Send prompt one + completion.
        expect((await sendReq(desktop, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Prompt one' },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running'), 'turn one running')
        if (provider !== 'antigravity') {
          expect((await nativeSession(dataDir, provider, THREAD, 10_000)).length).toBeGreaterThan(0)
        }
        await driveProvider(dataDir, provider, { type: 'complete', text: 'Reply one' })
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle' && messagesText(c).includes('Reply one')), 'reply one completed')

        // 2. Question raised + answered.
        expect((await sendReq(iphone, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Prompt two' },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running'), 'turn two running')
        await driveProvider(dataDir, provider, { type: 'question', text: 'Which colour?' })
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 1), 'question visible')
        const qId = threadOf(iphone)!.requests![0]!.id
        expect(threadOf(iphone)!.requests![0]!.kind).toBe('question')
        expect((await sendReq(iphone, {
          op: 'command',
          command: { type: 'answer', threadId: THREAD, requestId: qId, answer: 'Blue' },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 0), 'question cleared')
        await driveProvider(dataDir, provider, { type: 'complete', text: 'Reply two' })
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle' && messagesText(c).includes('Reply two')), 'reply two completed')

        // 3. Permission raised + allowed (never allow_always).
        expect((await sendReq(plain, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Prompt three' },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running'), 'turn three running')
        await driveProvider(dataDir, provider, { type: 'permission', text: 'Run build?' })
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 1), 'permission visible')
        const pId = threadOf(plain)!.requests![0]!.id
        expect(threadOf(plain)!.requests![0]!.kind).toBe('permission')
        expect((await sendReq(plain, {
          op: 'command',
          command: { type: 'answer', threadId: THREAD, requestId: pId, answer: '', approved: true },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => (threadOf(c)?.requests?.length ?? 0) === 0), 'permission cleared')
        await driveProvider(dataDir, provider, { type: 'complete', text: 'Reply three' })
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle' && messagesText(c).includes('Reply three')), 'reply three completed')

        // 4. Interrupt active turn.
        expect((await sendReq(desktop, {
          op: 'command',
          command: { type: 'manual-send', threadId: THREAD, text: 'Prompt four' },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'running'), 'turn four running')
        expect((await sendReq(desktop, {
          op: 'command',
          command: { type: 'interrupt', threadId: THREAD },
        })).ok).toBe(true)
        await waitFor(clients, () => clients.every(c => threadOf(c)?.status === 'idle'), 'turn four interrupted')

        // The record this host made for the thread reads in Node after a rollback (ADR-0214).
        await expectNodeReadsRustRecord(dataDir, provider, THREAD, { projectId, title: `Rust ${provider} thread` })

        for (const c of clients) {
          expect(c.fold.problems, `${c.name} ClientFold problems on ${provider}`).toEqual([])
        }
        const violations = await readFile(join(dataDir, 'violations.jsonl'), 'utf8').catch(() => '')
        expect(violations, `${provider} fake reported violations`).toBe('')
      } finally {
        for (const c of clients) c.socket.close()
        await host.stop()
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }, 60_000)
  }
})

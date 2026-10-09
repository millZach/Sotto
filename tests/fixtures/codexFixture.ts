import { parseProviderRecords, writeProviderAction, providerArgument as flag } from './providerRecords'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import type { AgentHost } from '../../src/main/agents/host'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import type { AdapterSessionOptions, RecordedRpc } from './adapterFixture'

export function rolloutLine(ordinal: number, payload: unknown, type = 'event_msg'): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), ordinal, type, payload }) + '\n'
}
/** What the fake client's one-shot mode recorded for each of Sotto's side calls (ADR-0026). */
async function oneShots(root: string): Promise<Record<string, unknown>[]> {
  return parseProviderRecords<Record<string, unknown>>(await readFile(join(root, 'oneshot.jsonl'), 'utf8').catch(() => ''))
}
/** The fake's own number for a request Sotto holds: Sotto's key also names the app-server that asked it. */
export const nativeRequestId = (requestId: string): string | number => JSON.parse(requestId.replace(/^rpc:[^:]+:/u, '')) as string | number
/** What the fake recorded of the app-servers Sotto started: each one's introduction, and each thread start or resume on it. */
export interface ServedRecord { pid: number; method: 'initialize' | 'thread/start' | 'thread/resume'; threadId?: string }
export type { RecordedRpc } from './adapterFixture'
/** The thread history requests among `requests`, in order: `turns` for the newest-turn check, `read` for a whole-transcript read. */
export function historyReads(requests: readonly RecordedRpc[]): ('turns' | 'read')[] {
  return requests.flatMap(request => request.method === 'thread/turns/list' ? ['turns' as const]
    : request.method === 'thread/read' && request.params?.includeTurns === true ? ['read' as const] : [])
}
/** `requests` split at the first `turn/start`, which must be there: what came before the send went out, and what came from it on. */
export function aroundTurnStart(requests: readonly RecordedRpc[]): { before: RecordedRpc[]; after: RecordedRpc[] } {
  const start = requests.findIndex(request => request.method === 'turn/start')
  if (start === -1) throw new Error('No turn/start was sent.')
  return { before: requests.slice(0, start), after: requests.slice(start) }
}
// The deadline also covers the fake app server's process start; see the note on claudeFixture.
export async function codexFixture(root?: string, wrapped = false, requestTimeoutMs = 2000, session: AdapterSessionOptions & { pollIntervalMs?: number } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-codex-'))
  const adapter = new CodexAppServerHost({ userDataPath: root, executable: process.execPath,
    args: [resolve('tests/fixtures/fakeCodexAppServer.mjs'), root], codexHome: join(root, 'home'), requestTimeoutMs, pollIntervalMs: 15, ...session })
  const registry = new ThreadRegistry(root)
  const host: AgentHost = wrapped ? new SottoThreadHost('codex', adapter, registry) : adapter
  const script = (value: unknown) => writeFile(join(root, 'script.json'), JSON.stringify(value))
  const checkViolations = async (): Promise<void> => {
    const lines = await readFile(join(root, 'violations.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '' })
    if (lines) throw new Error(lines.trim().split('\n').map(line => {
      const violation = JSON.parse(line) as { method: string; reason: string }
      return `Invalid Codex reply for ${violation.method}: ${violation.reason}`
    }).join('\n'))
  }
  const requests = async (): Promise<RecordedRpc[]> => {
    await checkViolations()
    return parseProviderRecords(await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => ''))
  }
  const realId = async (sessionId: string): Promise<string> => {
    const aliases = JSON.parse(await readFile(join(root, 'codex-threads.json'), 'utf8'))
    return aliases[wrapped ? registry.byThread(sessionId)!.sessionId : sessionId].codexThreadId
  }
  /** Hand the fake an action and answer the ID it acknowledges it by. */
  const action = async (sessionId: string, value: Record<string, unknown>): Promise<string> => {
    const id = randomUUID()
    await writeProviderAction(join(root, 'control.json'), value, { threadId: await realId(sessionId) }, id)
    return id
  }
  /** Whether the fake has carried out the action `action` answered with this ID. */
  const acted = async (id: string): Promise<boolean> => (await readFile(join(root, 'actions.jsonl'), 'utf8').catch(() => ''))
    .split('\n').some(line => line === JSON.stringify({ id }))
  /** Write input typed in another Codex process to the session log, as Codex does, without the adapter polling it. */
  const typeUnseen = async (id: string, text: string): Promise<void> => {
    const codexThreadId = await realId(id)
    const folder = join(root, 'home', 'sessions', '2026', '09', '10'); await mkdir(folder, { recursive: true })
    const path = join(folder, `rollout-2026-09-10-${codexThreadId}.jsonl`)
    await writeFile(path, rolloutLine(0, { id: codexThreadId }, 'session_meta'), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    await appendFile(path, rolloutLine(Date.now(), { type: 'item_completed', item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] } }))
  }
  const fixture = { root, adapter, registry, host, projectId: 'project', modelId: 'fixture-model', script, realId, typeUnseen,
    // A settings change comes back with the snapshot Codex's confirmation produced; a delayed reply loses it (#318).
    settings: { snapshot: true, loseConfirmation: () => script({ delay: { method: 'thread/settings/update', ms: requestTimeoutMs + 1000 }, suppressNotifications: true }) },
    // Every app-server started from now on answers `initialize` as the newer client.
    clientUpdate: { provider: 'codex' as const, install: async () => { await script({ version: 'codex/0.200.0' }); return '0.200.0' } },
    sideWriting: {
      answer: (text: string) => writeFile(join(root, 'oneshot.json'), JSON.stringify({ text })),
      calls: async () => (await oneShots(root)).map(call => ({ cwd: String(call.cwd), model: flag(call.args, '--model'), material: String(call.input) })),
    },
    driver: {
      typeInProvider: async (id: string, text: string) => { await typeUnseen(id, text); await adapter.pollSessionLogs() },
      completeTurn: async (id: string, text: string) => { await action(id, { type: 'complete', text }) },
      raiseQuestion: async (id: string, text: string) => { await action(id, { type: 'question', text }) },
      raisePermission: async (id: string, text: string) => { await action(id, { type: 'permission', text }) },
      delayNextAck: (method: string) => script({ delay: { method, ms: requestTimeoutMs + 1000 }, suppressNotifications: true }),
      requests,
      restart: async () => { host.disconnect(); await adapter.closed(); return codexFixture(root, wrapped, requestTimeoutMs, session) },
    },
    /** Every app-server the fake saw start, and what each was asked to start or resume. */
    servers: async (): Promise<ServedRecord[]> => parseProviderRecords<ServedRecord>(await readFile(join(root, 'servers.jsonl'), 'utf8').catch(() => '')),
    /** The process id of the app-server that last started or resumed this thread. */
    serverOf: async (sessionId: string): Promise<number | undefined> => {
      const codexThreadId = await realId(sessionId)
      return (await fixture.servers()).findLast(record => record.threadId === codexThreadId)?.pid
    },
    sessions: {
      // Each thread's session runs in its own app-server; a session start is this thread's own resume.
      starts: async (id: string) => {
        const codexThreadId = await realId(id)
        return (await requests()).filter(record => record.method === 'thread/resume' && record.params?.threadId === codexThreadId).length
      },
      stopped: async (id: string) => !adapter.resumedThreads().includes(wrapped ? registry.byThread(id)!.sessionId : id),
    },
    action, acted,
    cleanup: async () => {
      host.disconnect(); await adapter.closed(); await registry.flush()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-')) throw new Error('Unexpected temporary test directory')
      try { await checkViolations() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
  return fixture
}

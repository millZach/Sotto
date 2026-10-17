import { parseProviderRecords, writeProviderAction } from './providerRecords'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { OpenCodeHost, type OpenCodeHostOptions } from '../../src/main/agents/opencode'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'

/** The contract cases this fixture cannot drive, each with the reason (`tests/integration/adapterContract.ts`). */
export const opencodeFixtureSkips: AdapterContractSkips = {
  backgroundWork: 'OpenCode reports no work a turn leaves running, and the fixture drives none.',
  liveSettings: 'OpenCode takes a model, effort or permission change on the live provider session and has no refusal to recover from by starting it again; opencodeAdapter.test.ts checks the live change itself.',
}
/** A log may not exist before its first event; any other read failure is evidence, not an empty trace. */
async function readLog(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
const running = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }

// The deadline also covers the fake server's process start.
export async function opencodeFixture(root?: string, requestTimeoutMs = 3000, session: AdapterSessionOptions = {}, options: OpenCodeHostOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-opencode-thread-'))
  const events: string[] = []
  const adapter = new OpenCodeHost(root, { executable: process.execPath, args: [resolve('tests/fixtures/fakeOpenCodeServer.mjs'), root], requestTimeoutMs,
    startTimeoutMs: 30_000, log: event => events.push(event), ...session, ...options })
  const checkViolations = async () => { const text = await readLog(join(root, 'violations.jsonl')); if (text) throw new Error(`Invalid OpenCode traffic: ${text}`) }
  const requests = async (): Promise<RecordedRpc[]> => {
    await checkViolations()
    return parseProviderRecords<RecordedRpc>(await readLog(join(root, 'requests.jsonl')))
  }
  const script = (value: unknown) => writeFile(join(root, 'script.json'), JSON.stringify(value))
  const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root, 'opencode-threads.json'), 'utf8'))[id].sessionId
  // Each thread has its own fake server. The one holding the session takes the action.
  const action = async (id: string, value: Record<string, unknown>) => { await writeProviderAction(join(root, 'control.json'), value, { sessionId: await realId(id) }, randomUUID()) }
  const holder = async (id: string): Promise<number | undefined> => {
    const native = await realId(id)
    const names = await readdir(join(root, 'holders')).catch(() => [] as string[])
    return names.includes(native) ? Number(await readFile(join(root, 'holders', native), 'utf8')) : undefined
  }
  /** Every fake server process this root has started, by PID, as each recorded itself. */
  const processes = async (): Promise<number[]> => (await requests()).filter(record => record.method === 'fixture/process').map(record => (record.params as { pid: number }).pid)
  /** The provider sessions the fake's database holds, as every server process shares them. */
  const nativeSessions = async (): Promise<{ id: string; title?: string; metadata?: unknown }[]> => {
    const text = await readLog(join(root, 'native-sessions.json'))
    // A server may be writing the file as it is read; a torn read counts as not there yet, and the caller polls again.
    try { return text ? Object.values((JSON.parse(text) as { sessions: Record<string, { id: string; title?: string; metadata?: unknown }> }).sessions) : [] } catch { return [] }
  }
  return { host: adapter, adapter, root, events, projectId: 'project', modelId: 'opencode/fixture-model', realId, script, action, holder, processes, nativeSessions, running, restartStatus: 'idle' as const, skips: opencodeFixtureSkips,
    // A settings change comes back with the snapshot the adapter itself confirmed (#318), and its answer can be lost.
    // A new client on disk: every process started from now on reports the new version, as `opencode --version` would.
    clientUpdate: { provider: 'opencode' as const, install: async () => { await script({ version: '2.0.40' }); return '2.0.40' } },
    settings: { snapshot: true, loseConfirmation: () => script({ delay: { 'session.update': requestTimeoutMs + 1000, 'session.switchModel': requestTimeoutMs + 1000 } }) },
    protocol: { promptMethod: 'session.prompt', resumeMethod: 'session.messages', permissionDecision: (record: RecordedRpc): boolean | undefined =>
      record.method === 'session.permission.reply' ? record.params?.decision === 'once' ? true : record.params?.decision === 'reject' ? false : undefined : undefined },
    sessions: {
      // A session starts when a server reads it: each thread's server reads its provider session once, when it opens it.
      starts: async (id: string) => { const native = await realId(id); return (await requests()).filter(record => record.method === 'session.get' && record.params?.sessionID === native).length },
      stopped: async (id: string) => { const pid = await holder(id); return pid === undefined || !running(pid) },
    },
    driver: { typeInProvider: (id: string, text: string) => action(id, { type: 'takeover', text }), completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }),
      raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }), raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      delayNextAck: async (method: string) => script({ delay: { [method]: requestTimeoutMs + 1000 } }), requests,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return opencodeFixture(root, requestTimeoutMs, session, options) } },
    cleanup: async () => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-opencode-thread-')) throw new Error('Unexpected temporary directory')
      try { await checkViolations() } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    },
  }
}

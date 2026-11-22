import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AntigravityAcpHost, type AntigravityAcpOptions } from '../../src/main/agents/antigravity'
import type { AntigravityRpc } from '../../src/main/agents/antigravityRpc'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'
import { parseProviderRecords, writeProviderAction } from './providerRecords'

export const antigravityFixtureSkips: AdapterContractSkips = {
  backgroundWork: 'Antigravity reports no work a turn leaves running over ACP; T3 reads it from agy’s own files, which this version does not.',
  restart: 'A resumed Antigravity session replays nothing, as T3 resumes it; Sotto’s event store holds the history.',
  liveSettings: 'Antigravity takes a model, effort and mode before the prompt that needs them, not in place on a live turn.',
  settingsConfirmation: 'Antigravity confirms a settings change in Sotto’s own record; there is no confirmation to lose.',
}
async function readLog(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
const running = (pid: number | undefined): boolean => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
/** How long a send waits once a test has scripted its prompt's first sign of work lost. */
export const LOST_ACK_DEADLINE_MS = 2000

/** A fixture over the fake `agy`. A test that needs a sign of work lost scripts it with `driver.delayNextAck`. */
export async function antigravityFixture(root?: string, requestTimeoutMs?: number, session: AdapterSessionOptions = {}, options: AntigravityAcpOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-antigravity-thread-'))
  const folder = root
  let promptLost = false, spawning = false
  const adapterOptions: AntigravityAcpOptions = { executable: process.execPath, executableArgs: [resolve('tests/fixtures/fakeAntigravityAgent.mjs'), folder], ...session, ...options }
  const deadline = options.requestTimeoutMs ?? requestTimeoutMs
  Object.defineProperty(adapterOptions, 'requestTimeoutMs', { enumerable: true, get: () => {
    if (spawning || !promptLost) return deadline
    promptLost = false; return LOST_ACK_DEADLINE_MS
  } })
  const adapter = new AntigravityAcpHost(folder, adapterOptions)
  const spawner = adapter as unknown as { spawn(...args: unknown[]): AntigravityRpc }
  const spawn = spawner.spawn.bind(adapter)
  spawner.spawn = (...args) => { spawning = true; try { return spawn(...args) } finally { spawning = false } }
  const checkViolations = async (): Promise<void> => { const text = await readLog(join(folder, 'violations.jsonl')); if (text) throw new Error(`Invalid Antigravity answer: ${text}`) }
  const requests = async (): Promise<RecordedRpc[]> => { await checkViolations(); return parseProviderRecords<RecordedRpc>(await readLog(join(folder, 'requests.jsonl'))) }
  const writeScript = async (value: Record<string, unknown>): Promise<void> => {
    let current: Record<string, unknown> = {}
    try { current = JSON.parse(await readFile(join(folder, 'script.json'), 'utf8')) as Record<string, unknown> } catch { /* None yet. */ }
    const staged = join(folder, `script.json.${randomUUID()}.tmp`)
    await writeFile(staged, JSON.stringify({ ...current, ...value })); await rename(staged, join(folder, 'script.json'))
  }
  const script = (value: Record<string, unknown>): Promise<void> => { promptLost = false; return writeScript(value) }
  const realId = async (id: string): Promise<string> => (JSON.parse(await readFile(join(folder, 'antigravity-threads.json'), 'utf8')) as Record<string, { antigravitySessionId: string }>)[id]!.antigravitySessionId
  const action = async (id: string, value: Record<string, unknown>): Promise<void> => { await writeProviderAction(join(folder, 'control.json'), value, { sessionId: await realId(id) }, randomUUID()) }
  const sideCalls = async () => parseProviderRecords<{ cwd: string; model: string | undefined; thinking?: string; mode?: string; material: string }>(await readLog(join(folder, 'oneshot.jsonl')))
  return {
    host: adapter, adapter, root: folder, providerId: 'antigravity' as const, projectId: 'project', modelId: 'gemini-3.8-flash', realId, script, action, requests,
    restartStatus: 'idle' as const, skips: antigravityFixtureSkips,
    settings: { snapshot: true },
    clientUpdate: { provider: 'antigravity' as const, install: async () => { await script({ cliVersion: '1.5.14' }); return '1.5.14' } },
    sideWriting: { answer: (text: string) => script({ sideAnswer: text }), calls: sideCalls },
    protocol: { promptMethod: 'session/prompt', resumeMethod: 'session/resume', permissionDecision: (record: RecordedRpc): boolean | undefined => {
      const outcome = record.result?.outcome as { outcome?: string; optionId?: string } | undefined
      return outcome?.outcome === 'cancelled' ? false : outcome?.outcome === 'selected' ? outcome.optionId === 'allow-once' ? true : outcome.optionId === 'reject-once' ? false : undefined : undefined
    } },
    sessions: {
      starts: async (id: string) => { const native = await realId(id); return (await requests()).filter(item => item.method === 'session/resume' && item.params?.sessionId === native).length },
      stopped: async (id: string) => {
        const native = await realId(id)
        const last = (await requests()).findLast(item => item.method === 'fixture/session-resident' && item.params?.sessionId === native) as (RecordedRpc & { process?: number }) | undefined
        return last !== undefined && (last.params?.resident === false || !running(last.process))
      },
    },
    driver: {
      typeInProvider: (id: string, text: string) => action(id, { type: 'takeover', text }),
      completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }),
      raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }),
      raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      delayNextAck: async (method: string): Promise<void> => {
        if (method !== 'session/prompt') throw new Error(`The Antigravity fixture cannot lose the acknowledgement of ${method}`)
        await writeScript({ dropPromptAck: true }); promptLost = true
      },
      requests,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return antigravityFixture(folder, requestTimeoutMs, session, options) },
    },
    cleanup: async () => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(folder)) !== resolve(tmpdir()) || !folder.includes('sotto-antigravity-thread-')) throw new Error('Unexpected temporary directory')
      try { await checkViolations() } finally { await rm(folder, { recursive: true, force: true }) }
    },
  }
}

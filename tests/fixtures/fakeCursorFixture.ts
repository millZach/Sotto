import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CursorAcpHost, type CursorAcpOptions } from '../../src/main/agents/cursor'
import type { CursorRpc } from '../../src/main/agents/cursorRpc'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'
import { parseProviderRecords, writeProviderAction } from './providerRecords'

export const cursorFixtureSkips: AdapterContractSkips = {
  backgroundWork: 'Cursor reports no work a turn leaves running.',
  liveSettings: 'Cursor takes a model and effort before the prompt that needs them, not in place on a live turn.',
  settingsConfirmation: 'Cursor confirms a settings change in Sotto’s own record; there is no confirmation to lose.',
}
/** A log may not exist before its first record; any other read failure is evidence, not an empty trace. */
async function readLog(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
/** Whether a process is still running; one that cannot be signalled for want of permission still is. */
const running = (pid: number | undefined): boolean => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
/** The program the adapter starts: this Node running the fake client, with the fixture's folder as its first argument. */
export const fakeCursorProgram = (root: string) => ({ executable: process.execPath, args: [resolve('tests/fixtures/fakeCursorAgent.mjs'), root] })

/**
 * How long a send waits once a test has scripted its prompt's acknowledgement lost. The fake then never shows the prompt
 * taken, so no runner, however slow, can make the evidence arrive in time or late: the short wait only decides how soon
 * the send says it is uncertain.
 */
export const LOST_ACK_DEADLINE_MS = 2000

/**
 * A fixture over the fake Cursor client. Its request deadline is the adapter's own unless a caller names one: it covers
 * the fake's process starts and every round trip, which a loaded runner stretches. A test that needs an acknowledgement
 * lost scripts it with `driver.delayNextAck` rather than shortening this.
 */
export async function cursorFixture(root?: string, requestTimeoutMs?: number, session: AdapterSessionOptions = {}, options: CursorAcpOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-cursor-thread-'))
  const folder = root
  // Only the send whose prompt was scripted lost waits the short deadline; every process, and every other send, keeps the
  // generous one. A send reads its deadline as it starts waiting for its prompt to be taken, after any process it starts.
  let promptLost = false, spawning = false
  const adapterOptions: CursorAcpOptions = { program: fakeCursorProgram(folder), configDirectory: join(folder, 'cursor-config'), ...session, ...options }
  const deadline = options.requestTimeoutMs ?? requestTimeoutMs
  Object.defineProperty(adapterOptions, 'requestTimeoutMs', { enumerable: true, get: () => {
    if (spawning || !promptLost) return deadline
    promptLost = false; return LOST_ACK_DEADLINE_MS
  } })
  const adapter = new CursorAcpHost(folder, adapterOptions)
  const spawner = adapter as unknown as { spawn(...args: unknown[]): CursorRpc }
  const spawn = spawner.spawn.bind(adapter)
  spawner.spawn = (...args) => { spawning = true; try { return spawn(...args) } finally { spawning = false } }
  const checkViolations = async (): Promise<void> => { const text = await readLog(join(folder, 'violations.jsonl')); if (text) throw new Error(`Invalid Cursor answer: ${text}`) }
  const requests = async (): Promise<RecordedRpc[]> => { await checkViolations(); return parseProviderRecords<RecordedRpc>(await readLog(join(folder, 'requests.jsonl'))) }
  const writeScript = async (value: Record<string, unknown>): Promise<void> => {
    let current: Record<string, unknown> = {}
    try { current = JSON.parse(await readFile(join(folder, 'script.json'), 'utf8')) as Record<string, unknown> } catch { /* None yet. */ }
    // Moved into place whole: a fake process starting meanwhile reads the old script or the new one, never half of either.
    const staged = join(folder, `script.json.${randomUUID()}.tmp`)
    await writeFile(staged, JSON.stringify({ ...current, ...value })); await rename(staged, join(folder, 'script.json'))
  }
  const script = (value: Record<string, unknown>): Promise<void> => { promptLost = false; return writeScript(value) }
  const realId = async (id: string): Promise<string> => (JSON.parse(await readFile(join(folder, 'cursor-threads.json'), 'utf8')) as Record<string, { cursorSessionId: string }>)[id]!.cursorSessionId
  const action = async (id: string, value: Record<string, unknown>): Promise<void> => { await writeProviderAction(join(folder, 'control.json'), value, { sessionId: await realId(id) }, randomUUID()) }
  const sideCalls = async () => parseProviderRecords<{ cwd: string; model: string | undefined; effort?: string; mode?: string; material: string }>(await readLog(join(folder, 'oneshot.jsonl')))
  return {
    host: adapter, adapter, root: folder, providerId: 'cursor' as const, projectId: 'project', modelId: 'gpt-fixture', realId, script, action, requests,
    // One process per thread: a turn ends with its process, and its thread reads idle after a restart.
    restartStatus: 'idle' as const, skips: cursorFixtureSkips,
    settings: { snapshot: true },
    clientUpdate: { provider: 'cursor' as const, install: async () => { await script({ cliVersion: '2026.10.24-01-02-03-abcdef1' }); return '2026.10.24-01-02-03-abcdef1' } },
    sideWriting: { answer: (text: string) => writeFile(join(folder, 'oneshot.json'), JSON.stringify({ text })), calls: sideCalls },
    protocol: { promptMethod: 'session/prompt', resumeMethod: 'session/load', permissionDecision: (record: RecordedRpc): boolean | undefined => {
      const outcome = record.result?.outcome as { outcome?: string; optionId?: string } | undefined
      return outcome?.outcome === 'cancelled' ? false : outcome?.outcome === 'selected' ? outcome.optionId === 'allow-once' ? true : outcome.optionId === 'reject-once' ? false : undefined : undefined
    } },
    sessions: {
      starts: async (id: string) => { const native = await realId(id); return (await requests()).filter(item => item.method === 'session/load' && item.params?.sessionId === native).length },
      // A session's process says it let the session go as its input closes. Sotto kills a process that has not exited half a
      // second after that, which on a loaded machine can come first, so a process that is gone has let its session go too.
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
      // The fake drops the next prompt's acknowledgement: it shows nothing of the prompt until the test moves the turn on.
      delayNextAck: async (method: string): Promise<void> => {
        if (method !== 'session/prompt') throw new Error(`The Cursor fixture cannot lose the acknowledgement of ${method}`)
        await writeScript({ dropPromptAck: true }); promptLost = true
      },
      requests,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return cursorFixture(folder, requestTimeoutMs, session, options) },
    },
    cleanup: async () => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(folder)) !== resolve(tmpdir()) || !folder.includes('sotto-cursor-thread-')) throw new Error('Unexpected temporary directory')
      try { await checkViolations() } finally { await rm(folder, { recursive: true, force: true }) }
    },
  }
}

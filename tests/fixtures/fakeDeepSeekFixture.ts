import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DeepSeekAcpHost, type DeepSeekAcpOptions } from '../../src/main/agents/deepseek'
import type { DeepSeekRpc } from '../../src/main/agents/deepseekRpc'
import type { OwnServer } from '../../src/shared/ownModelServers'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'
import { parseProviderRecords, writeProviderAction } from './providerRecords'

export const deepseekFixtureSkips: AdapterContractSkips = {
  backgroundWork: 'DeepSeek Harness reports no work a turn leaves running.',
  questions: 'DeepSeek Harness has no question route over ACP; the model asks in its reply (ADR-0138).',
  restart: 'A resumed DeepSeek Harness session replays nothing; Sotto’s event store holds the history (ADR-0138).',
  liveSettings: 'A permission mode is its process’s sandbox, so a mode change starts a new process by design (ADR-0138).',
  settingsConfirmation: 'DeepSeek Harness confirms a settings change in Sotto’s own record; there is no confirmation to lose.',
}
/** The one keyless server the fixture's record holds, as a test may replace it whole. */
export const FIXTURE_SERVER: OwnServer = {
  id: 'own-fixture', name: 'Fixture Server', address: 'http://127.0.0.1:9/v1', keyed: false,
  models: [
    { id: 'fixture-model', name: 'Fixture Model', context: 131072, thinking: true, images: false },
    { id: 'fixture-plain', name: 'Fixture Plain', context: 65536, thinking: false, images: false },
  ],
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

/**
 * How long a send waits once a test has scripted its prompt's first sign of work lost. The fake then shows
 * nothing of the prompt, so no runner, however slow, can make the evidence arrive in time or late.
 */
export const LOST_ACK_DEADLINE_MS = 2000

/**
 * A fixture over the fake DeepSeek Harness client. The record it is given is a private copy of the fixture's
 * servers, which a test may replace before telling the adapter the record changed. Its request deadline is the
 * adapter's own unless a caller names one; a test that needs a sign of work lost scripts it with
 * `driver.delayNextAck` rather than shortening this.
 */
export async function deepseekFixture(root?: string, requestTimeoutMs?: number, session: AdapterSessionOptions = {}, options: DeepSeekAcpOptions = {}, servers: readonly OwnServer[] = [FIXTURE_SERVER]) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-deepseek-thread-'))
  const folder = root
  let currentServers = servers
  // Only the send whose sign of work was scripted lost waits the short deadline; every process start keeps the
  // generous one. A send reads its deadline as it starts waiting, after any process it starts.
  let promptLost = false, spawning = false
  const adapterOptions: DeepSeekAcpOptions = {
    executable: process.execPath, executableArgs: [resolve('tests/fixtures/fakeDeepSeekAgent.mjs'), folder],
    homeDirectory: join(folder, 'deepseek-home'), servers: async () => currentServers, ...session, ...options,
  }
  const deadline = options.requestTimeoutMs ?? requestTimeoutMs
  Object.defineProperty(adapterOptions, 'requestTimeoutMs', { enumerable: true, get: () => {
    if (spawning || !promptLost) return deadline
    promptLost = false; return LOST_ACK_DEADLINE_MS
  } })
  const adapter = new DeepSeekAcpHost(folder, adapterOptions)
  const spawner = adapter as unknown as { spawn(...args: unknown[]): DeepSeekRpc }
  const spawn = spawner.spawn.bind(adapter)
  spawner.spawn = (...args) => { spawning = true; try { return spawn(...args) } finally { spawning = false } }
  const checkViolations = async (): Promise<void> => { const text = await readLog(join(folder, 'violations.jsonl')); if (text) throw new Error(`Invalid DeepSeek Harness answer: ${text}`) }
  const requests = async (): Promise<RecordedRpc[]> => { await checkViolations(); return parseProviderRecords<RecordedRpc>(await readLog(join(folder, 'requests.jsonl'))) }
  const writeScript = async (value: Record<string, unknown>): Promise<void> => {
    let current: Record<string, unknown> = {}
    try { current = JSON.parse(await readFile(join(folder, 'script.json'), 'utf8')) as Record<string, unknown> } catch { /* None yet. */ }
    // Moved into place whole: a fake process starting meanwhile reads the old script or the new one, never half of either.
    const staged = join(folder, `script.json.${randomUUID()}.tmp`)
    await writeFile(staged, JSON.stringify({ ...current, ...value })); await rename(staged, join(folder, 'script.json'))
  }
  const script = (value: Record<string, unknown>): Promise<void> => { promptLost = false; return writeScript(value) }
  const realId = async (id: string): Promise<string> => (JSON.parse(await readFile(join(folder, 'deepseek-threads.json'), 'utf8')) as Record<string, { deepseekSessionId: string }>)[id]!.deepseekSessionId
  const action = async (id: string, value: Record<string, unknown>): Promise<void> => { await writeProviderAction(join(folder, 'control.json'), value, { sessionId: await realId(id) }, randomUUID()) }
  const setServers = (next: readonly OwnServer[]): void => { currentServers = next; adapter.ownServersChanged() }
  return {
    host: adapter, adapter, root: folder, providerId: 'deepseek' as const, projectId: 'project', modelId: 'own-fixture/fixture-model', realId, script, action, requests, setServers,
    // One process per thread: a turn ends with its process, and its thread reads idle after a restart.
    restartStatus: 'idle' as const, skips: deepseekFixtureSkips,
    settings: { snapshot: true },
    clientUpdate: { provider: 'deepseek' as const, install: async () => { await script({ cliVersion: '0.2.1-rc.3' }); return '0.2.1-rc.3' } },
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
      // No question reaches the client on this surface; the contract skips its question case for this provider.
      raiseQuestion: async () => { throw new Error('DeepSeek Harness has no question route to raise.') },
      raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      // The fake drops the next prompt's first sign of work: it shows nothing until the test moves the turn on.
      delayNextAck: async (method: string): Promise<void> => {
        if (method !== 'session/prompt') throw new Error(`The DeepSeek Harness fixture cannot lose the acknowledgement of ${method}`)
        await writeScript({ dropPromptAck: true }); promptLost = true
      },
      requests,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return deepseekFixture(folder, requestTimeoutMs, session, options, currentServers) },
    },
    cleanup: async () => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(folder)) !== resolve(tmpdir()) || !folder.includes('sotto-deepseek-thread-')) throw new Error('Unexpected temporary directory')
      try { await checkViolations() } finally { await rm(folder, { recursive: true, force: true }) }
    },
  }
}

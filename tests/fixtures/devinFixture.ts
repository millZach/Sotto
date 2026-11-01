import { parseProviderRecords } from './providerRecords'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DevinAcpHost, type DevinAcpOptions } from '../../src/main/agents/devin'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'

export const devinFixtureSkips: AdapterContractSkips = {
  backgroundWork: 'The fixture has no background-work driver.',
  liveSettings: 'The fixture must apply settings to a live provider session.',
  settingsConfirmation: 'The fixture cannot lose a settings-change confirmation.',
  clientUpdate: 'The fixture must install a client update and the adapter must accept it.',
}

/** What a test of the send path changes about how the adapter waits. */
export interface DevinPaceOptions {
  /**
   * How long a send waits on the thread's own stream before reading the replay. The fake streams nothing after a
   * prompt unless a test scripts it, so the default is 0 and a send reads its replay at once; a test of the stream as
   * evidence sets it past its deadline.
   */
  acceptanceGraceMs?: number
  /** Leave the adapter's own production read pace, ignoring `pollIntervalMs`. */
  productionPace?: boolean
}

/**
 * How long a send waits once a test has scripted its prompt lost. Devin sends no acknowledgement: a prompt is uncertain
 * when nothing has shown it taken by the request deadline, so the test of that waits the deadline out. A short one is
 * safe there: a slow runner can only delay the evidence the deadline waits for.
 */
const LOST_PROMPT_DEADLINE_MS = 2000

/**
 * A send's request deadline covers the integration checks, the process starts and a replay read in a process of its own,
 * which a loaded two-core runner stretches past five seconds (#1073, #1110). The default is the adapter's own, and a
 * test that needs a prompt lost scripts it with `driver.delayNextAck` instead of shortening this.
 */
export async function devinFixture(root?: string, requestTimeoutMs = 15_000, pollIntervalMs = 20, session: AdapterSessionOptions = {}, knownSessions = new Map<string, Set<string>>(),
  pace: DevinPaceOptions = {}, extra: Pick<DevinAcpOptions, 'captureMedia'> = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-devin-thread-'))
  const options: DevinAcpOptions = { executable: process.execPath,
    nativeConfigDirectory: join(root, 'native-config'), args: [resolve('tests/fixtures/fakeDevinAgent.mjs'), root], requestTimeoutMs, ...(pace.productionPace ? {} : { pollIntervalMs }),
    acceptanceGraceMs: pace.acceptanceGraceMs ?? 0, ...session, ...extra }
  const adapter = new DevinAcpHost(root, options)
  const checkViolations = async (): Promise<void> => {
    const text = await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => '')
    if (text) throw new Error(`Invalid Devin fixture traffic: ${text}`)
  }
  const recorded = async (): Promise<RecordedRpc[]> => parseProviderRecords(await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => ''))
  const requests = async (): Promise<RecordedRpc[]> => {
    await checkViolations()
    return recorded()
  }
  let live = true
  // Prompts the fake has received; a record still being written counts once it is whole.
  const promptsReceived = (): Promise<number> => recorded().then(records => records.filter(record => record.method === 'session/prompt').length, () => -1)
  const realId = async (id: string): Promise<string> => {
    const native = JSON.parse(await readFile(join(root, 'devin-threads.json'), 'utf8'))[id].devinSessionId as string
    const known = knownSessions.get(id) ?? new Set<string>()
    known.add(native); knownSessions.set(id, known)
    return native
  }
  const script = (value: unknown): Promise<void> => writeFile(join(root, 'script.json'), JSON.stringify(value))
  const action = async (id: string, value: Record<string, unknown>): Promise<void> => {
    const native = await realId(id)
    await writeFile(join(root, `control-${native}.json`), JSON.stringify({ id: randomUUID(), ...value }))
  }
  const typeInProvider = async (id: string, text: string): Promise<void> => {
    const native = await realId(id)
    const file = join(root, `native-${native}.json`)
    const history = JSON.parse(await readFile(file, 'utf8'))
    history.messages.push({ id: randomUUID(), role: 'user', text, timestamp: new Date().toISOString() })
    await writeFile(file, JSON.stringify(history))
  }
  return { host: adapter, adapter, root, providerId: 'devin' as const, projectId: 'project', modelId: 'fixture-model', realId, script, action, skips: devinFixtureSkips,
    restartStatus: 'idle' as const,
    // A permission change comes back with the snapshot that records it (#318).
    settings: { snapshot: true },
    protocol: { promptMethod: 'session/prompt', resumeMethod: 'session/load', permissionDecision: (record: RecordedRpc): boolean | undefined => {
      const outcome = record.result?.outcome as { outcome?: string; optionId?: string } | undefined
      return outcome?.outcome === 'cancelled' ? false : outcome?.outcome === 'selected'
        ? outcome.optionId === 'allow-once' ? true : outcome.optionId === 'deny-once' ? false : undefined : undefined
    } },
    sessions: {
      starts: async (id: string): Promise<number> => {
        await realId(id)
        return (await requests()).filter(record => record.method === 'fixture/ownership-started' && knownSessions.get(id)!.has(String(record.params?.sessionId))).length
      },
      stopped: async (id: string): Promise<boolean> => {
        const native = await realId(id)
        const pid = JSON.parse(await readFile(join(root, `owner-${native}.json`), 'utf8').catch(() => 'null')) as number | null
        if (!pid) return true
        try { process.kill(pid, 0); return false } catch { return true }
      },
    },
    driver: { typeInProvider, completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }),
      raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }),
      raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      delayNextAck: async (method: string): Promise<void> => {
        if (method !== 'session/prompt') throw new Error('Only prompt acceptance can be delayed by this script')
        // The adapter reads its deadline when a send writes its prompt, and when it starts a process. The short one
        // lasts until the fake receives the prompt, by which time the send has taken it, so the replay reads and any
        // process started after the prompt wait the generous one; one the send starts before its prompt waits the
        // short one. The replay hides the prompt until a second after the short deadline, which starts before Devin
        // receives the prompt.
        let before = await promptsReceived()
        while (before < 0) before = await promptsReceived()
        options.requestTimeoutMs = Math.min(requestTimeoutMs, LOST_PROMPT_DEADLINE_MS)
        await script({ delayPrompt: options.requestTimeoutMs + 1000 })
        void (async () => {
          while (live && (await promptsReceived()) <= before) await new Promise(resolve => setTimeout(resolve, 20))
          options.requestTimeoutMs = requestTimeoutMs
        })()
      }, requests,
      restart: async () => { live = false; adapter.disconnect(); await adapter.closed(); return devinFixture(root, requestTimeoutMs, pollIntervalMs, session, knownSessions, pace, extra) },
    },
    cleanup: async (): Promise<void> => {
      live = false; adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-devin-thread-')) throw new Error('Unexpected temporary directory')
      try { await checkViolations() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DevinAcpHost } from '../../src/main/agents/devin'
import type { RecordedRpc } from './codexFixture'
import type { AdapterSessionOptions } from '../integration/adapterContract'

/** Every request deadline includes process startup; lost evidence is scripted, never inferred from a short timer. */
export async function devinFixture(root?: string, requestTimeoutMs = 2000, pollIntervalMs = 20, session: AdapterSessionOptions = {}, knownSessions = new Map<string, Set<string>>()) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-devin-thread-'))
  const adapter = new DevinAcpHost(root, { executable: process.execPath,
    nativeConfigDirectory: join(root, 'native-config'), args: [resolve('tests/fixtures/fakeDevinAgent.mjs'), root], requestTimeoutMs, pollIntervalMs, ...session })
  const checkViolations = async (): Promise<void> => {
    const text = await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => '')
    if (text) throw new Error(`Invalid Devin fixture traffic: ${text}`)
  }
  const requests = async (): Promise<RecordedRpc[]> => {
    await checkViolations()
    return (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
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
  return { host: adapter, adapter, root, projectId: 'project', modelId: 'fixture-model', realId, script, action,
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
        await script({ delayPrompt: requestTimeoutMs + 1000 })
      }, requests,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return devinFixture(root, requestTimeoutMs, pollIntervalMs, session, knownSessions) },
    },
    cleanup: async (): Promise<void> => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-devin-thread-')) throw new Error('Unexpected temporary directory')
      try { await checkViolations() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

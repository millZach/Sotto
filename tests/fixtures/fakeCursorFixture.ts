import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CursorAcpHost, type CursorAcpOptions } from '../../src/main/agents/cursor'
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
/** The program the adapter starts: this Node running the fake client, with the fixture's folder as its first argument. */
export const fakeCursorProgram = (root: string) => ({ executable: process.execPath, args: [resolve('tests/fixtures/fakeCursorAgent.mjs'), root] })

export async function cursorFixture(root?: string, requestTimeoutMs = 2000, session: AdapterSessionOptions = {}, options: CursorAcpOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-cursor-thread-'))
  const folder = root
  const adapter = new CursorAcpHost(folder, { program: fakeCursorProgram(folder), configDirectory: join(folder, 'cursor-config'), requestTimeoutMs, ...session, ...options })
  const checkViolations = async (): Promise<void> => { const text = await readLog(join(folder, 'violations.jsonl')); if (text) throw new Error(`Invalid Cursor answer: ${text}`) }
  const requests = async (): Promise<RecordedRpc[]> => { await checkViolations(); return parseProviderRecords<RecordedRpc>(await readLog(join(folder, 'requests.jsonl'))) }
  const script = async (value: Record<string, unknown>): Promise<void> => {
    let current: Record<string, unknown> = {}
    try { current = JSON.parse(await readFile(join(folder, 'script.json'), 'utf8')) as Record<string, unknown> } catch { /* None yet. */ }
    await writeFile(join(folder, 'script.json'), JSON.stringify({ ...current, ...value }))
  }
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
      stopped: async (id: string) => { const native = await realId(id); return (await requests()).findLast(item => item.method === 'fixture/session-resident' && item.params?.sessionId === native)?.params?.resident === false },
    },
    driver: {
      typeInProvider: (id: string, text: string) => action(id, { type: 'takeover', text }),
      completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }),
      raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }),
      raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      delayNextAck: async () => script({ delayPrompt: requestTimeoutMs + 1000 }),
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

import { parseProviderRecords, writeProviderAction } from './providerRecords'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MuseMspHost, type MuseMspOptions } from '../../src/main/agents/muse'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'

export const museFixtureSkips: AdapterContractSkips = {
  backgroundWork: 'The fixture has no background-work driver, and the adapter reports none.',
  liveSettings: 'The fixture must apply settings to a live provider session.',
  settingsConfirmation: 'The fixture cannot lose a settings-change confirmation.',
}
/** A log may not exist before its first event; any other read failure is evidence, not an empty trace. */
async function readLog(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
/**
 * What Sotto's side calls were given, from the memory-only hosts' own record: a call is the session a
 * `turn/start` ran on (the connect probe starts sessions there too, and never a turn).
 */
async function sideCalls(root: string): Promise<{ cwd: string; model: string | undefined; material: string }[]> {
  const frames = parseProviderRecords<{ method?: string; params?: Record<string, unknown>; process?: number }>(await readLog(join(root, 'oneshot.jsonl')))
  return frames.filter(frame => frame.method === 'turn/start').map(turn => {
    const before = frames.slice(0, frames.indexOf(turn)).filter(frame => frame.process === turn.process)
    const start = before.findLast(frame => frame.method === 'session/start')
    const setModel = before.findLast(frame => frame.method === 'session/setModel')
    return {
      cwd: String(start?.params?.workspaceRoot),
      model: (setModel?.params?.model as { modelId?: string } | undefined)?.modelId ?? start?.params?.modelId as string | undefined,
      material: ((turn.params?.input as { text?: string }[] | undefined) ?? []).map(part => part.text ?? '').join(''),
    }
  })
}
// The deadline also covers the fake agent's process start; see the note on claudeFixture.
export async function museFixture(root?: string, requestTimeoutMs = 2000, session: AdapterSessionOptions = {}, options: MuseMspOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-muse-thread-'))
  const adapter = new MuseMspHost(root, { executable: process.execPath, args: [resolve('tests/fixtures/fakeMuseAgent.mjs'), root], requestTimeoutMs, ...session, ...options })
  const checkViolations = async () => { const text = await readLog(join(root, 'violations.jsonl')); if (text) throw new Error(`Invalid Muse reply: ${text}`) }
  const requests = async (): Promise<RecordedRpc[]> => {
    await checkViolations()
    return parseProviderRecords<RecordedRpc>(await readLog(join(root, 'requests.jsonl')))
  }
  const script = (value: unknown) => writeFile(join(root, 'script.json'), JSON.stringify(value))
  const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root, 'muse-threads.json'), 'utf8'))[id].museSessionId
  // Each thread session has its own fake host. The one holding the session takes the command.
  const action = async (id: string, value: Record<string, unknown>) => { await writeProviderAction(join(root, 'control.json'), value, { sessionId: await realId(id) }, randomUUID()) }
  return { host: adapter, adapter, root, projectId: 'project', modelId: 'fixture-model', realId, script, action, restartStatus: 'idle' as const, skips: museFixtureSkips,
    // A settings change comes back with the snapshot the adapter itself confirmed (#318).
    settings: { snapshot: true },
    // Every Muse process started from now on reports the newer client.
    clientUpdate: { provider: 'muse' as const, install: async () => { await writeFile(join(root, 'script.json'), JSON.stringify({ cliVersion: '1.2.0' })); return '1.2.0' } },
    sideWriting: { answer: (text: string) => writeFile(join(root, 'oneshot.json'), JSON.stringify({ text })), calls: () => sideCalls(root) },
    protocol: { promptMethod: 'turn/start', resumeMethod: 'session/resume', permissionDecision: (record: RecordedRpc): boolean | undefined =>
      record.method === 'approval/decide' ? record.params?.choiceId === 'yes' : undefined },
    sessions: {
      starts: async (id: string) => { const native = await realId(id); return (await requests()).filter(record => record.method === 'session/resume' && record.params?.sessionId === native).length },
      stopped: async (id: string) => { const native = await realId(id); return (await requests()).findLast(record => record.method === 'fixture/session-resident' && record.params?.sessionId === native)?.params?.resident === false },
    },
    driver: { typeInProvider: (id: string, text: string) => action(id, { type: 'takeover', text }), completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }), raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }), raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }), delayNextAck: async () => script({ delayTurnMs: requestTimeoutMs + 1000 }), requests,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return museFixture(root, requestTimeoutMs, session, options) } },
    cleanup: async () => { adapter.disconnect(); await adapter.closed(); if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-muse-thread-')) throw new Error('Unexpected temporary directory'); try { await checkViolations() } finally { await rm(root, { recursive: true, force: true }) } },
  }
}

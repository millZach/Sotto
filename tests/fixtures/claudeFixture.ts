import { parseProviderRecords, writeProviderAction, providerArgument as flag } from './providerRecords'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ClaudeStreamJsonHost, type ClaudeStreamJsonHostOptions } from '../../src/main/agents/claude'
import type { AdapterContractSkips, AdapterFixture, AdapterSessionOptions, RecordedRpc } from './adapterFixture'

export const claudeFixtureSkips: AdapterContractSkips = {}

export { storedClaudeOrigins } from './claudeOrigins'

/** What the fake client's one-shot mode recorded for each of Sotto's side calls (ADR-0026). */
async function oneShots(root: string): Promise<Record<string, unknown>[]> {
  return parseProviderRecords<Record<string, unknown>>(await readFile(join(root, 'oneshot.jsonl'), 'utf8').catch(() => ''))
}

// The acknowledgement deadline also covers the fake CLI's process start, which a loaded two-core runner
// stretches past a second. Tests that need a lost acknowledgement script one instead of shortening this.
export async function claudeFixture(root?: string, requestTimeoutMs = 2000, environment?: NodeJS.ProcessEnv, session: AdapterSessionOptions & Pick<ClaudeStreamJsonHostOptions, 'logEvent' | 'pollIntervalMs'> = {}): Promise<AdapterFixture & { adapter: ClaudeStreamJsonHost; liveSettings: NonNullable<AdapterFixture['liveSettings']>; action(id: string, value: Record<string, unknown>): Promise<void>; realId(id: string): Promise<string> }> {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-claude-'))
  const adapter = new ClaudeStreamJsonHost({ userDataPath: root, executable: process.execPath, args: [resolve('tests/fixtures/fakeClaudeThread.mjs'), root], claudeHome: join(root, 'home'), requestTimeoutMs, pollIntervalMs: 15, ...(environment ? { environment } : {}), ...session })
  const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root, 'claude-threads.json'), 'utf8'))[id].sessionId
  // The fake CLI holds one scripted action at a time, so a second written before it read the first would replace it.
  const action = async (id: string, value: Record<string, unknown>) => {
    const control = join(root, `control-${await realId(id)}.json`)
    for (const deadline = Date.now() + 10_000; await stat(control).then(() => true, () => false);) {
      if (Date.now() > deadline) throw new Error('The fake Claude CLI never read its previous scripted action.')
      await new Promise(done => setTimeout(done, 5))
    }
    await writeProviderAction(control, value)
  }
  const check = async () => { const violations = await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => ''); if (violations) throw new Error(violations) }
  const records = async (): Promise<RecordedRpc[]> => { await check(); return parseProviderRecords<RecordedRpc>(await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')) }
  const liveSettings: NonNullable<AdapterFixture['liveSettings']> = {
    refuse: () => writeFile(join(root, 'settings-script.json'), JSON.stringify({ refuse: true })),
    silence: () => writeFile(join(root, 'settings-script.json'), JSON.stringify({ silent: true })),
    answer: () => rm(join(root, 'settings-script.json'), { force: true }),
    effective: async id => {
      const current = JSON.parse(await readFile(join(root, `settings-${await realId(id)}.json`), 'utf8')) as { model: string; effort: string | null; mode: string; pid: number }
      const modes: Record<string, string> = { default: 'approval-required', acceptEdits: 'auto-accept-edits', auto: 'auto', bypassPermissions: 'full-access' }
      return { process: current.pid, modelId: current.model, ...(current.effort ? { reasoningEffort: current.effort } : {}), runtimeMode: modes[current.mode] ?? current.mode }
    },
  }
  return { root, adapter, host: adapter, projectId: 'project', modelId: 'fixture-model', realId, action, skips: claudeFixtureSkips,
    protocol: { promptMethod: 'user', resumeMethod: 'resume', permissionDecision: (record: RecordedRpc) => {
      const frame = record.params?.frame as { response?: { response?: { behavior?: string } } } | undefined
      const behavior = frame?.response?.response?.behavior
      return behavior === 'allow' ? true : behavior === 'deny' ? false : undefined
    } }, restartStatus: 'idle',
    sideWriting: {
      answer: text => writeFile(join(root, 'oneshot.json'), JSON.stringify({ text })),
      calls: async () => (await oneShots(root)).map(call => ({ cwd: String(call.cwd), model: flag(call.args, '--model'), material: String(call.input) })),
    },
    liveSettings,
    // A settings change comes back with the snapshot it produced, whether the running CLI took it or a restart
    // did (#317, #318); a CLI that never answers the settings request leaves it uncertain.
    settings: { snapshot: true, loseConfirmation: liveSettings.silence },
    // The fake answers `--version` from version.txt, and a CLI names the version it started as.
    clientUpdate: { provider: 'claude', install: async () => { await writeFile(join(root, 'version.txt'), '2.1.2'); return '2.1.2' } },
    sessions: {
      // One CLI per thread: count launches, but inspect the current child's ownership marker for liveness.
      starts: async id => {
        const native = await realId(id)
        return (await records()).filter(record => ['launch', 'resume'].includes(record.method ?? '')
          && (record.params?.frame as { args?: string[] } | undefined)?.args?.includes(native)).length
      },
      stopped: async id => {
        const native = await realId(id)
        let pid: number
        try { pid = Number(await readFile(join(root, `alive-${native}.json`), 'utf8')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
        try { process.kill(pid, 0); return false }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
      },
    },
    driver: {
      typeInProvider: async (id, text) => {
        const session = await realId(id); const folder = join(root, 'home', 'projects', root.replace(/[^a-zA-Z0-9]/gu, '-'))
        await mkdir(folder, { recursive: true }); await appendFile(join(folder, `${session}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n')
        await adapter.pollSessionLogs()
      },
      completeTurn: (id, text) => action(id, { type: 'complete', text }),
      backgroundWork: {
        completeLeaving: (id, text, description) => action(id, { type: 'complete', text, background: { taskId: 'native-background-agent', description } }),
        end: id => action(id, { type: 'raw', frame: { type: 'system', subtype: 'task_notification', task_id: 'native-background-agent', status: 'completed', output_file: '', summary: 'done' } }),
      },
      raiseQuestion: (id, text) => action(id, { type: 'question', text }),
      raisePermission: (id, text) => action(id, { type: 'permission', text }),
      delayNextAck: async () => { await writeFile(join(root, 'script.json'), JSON.stringify({ delay: requestTimeoutMs + 1000 })) },
      requests: records,
      restart: async () => { adapter.disconnect(); await adapter.closed(); return claudeFixture(root, requestTimeoutMs, environment, session) },
    },
    cleanup: async () => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-')) throw new Error('Unexpected temporary test directory')
      try { await check() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ClaudeStreamJsonHost, type ClaudeStreamJsonHostOptions } from '../../src/main/agents/claude'
import type { RecordedRpc } from './codexFixture'
import type { AdapterFixture, AdapterSessionOptions } from '../integration/adapterContract'

/** What the fake client's one-shot mode recorded for each of Sotto's side calls (ADR-0026). */
async function oneShots(root: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(root, 'oneshot.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}
const flag = (args: unknown, name: string): string | undefined => { const list = args as string[]; return list.includes(name) ? list[list.indexOf(name) + 1] : undefined }

// The acknowledgement deadline also covers the fake CLI's process start, which a loaded two-core runner
// stretches past a second. Tests that need a lost acknowledgement script one instead of shortening this.
export async function claudeFixture(root?: string, requestTimeoutMs = 2000, environment?: NodeJS.ProcessEnv, session: AdapterSessionOptions & Pick<ClaudeStreamJsonHostOptions, 'logEvent'> = {}): Promise<AdapterFixture & { adapter: ClaudeStreamJsonHost; liveSettings: NonNullable<AdapterFixture['liveSettings']>; action(id: string, value: Record<string, unknown>): Promise<void>; realId(id: string): Promise<string> }> {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-claude-'))
  const adapter = new ClaudeStreamJsonHost({ userDataPath: root, executable: process.execPath, args: [resolve('tests/fixtures/fakeClaudeThread.mjs'), root], claudeHome: join(root, 'home'), requestTimeoutMs, pollIntervalMs: 15, ...(environment ? { environment } : {}), ...session })
  const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root, 'claude-threads.json'), 'utf8'))[id].sessionId
  const action = async (id: string, value: Record<string, unknown>) => { await writeFile(join(root, `control-${await realId(id)}.json`), JSON.stringify({ id: randomUUID(), ...value })) }
  const check = async () => { const violations = await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => ''); if (violations) throw new Error(violations) }
  const records = async (): Promise<RecordedRpc[]> => { await check(); return (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedRpc) }
  return { root, adapter, host: adapter, projectId: 'project', modelId: 'fixture-model', realId, action,
    protocol: { promptMethod: 'user', resumeMethod: 'resume', permissionDecision: (record: RecordedRpc) => {
      const frame = record.params?.frame as { response?: { response?: { behavior?: string } } } | undefined
      const behavior = frame?.response?.response?.behavior
      return behavior === 'allow' ? true : behavior === 'deny' ? false : undefined
    } }, restartStatus: 'idle',
    sideWriting: {
      answer: text => writeFile(join(root, 'oneshot.json'), JSON.stringify({ text })),
      calls: async () => (await oneShots(root)).map(call => ({ cwd: String(call.cwd), model: flag(call.args, '--model'), material: String(call.input) })),
    },
    liveSettings: {
      refuse: () => writeFile(join(root, 'settings-script.json'), JSON.stringify({ refuse: true })),
      silence: () => writeFile(join(root, 'settings-script.json'), JSON.stringify({ silent: true })),
      answer: () => rm(join(root, 'settings-script.json'), { force: true }),
      effective: async id => {
        const current = JSON.parse(await readFile(join(root, `settings-${await realId(id)}.json`), 'utf8')) as { model: string; effort: string | null; mode: string; pid: number }
        const modes: Record<string, string> = { default: 'approval-required', acceptEdits: 'auto-accept-edits', auto: 'auto', bypassPermissions: 'full-access' }
        return { process: current.pid, modelId: current.model, ...(current.effort ? { reasoningEffort: current.effort } : {}), runtimeMode: modes[current.mode] ?? current.mode }
      },
    },
    sessions: {
      // One CLI per thread: a launch or a resume is a session start, and the child records its own exit.
      starts: async id => {
        const native = await realId(id)
        return (await records()).filter(record => ['launch', 'resume'].includes(record.method ?? '')
          && (record.params?.frame as { args?: string[] } | undefined)?.args?.includes(native)).length
      },
      stopped: async id => {
        const native = await realId(id)
        return (await records()).some(record => record.method === 'exit' && (record.params?.frame as { session?: string } | undefined)?.session === native)
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

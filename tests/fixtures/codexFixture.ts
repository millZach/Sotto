import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import type { AgentHost } from '../../src/main/agents/host'
import type { AdapterSessionOptions } from '../integration/adapterContract'

export function rolloutLine(ordinal: number, payload: unknown, type = 'event_msg'): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), ordinal, type, payload }) + '\n'
}
/** What the fake client's one-shot mode recorded for each of Sotto's side calls (ADR-0026). */
async function oneShots(root: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(root, 'oneshot.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}
const flag = (args: unknown, name: string): string | undefined => { const list = args as string[]; return list.includes(name) ? list[list.indexOf(name) + 1] : undefined }
export interface RecordedRpc { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }
// The deadline also covers the fake app server's process start; see the note on claudeFixture.
export async function codexFixture(root?: string, wrapped = false, requestTimeoutMs = 2000, session: AdapterSessionOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-codex-'))
  const adapter = new CodexAppServerHost({ userDataPath: root, executable: process.execPath,
    args: [resolve('tests/fixtures/fakeCodexAppServer.mjs'), root], codexHome: join(root, 'home'), requestTimeoutMs, pollIntervalMs: 15, ...session })
  const registry = new ThreadRegistry(root)
  const host: AgentHost = wrapped ? new SottoThreadHost('codex', adapter, registry) : adapter
  const script = (value: unknown) => writeFile(join(root, 'script.json'), JSON.stringify(value))
  const checkViolations = async (): Promise<void> => {
    const lines = await readFile(join(root, 'violations.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '' })
    if (lines) throw new Error(lines.trim().split('\n').map(line => {
      const violation = JSON.parse(line) as { method: string; reason: string }
      return `Invalid Codex reply for ${violation.method}: ${violation.reason}`
    }).join('\n'))
  }
  const requests = async (): Promise<RecordedRpc[]> => {
    await checkViolations()
    return (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  const realId = async (sessionId: string): Promise<string> => {
    const aliases = JSON.parse(await readFile(join(root, 'codex-threads.json'), 'utf8'))
    return aliases[wrapped ? registry.byThread(sessionId)!.sessionId : sessionId].codexThreadId
  }
  const action = async (sessionId: string, value: Record<string, unknown>) => {
    await writeFile(join(root, 'control.json'), JSON.stringify({ id: randomUUID(), threadId: await realId(sessionId), ...value }))
  }
  const fixture = { root, adapter, registry, host, projectId: 'project', modelId: 'fixture-model', script, realId,
    sideWriting: {
      answer: (text: string) => writeFile(join(root, 'oneshot.json'), JSON.stringify({ text })),
      calls: async () => (await oneShots(root)).map(call => ({ cwd: String(call.cwd), model: flag(call.args, '--model'), material: String(call.input) })),
    },
    driver: {
      typeInProvider: async (id: string, text: string) => {
        const codexThreadId = await realId(id)
        const folder = join(root, 'home', 'sessions', '2026', '09', '10'); await mkdir(folder, { recursive: true })
        const path = join(folder, `rollout-2026-09-10-${codexThreadId}.jsonl`)
        await writeFile(path, rolloutLine(0, { id: codexThreadId }, 'session_meta'), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
        await appendFile(path, rolloutLine(Date.now(), { type: 'item_completed', item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] } }))
        await adapter.pollSessionLogs()
      },
      completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }),
      raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }),
      raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      delayNextAck: (method: string) => script({ delay: { method, ms: requestTimeoutMs + 1000 }, suppressNotifications: true }),
      requests,
      restart: async () => { host.disconnect(); await adapter.closed(); return codexFixture(root, wrapped, requestTimeoutMs, session) },
    },
    sessions: {
      // One app-server child serves every thread; a session start is this thread's own resume.
      starts: async (id: string) => {
        const codexThreadId = await realId(id)
        return (await requests()).filter(record => record.method === 'thread/resume' && record.params?.threadId === codexThreadId).length
      },
      stopped: async (id: string) => !adapter.resumedThreads().includes(wrapped ? registry.byThread(id)!.sessionId : id),
    },
    action,
    cleanup: async () => {
      host.disconnect(); await adapter.closed(); await registry.flush()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-')) throw new Error('Unexpected temporary test directory')
      try { await checkViolations() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
  return fixture
}

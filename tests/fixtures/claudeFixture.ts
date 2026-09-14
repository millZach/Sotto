import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import type { RecordedRpc } from './codexFixture'
import type { AdapterFixture } from '../integration/adapterContract'

export async function claudeFixture(root?: string, requestTimeoutMs = 150, environment?: NodeJS.ProcessEnv): Promise<AdapterFixture & { adapter: ClaudeStreamJsonHost; action(id: string, value: Record<string, unknown>): Promise<void>; realId(id: string): Promise<string> }> {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-claude-'))
  const adapter = new ClaudeStreamJsonHost({ userDataPath: root, executable: process.execPath, args: [resolve('tests/fixtures/fakeClaudeThread.mjs'), root], claudeHome: join(root, 'home'), requestTimeoutMs, pollIntervalMs: 15, ...(environment ? { environment } : {}) })
  const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root, 'claude-threads.json'), 'utf8'))[id].sessionId
  const action = async (id: string, value: Record<string, unknown>) => { await writeFile(join(root, `control-${await realId(id)}.json`), JSON.stringify({ id: randomUUID(), ...value })) }
  const check = async () => { const violations = await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => ''); if (violations) throw new Error(violations) }
  return { root, adapter, host: adapter, projectId: 'project', modelId: 'fixture-model', realId, action,
    protocol: { promptMethod: 'user', resumeMethod: 'resume', permissionDecision: (record: RecordedRpc) => {
      const frame = record.params?.frame as { response?: { response?: { behavior?: string } } } | undefined
      const behavior = frame?.response?.response?.behavior
      return behavior === 'allow' ? true : behavior === 'deny' ? false : undefined
    } }, restartStatus: 'idle',
    driver: {
      typeInProvider: async (id, text) => {
        const session = await realId(id); const folder = join(root, 'home', 'projects', root.replace(/[^a-zA-Z0-9]/gu, '-'))
        await mkdir(folder, { recursive: true }); await appendFile(join(folder, `${session}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n')
        await adapter.pollSessionLogs()
      },
      completeTurn: (id, text) => action(id, { type: 'complete', text }),
      raiseQuestion: (id, text) => action(id, { type: 'question', text }),
      raisePermission: (id, text) => action(id, { type: 'permission', text }),
      delayNextAck: async () => { await writeFile(join(root, 'script.json'), JSON.stringify({ delay: Math.max(400, requestTimeoutMs * 2) })) },
      requests: async () => { await check(); return (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedRpc) },
      restart: async () => { adapter.disconnect(); await adapter.closed(); return claudeFixture(root, requestTimeoutMs) },
    },
    cleanup: async () => {
      adapter.disconnect(); await adapter.closed()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-')) throw new Error('Unexpected temporary test directory')
      try { await check() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

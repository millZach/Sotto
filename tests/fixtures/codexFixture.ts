import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import type { AgentHost } from '../../src/main/agents/host'

export const connection = { endpoint: 'ignored', credential: 'ignored' }
export interface RecordedRpc { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }
export async function codexFixture(root?: string, wrapped = false, requestTimeoutMs = 1000) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-codex-'))
  const directory = root
  const adapter = new CodexAppServerHost({ userDataPath: directory, executable: process.execPath,
    args: [resolve('tests/fixtures/fakeCodexAppServer.mjs'), directory], codexHome: join(directory, 'home'), requestTimeoutMs, pollIntervalMs: 15 })
  const registry = new ThreadRegistry(directory)
  const host: AgentHost = wrapped ? new SottoThreadHost('codex', adapter, registry) : adapter
  const script = (value: unknown) => writeFile(join(directory, 'script.json'), JSON.stringify(value))
  const requests = async (): Promise<RecordedRpc[]> => (await readFile(join(directory, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const realId = async (sessionId: string): Promise<string> => {
    const aliases = JSON.parse(await readFile(join(directory, 'codex-threads.json'), 'utf8'))
    return aliases[wrapped ? registry.byThread(sessionId)!.sessionId : sessionId].codexThreadId
  }
  const action = async (sessionId: string, value: Record<string, unknown>) => {
    await writeFile(join(directory, 'control.json'), JSON.stringify({ id: randomUUID(), threadId: await realId(sessionId), ...value }))
  }
  const fixture = { root: directory, adapter, registry, host, connection, projectId: 'project', modelId: 'fixture-model', script, realId,
    driver: {
      completeTurn: (id: string, text: string) => action(id, { type: 'complete', text }),
      raiseQuestion: (id: string, text: string) => action(id, { type: 'question', text }),
      raisePermission: (id: string, text: string) => action(id, { type: 'permission', text }),
      delayNextAck: (method: string) => script({ delay: { method, ms: 400 }, suppressNotifications: true }),
      requests,
      restart: async () => { host.disconnect(); await adapter.closed(); return codexFixture(directory, wrapped, requestTimeoutMs) },
    },
    action,
    cleanup: async () => {
      host.disconnect(); await adapter.closed(); await registry.flush()
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-codex-')) throw new Error('Unexpected temporary test directory')
      await rm(directory, { recursive: true, force: true })
    },
  }
  return fixture
}

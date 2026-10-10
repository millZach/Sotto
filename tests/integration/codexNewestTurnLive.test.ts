// @vitest-environment node
/**
 * What the newest-turn check (#324) rests on, against the installed Codex app-server. It runs in a throwaway
 * `CODEX_HOME` and makes no model call: a legacy thread is started, one injected message pair makes its session
 * file exist, and filler turns are written into that file the way Codex writes a turn. It checks that
 * `thread/turns/list` works on a legacy thread and hands back the same newest turn `thread/read` does, and that on a
 * thread this app-server has resumed both see a turn written to the file from outside, as another Codex process
 * writes one. It checks that a request Codex does not have, and a value in one it does not know, are refused in the
 * wording the adapter reads. Then it prints, for 50, 500 and 2,000 turns, the round trip and reply size of each: counters, sizes
 * and timers only. It reads nothing from the user's own Codex home and never runs in CI:
 *
 *   SOTTO_CODEX_TURNS_LIVE=1 npx vitest run tests/integration/codexNewestTurnLive.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import { findExecutable, nativeEnvironment } from '../../src/main/agents/subscriptionCodex'
import { median, round } from '../fixtures/perfBench'

const LIVE = process.env.SOTTO_CODEX_TURNS_LIVE === '1'
type Reply = { result?: Record<string, unknown> | undefined; error?: { code: number; message: string } | undefined; bytes: number; ms: number }
type Turn = { id: string; status: string; items: { id: string; type: string }[] }

class AppServer {
  private next = 0
  private readonly waiters = new Map<number, (reply: Reply) => void>()
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let message: { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string } }
      try { message = JSON.parse(line) } catch { return }
      if (message.id === undefined || message.method) return
      this.waiters.get(message.id)?.({ result: message.result, error: message.error, bytes: Buffer.byteLength(line) + 1, ms: 0 }); this.waiters.delete(message.id)
    })
  }
  static async start(executable: string, home: string): Promise<AppServer> {
    const child = spawn(executable, ['app-server'], { env: { ...nativeEnvironment(), CODEX_HOME: home }, windowsHide: true, shell: false, stdio: 'pipe' })
    child.stderr.resume()
    const server = new AppServer(child)
    await server.rpc('initialize', { clientInfo: { name: 'sotto-probe', title: 'Sotto probe', version: '1.0' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    return server
  }
  rpc(method: string, params: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = ++this.next; const startedAt = performance.now()
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000)
      this.waiters.set(id, reply => { clearTimeout(timer); resolve({ ...reply, ms: performance.now() - startedAt }) })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  async stop(): Promise<void> {
    const closed = new Promise(resolve => this.child.once('close', resolve))
    this.child.stdin.end(); setTimeout(() => this.child.kill(), 2000).unref()
    await closed
  }
}

/** Codex's own legacy lines for one finished turn, with filler text. */
function turnLines(cwd: string, size: number): string {
  const turn = randomUUID(); const at = new Date().toISOString()
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + '\n'
  return line('event_msg', { type: 'task_started', turn_id: turn })
    + line('turn_context', { turn_id: turn, cwd, approval_policy: 'on-request', sandbox_policy: { type: 'read-only' }, model: 'gpt-5.5', summary: 'auto' })
    + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u'.repeat(size) }] })
    + line('event_msg', { type: 'user_message', message: 'u'.repeat(size), images: [] })
    + line('event_msg', { type: 'agent_reasoning', text: 'r'.repeat(size * 3 / 2) })
    + line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(size * 6) }] })
    + line('event_msg', { type: 'agent_message', message: 'a'.repeat(size * 6) })
    + line('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'a'.repeat(size * 6) })
}

/** A legacy thread in a throwaway home whose session file exists, and that file's path. */
async function legacyThread(executable: string): Promise<{ home: string; cwd: string; threadId: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'sotto-codex-turns-'))
  if (dirname(resolve(home)) !== resolve(tmpdir()) || !home.includes('sotto-codex-turns-')) throw new Error('Unexpected probe directory')
  const server = await AppServer.start(executable, home)
  try {
    const started = await server.rpc('thread/start', { cwd: tmpdir(), ephemeral: false, historyMode: 'legacy' })
    const thread = started.result?.thread as { id: string; path: string }
    await server.rpc('thread/inject_items', { threadId: thread.id, items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'seed' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'seed' }] }] })
    return { home, cwd: tmpdir(), threadId: thread.id, path: thread.path }
  } finally { await server.stop() }
}
const shape = (turn: Turn | undefined) => turn && JSON.stringify([turn.id, turn.status, turn.items.map(item => [item.type, item.id])])

describe.skipIf(!LIVE)("Codex thread/turns/list against the installed app-server (requires SOTTO_CODEX_TURNS_LIVE=1)", () => {
  it('hands back the newest turn thread/read does, and sees a turn another process wrote', async () => {
    const executable = await findExecutable()
    if (!executable) throw new Error('Install Codex to run this check')
    const { home, cwd, threadId, path } = await legacyThread(executable)
    const server = await AppServer.start(executable, home)
    try {
      await appendFile(path, turnLines(cwd, 20))
      const newest = async () => {
        const read = await server.rpc('thread/read', { threadId, includeTurns: true })
        const list = await server.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' })
        expect(read.error).toBeUndefined(); expect(list.error).toBeUndefined()
        const thread = read.result!.thread as { turns: Turn[]; updatedAt: number }
        return { read: shape(thread.turns.at(-1)), list: shape((list.result!.data as Turn[])[0]), count: thread.turns.length, updatedAt: thread.updatedAt }
      }
      const before = await newest()
      expect(before.list).toBe(before.read)
      const again = await newest()
      expect(again.read).toBe(before.read)
      expect(again.list).toBe(before.list)
      expect((await server.rpc('thread/resume', { threadId, cwd, excludeTurns: true })).error).toBeUndefined()
      await appendFile(path, turnLines(cwd, 20))
      const after = await newest()
      expect(after.count).toBe(before.count + 1)
      expect(after.list).toBe(after.read)
      expect(after.read).not.toBe(before.read)
      // Why a timestamp could not stand in for either request: whether the thread's own time moved with that turn.
      console.info(`codex turns live: ${JSON.stringify({ updatedAtMovedWithOutsideTurn: after.updatedAt !== before.updatedAt })}`)
    } finally { await server.stop(); await rm(home, { recursive: true, force: true }) }
  }, 120_000)

  it('names a request, or a value in one, it does not have in the wording the adapter reads', async () => {
    const executable = await findExecutable()
    if (!executable) throw new Error('Install Codex to run this check')
    const { home, threadId } = await legacyThread(executable)
    const server = await AppServer.start(executable, home)
    try {
      // `Rejected` in codex.ts stops the newest-turn check on a connection by this wording (0.157.1). A Codex that
      // words it differently fails here, and until the adapter follows it costs a refused check on every send.
      const missing = await server.rpc('thread/bogus/list', { threadId })
      expect(missing.error?.code).toBe(-32600)
      expect(missing.error?.message).toMatch(/^Invalid request: unknown variant `thread\/bogus\/list`/)
      const unknownValue = await server.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'bogus' })
      expect(unknownValue.error?.code).toBe(-32600)
      expect(unknownValue.error?.message).toMatch(/^Invalid request: unknown variant `bogus`/)
    } finally { await server.stop(); await rm(home, { recursive: true, force: true }) }
  }, 120_000)

  for (const turns of [50, 500, 2000]) {
    it(`reports the round trip and size of each at ${turns} turns`, async () => {
      const executable = await findExecutable()
      if (!executable) throw new Error('Install Codex to run this check')
      const { home, cwd, threadId, path } = await legacyThread(executable)
      await appendFile(path, Array.from({ length: turns }, () => turnLines(cwd, 200)).join(''))
      const server = await AppServer.start(executable, home)
      try {
        const read: Reply[] = []; const list: Reply[] = []
        for (let index = 0; index < 5; index++) {
          read.push(await server.rpc('thread/read', { threadId, includeTurns: true }))
          list.push(await server.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }))
        }
        expect([...read, ...list].every(reply => reply.error === undefined)).toBe(true)
        expect((read[0]!.result!.thread as { turns: Turn[] }).turns).toHaveLength(turns)
        console.info(`codex turns live: ${JSON.stringify({ turns, sessionFileBytes: (await stat(path)).size, threadReadMedianMs: round(median(read.map(reply => reply.ms))), threadReadBytes: read[0]!.bytes,
          turnsListMedianMs: round(median(list.map(reply => reply.ms))), turnsListBytes: list[0]!.bytes })}`)
      } finally { await server.stop(); await rm(home, { recursive: true, force: true }) }
    }, 300_000)
  }
})

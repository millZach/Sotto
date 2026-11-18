import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { codexFixture } from './codexFixture'

// A long Codex thread for the benchmarks under `tests/perf/`: the fake app-server holds a thread with a given
// number of completed turns, each of the shape a coding turn has, and every text in it is filler. A whole read of
// it is about 4.4 KB a turn.

export type CodexFixture = Awaited<ReturnType<typeof codexFixture>>
export type FakeThread = { turns: { id: string; items: { type: string }[] }[]; historyMode?: 'legacy' | 'paginated' }

/** One completed turn of the shape a coding turn has: a prompt, a reasoning summary, a command and a reply. */
export function seededTurn(index: number, cwd: string): Record<string, unknown> {
  const at = 1_790_000_000 + index * 60
  return { id: randomUUID(), status: 'completed', startedAt: at, completedAt: at + 30, itemsView: 'full', items: [
    { type: 'userMessage', id: randomUUID(), content: [{ type: 'text', text: 'u'.repeat(200) }] },
    { type: 'reasoning', id: randomUUID(), summary: ['r'.repeat(300)] },
    { type: 'commandExecution', id: randomUUID(), status: 'completed', command: 'c'.repeat(40), cwd, aggregatedOutput: 'o'.repeat(2000), exitCode: 0, durationMs: 120 },
    { type: 'agentMessage', id: randomUUID(), text: 'a'.repeat(1200) },
  ] }
}

/**
 * A fixture whose Codex holds a thread with `turns` completed turns, restarted and not yet connected, so the
 * adapter holds no history for it and the first open reads it whole. `wrapped` puts the adapter behind the Sotto
 * thread host, so the coordinator addresses it by Sotto thread ID. The workspace and provider hosts the app also
 * puts between them hand a read's purpose on unchanged (threadReadPurpose.test.ts) and are left out. `script` is
 * handed to the restarted fake. `paginated` gives the thread paginated history, as Codex hands some threads back.
 */
export async function seededCodexThread(turns: number, wrapped = false, script: Record<string, unknown> = {}, paginated = false): Promise<{ f: CodexFixture; id: string }> {
  const first = await codexFixture(undefined, wrapped, 60_000)
  await first.host.connect()
  await first.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: first.projectId, title: 'Bench', path: first.root })
  const id = randomUUID()
  await first.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: first.projectId, modelId: first.modelId, title: 'Bench' })
  const codexThreadId = await first.realId(id)
  first.host.disconnect(); await first.adapter.closed()
  const statePath = join(first.root, 'state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { threads: Record<string, FakeThread> }
  state.threads[codexThreadId]!.turns = Array.from({ length: turns }, (_, index) => seededTurn(index, first.root)) as FakeThread['turns']
  if (paginated) state.threads[codexThreadId]!.historyMode = 'paginated'
  await writeFile(statePath, JSON.stringify(state))
  const f = await first.driver.restart() as CodexFixture
  await f.script(script)
  return { f, id }
}

/** Wait for the adapter's own read of a thread it was told to show, and say how long that took from `startedAt`. */
export async function opened(f: CodexFixture, sessionId: string, startedAt: number): Promise<number> {
  await (f.adapter as unknown as { open(id: string): Promise<void> }).open(sessionId)
  return performance.now() - startedAt
}

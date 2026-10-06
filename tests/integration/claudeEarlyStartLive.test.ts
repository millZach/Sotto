// @vitest-environment node
/**
 * Opt-in live check (#769) against the installed, signed-in Claude Code: an early start for a new thread starts the CLI
 * its first send would, and Claude Code writes no session file for it while no prompt has arrived, whether the spare is
 * adopted by the thread's creation or let go. It also times what a new thread's creation pays to start its CLI, with
 * and without a spare. It creates synthetic threads in a temporary folder, sends no prompt and runs no model turn, and
 * prints only timings and whether each session file exists; no prompt, reply, path or key.
 *
 *   PowerShell:  $env:SOTTO_CLAUDE_LIVE = '1'; npx vitest run tests/integration/claudeEarlyStartLive.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeEarlyStartLive.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { median, round } from '../fixtures/perfBench'

const LIVE = process.env.SOTTO_CLAUDE_LIVE === '1'
const ROUNDS = 5
type Internals = { spares: Map<string, { sessionId: string }>; aliases: Record<string, { sessionId: string }> }

/** Whether Claude Code has a session file for this session ID in any project folder. */
async function sessionFileExists(sessionId: string): Promise<boolean> {
  const projects = join(homedir(), '.claude', 'projects')
  for (const folder of await readdir(projects).catch(() => [] as string[])) {
    if ((await readdir(join(projects, folder)).catch(() => [] as string[])).includes(`${sessionId}.jsonl`)) return true
  }
  return false
}

describe.skipIf(!LIVE)('Claude early start (live)', () => {
  it('starts the first send’s CLI early, writes no session file without a prompt, and takes the start off creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-claude-early-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
    const host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 250 })
    const internals = host as unknown as Internals
    const sessions: string[] = []
    try {
      const status = await host.connect()
      expect(status.connected, status.error ?? 'Claude Code is not signed in').toBe(true)
      const model = status.models.find(item => item.ready)!
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic early start', path: cwd })
      const create = async (threadId: string): Promise<number> => {
        const startedAt = performance.now()
        expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'synthetic', title: 'Synthetic', modelId: model.id, runtimeMode: 'approval-required' })).toEqual({ accepted: true })
        sessions.push(internals.aliases[threadId]!.sessionId)
        return performance.now() - startedAt
      }
      const cold: number[] = [], early: number[] = [], starts: number[] = []
      let adopted = 0
      for (let round = 0; round < ROUNDS; round++) {
        cold.push(await create(randomUUID()))
        const threadId = randomUUID()
        const startedAt = performance.now()
        await host.startThreadSession(threadId, { modelId: model.id, workingDirectory: cwd, runtimeMode: 'approval-required' })
        starts.push(performance.now() - startedAt)
        const spare = internals.spares.get(threadId)!.sessionId
        expect(await sessionFileExists(spare)).toBe(false)
        early.push(await create(threadId))
        if (internals.aliases[threadId]!.sessionId === spare) adopted++
      }
      // A spare nobody sends to is let go the way the reaper would, and leaves nothing either.
      const unused = randomUUID()
      await host.startThreadSession(unused, { modelId: model.id, workingDirectory: cwd, runtimeMode: 'approval-required' })
      const unusedSession = internals.spares.get(unused)!.sessionId
      host.disconnect(); await host.closed()
      const files = await Promise.all([...sessions, unusedSession].map(sessionFileExists))
      console.log(JSON.stringify({ claudeCode: status.version, rounds: ROUNDS, adopted,
        earlyStartMs: { median: round(median(starts)), min: round(Math.min(...starts)), max: round(Math.max(...starts)) },
        creationWithoutSpareMs: { median: round(median(cold)), min: round(Math.min(...cold)), max: round(Math.max(...cold)) },
        creationWithSpareMs: { median: round(median(early)), min: round(Math.min(...early)), max: round(Math.max(...early)) },
        sessionFilesWritten: files.filter(Boolean).length }))
      expect(adopted).toBe(ROUNDS)
      expect(files.some(Boolean)).toBe(false)
    } finally {
      host.disconnect(); await host.closed()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('starts the watched set’s CLIs at connect a few at a time, against one after another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-claude-early-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
    const watched = 4
    const ids: string[] = Array.from({ length: watched }, () => randomUUID())
    try {
      const setup = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 250 })
      const status = await setup.connect()
      expect(status.connected, status.error ?? 'Claude Code is not signed in').toBe(true)
      const model = status.models.find(item => item.ready)!
      await setup.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic connect', path: cwd })
      for (const id of ids) await setup.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'synthetic', title: 'Synthetic', modelId: model.id, runtimeMode: 'approval-required' })
      const sessions = ids.map(id => (setup as unknown as Internals).aliases[id]!.sessionId)
      setup.disconnect(); await setup.closed()
      const timings: Record<string, number[]> = { oneAfterAnother: [], fewAtATime: [] }
      for (let round = 0; round < 3; round++) {
        for (const [label, connectStarts] of [['oneAfterAnother', 1], ['fewAtATime', 4]] as const) {
          const host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 250, connectStarts })
          host.observeThreads(ids)
          const startedAt = performance.now()
          const connected = await host.connect()
          timings[label]!.push(performance.now() - startedAt)
          expect(connected.threads.filter(thread => ids.includes(thread.id) && thread.providerSessionOpen)).toHaveLength(watched)
          host.disconnect(); await host.closed()
        }
      }
      const files = await Promise.all(sessions.map(sessionFileExists))
      console.log(JSON.stringify({ claudeCode: status.version, watched, rounds: 3,
        connectOneAfterAnotherMs: timings.oneAfterAnother!.map(value => round(value)),
        connectFewAtATimeMs: timings.fewAtATime!.map(value => round(value)), sessionFilesWritten: files.filter(Boolean).length }))
      expect(files.some(Boolean)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 300_000)
})

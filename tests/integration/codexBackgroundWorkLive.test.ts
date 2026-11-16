// @vitest-environment node
/**
 * #2634 against the installed Codex: one thread asks for a sub-agent it does not wait for and a command left running past
 * its turn, and the real adapter must show both as the thread's background work until each really ends. It spends one
 * short turn (and the sub-agent's) on the signed-in account and leaves that thread's sessions in the user's Codex home,
 * so it never runs in CI and runs only when asked:
 *
 *   SOTTO_CODEX_LIVE=1 npx vitest run tests/integration/codexBackgroundWorkLive.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/providers/codex/codex'

describe('requires SOTTO_CODEX_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_CODEX_LIVE !== '1')('keeps a Codex sub-agent and a command left running as background work until each ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-codex-background-probe-'))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-codex-background-probe-')) throw new Error('Unexpected probe directory')
    const host = new CodexAppServerHost({ userDataPath: directory })
    const seen: string[] = []
    try {
      const snapshot = await host.connect()
      const model = snapshot.models.find(item => item.ready)!
      const threadId = randomUUID()
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'probe', title: 'Background probe', path: directory })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), projectId: 'probe', threadId, title: 'Synthetic background probe', modelId: model.id, runtimeMode: 'full-access' })
      host.observeThreads?.([threadId])
      expect((await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(),
        text: 'Do two things, then end your turn at once with one short sentence. 1. Use spawn_agent to start one sub-agent whose task is to run the shell command `sleep 30` and then reply done; do not wait for it. 2. Run `sleep 40` with your exec_command tool with yield_time_ms 1000 so it is still running when the call returns; do not use nohup or &, and do not poll it. Do not wait for either.' })).accepted).toBe(true)
      const answered = new Set<string>()
      const look = async () => {
        const thread = (await host.snapshot()).threads.find(item => item.id === threadId)!
        for (const request of thread.requests) if (!answered.has(request.id)) { answered.add(request.id); void host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: 'Allow once', approved: true }).catch(() => undefined) }
        const state = `${thread.status} work=${(thread.backgroundWork ?? []).map(work => `${work.type}:${work.label}`).join(',')} rows=${(thread.activities ?? []).filter(row => row.kind === 'subagent' || row.kind === 'command').map(row => `${row.kind}:${row.status}`).join(',')}`
        if (seen.at(-1) !== state) seen.push(state)
        return thread
      }
      await expect.poll(async () => { const thread = await look(); return thread.status !== 'running' && (thread.backgroundWork?.length ?? 0) > 0 }, { timeout: 180_000, interval: 500 }).toBe(true)
      await expect.poll(async () => { const thread = await look(); return thread.status !== 'running' && !thread.backgroundWork?.length }, { timeout: 240_000, interval: 1000 }).toBe(true)
    } finally {
      console.log(seen.join('\n'))
      host.disconnect(); await host.closed(); await rm(directory, { recursive: true, force: true })
    }
  }, 480_000)
})

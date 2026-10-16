// @vitest-environment node
/**
 * Continuing a Codex agent as its own thread, and forking a thread at a reply (#1028), against the installed Codex and
 * the user's own sign-in. It spends: one turn asks Codex to start one small agent and wait for it. It then forks that
 * agent and the thread itself through Sotto's adapter, which asks the model nothing more. Each fork is durable, so
 * Codex writes it beside the user's other rollouts, as continuing an agent in the app does; nothing is archived or
 * deleted. Codex opens its usual Responses websocket when a fork starts (`thread/started`), as opening any thread does,
 * so the check expects that connection and adds no host. It never runs in CI:
 *
 *   SOTTO_CODEX_LIVE=1 npx vitest run tests/integration/codexThreadForkLive.test.ts --maxWorkers=1
 *
 * `SOTTO_CODEX_LIVE_MODEL` picks the model; the first ready one is used otherwise.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'

const LIVE = process.env.SOTTO_CODEX_LIVE === '1'

describe.runIf(LIVE)('a Codex agent continued as its own thread, live', () => {
  it('forks a finished agent and the thread at a reply, each bound to a new thread, with no further turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-fork-live-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-fork-live-')) throw new Error('Unexpected live directory')
    const host = new CodexAppServerHost({ userDataPath: root, requestTimeoutMs: 120_000 })
    try {
      const connected = await host.connect()
      const modelId = process.env.SOTTO_CODEX_LIVE_MODEL ?? connected.models.find(model => model.ready)?.id
      if (!modelId) throw new Error('No ready Codex model.')
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Fork live check', path: root })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'parent', projectId: 'live', title: 'Fork live check', modelId, runtimeMode: 'approval-required' })
      await host.execute({ type: 'send', commandId: randomUUID(), threadId: 'parent', messageId: randomUUID(),
        text: 'Start one sub-agent named echo_check whose only task is to reply with the single word ready. Wait for it to finish, then reply with the single word done. Do not run commands or change files.' })
      const deadline = Date.now() + 600_000
      let agentId: string | undefined
      for (;;) {
        const thread = (await host.refreshThread('parent')).threads.find(item => item.id === 'parent')!
        agentId = thread.activities?.flatMap(activity => activity.agents ?? []).find(agent => agent.status === 'completed')?.id
        if (thread.status !== 'running' && agentId) break
        if (Date.now() > deadline) throw new Error('The agent did not finish in ten minutes.')
        await new Promise(done => setTimeout(done, 3_000))
      }
      const parent = (await host.refreshThread('parent')).threads.find(item => item.id === 'parent')!
      const reply = parent.messages.findLast(message => message.role === 'assistant')!

      expect(await host.forkThread({ commandId: randomUUID(), threadId: 'continued', title: 'echo_check', modelId, runtimeMode: 'approval-required', source: { threadId: 'parent', agentId } })).toEqual({ accepted: true })
      const continued = (await host.refreshThread('continued')).threads.find(item => item.id === 'continued')!
      expect(continued.messages.some(message => message.role === 'assistant')).toBe(true)
      expect(continued.status).toBe('idle')

      expect(await host.forkThread({ commandId: randomUUID(), threadId: 'forked', title: 'Fork of Fork live check', modelId, runtimeMode: 'approval-required', source: { threadId: 'parent', messageId: reply.id } })).toEqual({ accepted: true })
      const forked = (await host.refreshThread('forked')).threads.find(item => item.id === 'forked')!
      expect(forked.messages.map(message => message.text)).toEqual(parent.messages.map(message => message.text))
      // Neither fork started a turn: only the parent's one turn ran.
      expect([continued.lastTurn?.status, forked.lastTurn?.status].every(status => status === undefined || status === 'completed')).toBe(true)
    } finally { host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
  }, 900_000)
})

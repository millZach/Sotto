// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentThread } from '../../src/shared/agents'
import { codexFixture } from '../fixtures/codexFixture'

// #2634: Codex sub-agents and unified-exec commands outlive their turn, on frames read from codex-cli 0.169.0 live.
describe('Codex background work', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => { await close?.(); close = undefined })
  const open = async () => {
    const f = await codexFixture()
    close = f.cleanup
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Codex thread' })
    f.host.observeThreads?.([id])
    expect(await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Draw the car in the background' })).toEqual({ accepted: true })
    const thread = async () => (await f.host.snapshot()).threads.find(item => item.id === id)!
    const act = async (value: Record<string, unknown>) => { await f.carriedOut(await f.action(id, value)) }
    return { f, id, thread, act }
  }
  const row = async (thread: () => Promise<AgentThread>, kind: string) => (await thread()).activities?.find(item => item.kind === kind)

  it('keeps a sub-agent working in its own thread as background work, its row running, until its own turn ends', async () => {
    const { thread, act } = await open()
    await act({ type: 'background-agent', text: 'Started it.', description: 'GT3 RS drawing' })
    await expect.poll(async () => (await thread()).backgroundWork?.map(work => [work.label, work.type])).toEqual([['GT3 RS drawing', 'subagent']])
    expect((await thread()).status).toBe('idle')
    expect(await row(thread, 'subagent')).toMatchObject({ status: 'running', agents: [{ status: 'running' }] })
    await act({ type: 'background-agent-end' })
    await expect.poll(async () => (await thread()).backgroundWork).toBeUndefined()
    expect(await row(thread, 'subagent')).toMatchObject({ status: 'completed', agents: [{ status: 'completed' }] })
  })

  it('keeps a command Codex left running as a background command until its own completion', async () => {
    const { thread, act } = await open()
    await act({ type: 'background-command', text: 'Rendering in the background.', command: 'npm run render' })
    await expect.poll(async () => (await thread()).backgroundWork?.map(work => [work.label, work.type])).toEqual([['npm run render', 'command']])
    expect(await row(thread, 'command')).toMatchObject({ status: 'running' })
    await act({ type: 'background-command-end' })
    await expect.poll(async () => (await thread()).backgroundWork).toBeUndefined()
    expect((await row(thread, 'command'))?.status).toBe('completed')
  })

  it('lets background work go with a lost app-server, so nothing counts it as working any more', async () => {
    const { f, id, thread, act } = await open()
    await act({ type: 'background-agent', text: 'Started it.', description: 'GT3 RS drawing' })
    await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
    // The thread's app-server stops the way a crashed one would; it acknowledges nothing.
    await f.action(id, { type: 'exit' })
    await expect.poll(async () => (await thread()).backgroundWork).toBeUndefined()
    expect(await row(thread, 'subagent')).toMatchObject({ status: 'unknown', agents: [{ status: 'interrupted' }] })
  })
})

// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProductEvent, type ProductEventName } from '../../src/main/productEvents/schema'
import type { ProductEventRecorder } from '../../src/main/productEvents/threadEvents'
import type { AgentThread } from '../../src/shared/agents'
import { copyBudgetPipeline, type CopyBudgetPipeline } from '../fixtures/copyBudgetPipeline'

const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 80))

/** The events a thread sends on main's real update path: the adapter, the provider switch, the workspace and the coordinator. */
describe('product events on the update path', () => {
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
  async function start(owl = false): Promise<{ pipeline: CopyBudgetPipeline; sent: { event: ProductEventName; properties: unknown }[]; features: string[]; stream: AgentThread }> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-product-events-threads-'))
    const sent: { event: ProductEventName; properties: unknown }[] = [], features: string[] = []
    const recorder: ProductEventRecorder = { record: (event, properties) => { sent.push({ event, properties }) }, featureUsed: feature => { features.push(feature) } }
    const pipeline = await copyBudgetPipeline(root, 20, owl, recorder)
    stops.push(async () => { await pipeline.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
    return { pipeline, sent, features, stream: pipeline.adapter.state.threads.find(thread => thread.id === 'stream-0')! }
  }
  const turn = (pipeline: CopyBudgetPipeline, stream: AgentThread, id: string, status: 'running' | 'completed' | 'failed' | 'interrupted'): void => {
    stream.status = status === 'running' ? 'running' : 'idle'; stream.lastTurn = { id, status }
    pipeline.adapter.mark(stream.id); pipeline.adapter.publish(false)
  }

  it('sends one turn.completed that passes its schema, however many updates the turn had', async () => {
    const { pipeline, sent, stream } = await start()
    expect(sent).toEqual([])
    turn(pipeline, stream, 'turn-1', 'running')
    await settled()
    pipeline.adapter.log.add(stream.id, { id: 'reply', role: 'assistant', text: 'A private reply', createdAt: new Date().toISOString() })
    for (let chunk = 0; chunk < 20; chunk += 1) { pipeline.adapter.log.appendText(stream.id, 'reply', ` private${chunk}`); pipeline.adapter.publish(true) }
    await settled()
    stream.usage = { ...stream.usage!, total: { input: 20_340, output: 5_300, cached: 12_530 } }
    turn(pipeline, stream, 'turn-1', 'completed')
    await settled()
    const turns = sent.filter(item => item.event === 'turn.completed')
    expect(turns).toHaveLength(1)
    expect(parseProductEvent('turn.completed', turns[0]!.properties)).not.toBeNull()
    expect(turns[0]!.properties).toMatchObject({ provider: 'claude', startedBy: 'user', result: 'completed', inputTokens: 1_000, outputTokens: 50, cachedInputTokens: 500 })
    expect((turns[0]!.properties as { durationMs: number }).durationMs).toBeGreaterThan(0)
    expect(JSON.stringify(sent)).not.toMatch(/private|stream-0|Synthetic/)
    turn(pipeline, stream, 'turn-1', 'completed')
    await settled()
    expect(sent.filter(item => item.event === 'turn.completed')).toHaveLength(1)
  })

  it('says a stopped turn stopped and a failed one failed', async () => {
    const { pipeline, sent, stream } = await start()
    turn(pipeline, stream, 'turn-1', 'running'); await settled()
    turn(pipeline, stream, 'turn-1', 'interrupted'); await settled()
    turn(pipeline, stream, 'turn-2', 'running'); await settled()
    turn(pipeline, stream, 'turn-2', 'failed'); await settled()
    expect(sent.map(item => (item.properties as { result: string }).result)).toEqual(['stopped', 'failed'])
  })

  it('sends thread.started once when a thread made through the coordinator begins its first turn, and not before', async () => {
    const { pipeline, sent } = await start()
    const { host } = await pipeline.control.command({ type: 'refresh' })
    const project = host.projects.find(item => item.id === 'project')!
    await mkdir(project.path!, { recursive: true })
    const made = await pipeline.control.command({ type: 'create-thread', projectId: project.id, title: 'A private title', modelId: host.models.find(model => model.ready)!.id })
    expect(made.error).toBeFalsy()
    await settled()
    expect(sent).toEqual([])
    await pipeline.control.command({ type: 'manual-send', threadId: made.activeThreadId!, text: 'A private prompt' })
    await settled()
    expect(sent).toEqual([])
    const native = pipeline.adapter.state.threads.at(-1)!
    turn(pipeline, native, 'turn-1', 'running')
    await settled()
    const started = sent.filter(item => item.event === 'thread.started')
    expect(started).toHaveLength(1)
    expect(parseProductEvent('thread.started', started[0]!.properties)).not.toBeNull()
    expect(started[0]!.properties).toMatchObject({ provider: 'claude', startedBy: 'user', inWorktree: false })
    expect(JSON.stringify(sent)).not.toMatch(/private/)
  })

  it('says who started a thread, and says the feature is in use', async () => {
    const { pipeline, sent, features, stream } = await start()
    const id = pipeline.streamIds[0]!
    let turns = 0
    const startedBy = async (): Promise<unknown> => {
      sent.length = 0; features.length = 0; turns += 1
      turn(pipeline, stream, `turn-${turns}`, 'running'); await settled()
      turn(pipeline, stream, `turn-${turns}`, 'completed'); await settled()
      return (sent[0]!.properties as { startedBy: string }).startedBy
    }
    expect(await startedBy()).toBe('user')
    expect(features).toEqual([])
    await pipeline.workspace.setDelegatedBy(id, pipeline.parentId)
    expect(await startedBy()).toBe('delegation')
    expect(features).toEqual(['delegation'])
    // A Council's seat also carries the thread that asked, and stays the Council's once that Council stops following it.
    const offCouncil = pipeline.control.useCouncil({ observe: () => undefined, observedThreadIds: () => [], madeThread: thread => thread === id, messageIdFor: () => undefined, guardFor: () => undefined, ownsMessage: () => false })
    expect(await startedBy()).toBe('council')
    expect(features).toEqual(['council'])
    offCouncil()
    pipeline.control.useSwarms(thread => thread === id ? { id: 'swarm', leadThreadId: pipeline.parentId, count: 2, done: 0, failed: 0, queued: 0 } : undefined)
    expect(await startedBy()).toBe('swarm')
    expect(features).toEqual(['swarm'])
  })

  it('sends nothing for every thread already there when Sotto starts', async () => {
    const { sent, features } = await start()
    await settled()
    expect(sent).toEqual([]); expect(features).toEqual([])
  })
})

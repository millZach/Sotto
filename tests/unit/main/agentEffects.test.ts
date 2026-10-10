// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { designThreadsFixture } from '../../../src/shared/e2e'

describe('Threads design host fixtures', () => {
  it('preserves all nine fixture threads, message identities, times and the visual-gate permission', async () => {
    const fixture = designThreadsFixture()
    const host = new E2EAgentHost('design-threads')
    await host.connect()
    const snapshot = await host.snapshot()
    expect(snapshot.threads).toHaveLength(9)
    expect(snapshot.threads.map(thread => thread.id)).toEqual(fixture.threads.map(thread => thread.id))
    expect(snapshot).toMatchObject({ models: fixture.models, projects: fixture.projects, threads: fixture.threads })
    expect(snapshot.threads.find(thread => thread.id === 'visual-gate')?.requests).toEqual(fixture.threads[0]!.requests)
    expect(snapshot.threads[0]?.requests[0]?.kind).toBe('permission')
    snapshot.threads[0]!.messages[0]!.text = 'Mutated snapshot'
    expect((await host.snapshot()).threads).toEqual(fixture.threads)
  })

  it('keeps fixture models and projects with zero threads in the empty scenario', async () => {
    const host = new E2EAgentHost('design-threads-empty')
    await host.connect()
    const fixture = designThreadsFixture()
    expect(await host.snapshot()).toMatchObject({ models: fixture.models, projects: fixture.projects, threads: [] })
  })

  it('keeps the original workshop and docs fixture with no scenario argument', async () => {
    const host = new E2EAgentHost()
    await host.connect()
    expect(await host.snapshot()).toMatchObject({
      models: [{ id: 'claude:test', provider: 'Claude', name: 'Claude Test', ready: true }],
      projects: [{ id: 'project', title: 'Sotto test', path: 'C:/sotto-test' }],
      threads: ['workshop', 'docs'].map(id => ({ id, title: id === 'workshop' ? 'Workshop' : 'Docs', projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })),
    })
  })
})

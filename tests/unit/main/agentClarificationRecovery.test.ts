// @vitest-environment node
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UnacknowledgedCreationHost, fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

describe('clarification recovery', () => {

  it.each(['create-project', 'create-thread'] as const)('blocks fresh creation intents while %s has an unknown acknowledgment, including after restart', async type => {
    const host = new UnacknowledgedCreationHost()
    const f = await fixture(host)
    await f.account()
    const command = type === 'create-project'
      ? { type: 'create-project' as const, title: 'Lantern', path: join(f.root, 'first-project') }
      : { type: 'create-thread' as const, title: 'Lantern', projectId: 'project', modelId: 'claude:test' }
    const failed = await f.control.command(command)
    expect(failed.error).toMatch(/did not confirm/iu)
    await f.restart()
    const retry = await f.control.command(command)
    expect(retry.error).toMatch(/unknown result/iu)
    const alternativePath = join(f.root, 'must-not-be-created')
    const another = await f.control.command({ type: 'create-project', title: 'Another', path: alternativePath })
    expect(another.error).toMatch(/unknown result/iu)
    await expect(stat(alternativePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(host.creationAttempts).toHaveLength(1)
    await host.revealOriginalCreation()
    const observed = await f.control.command({ type: 'refresh' })
    const existing = type === 'create-project'
      ? observed.host.projects.find(project => project.title === 'Lantern')!
      : observed.host.threads.find(thread => thread.title === 'Lantern')!
    const selected = await f.control.command(type === 'create-project'
      ? { type: 'select-project', projectId: existing.id } : { type: 'select-thread', threadId: existing.id })
    expect(selected.error).toBeNull()
    expect(selected).not.toHaveProperty('pendingRequest')
    expect(host.creationAttempts).toHaveLength(1)
  })

})

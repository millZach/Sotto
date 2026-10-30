// @vitest-environment node
// Fast mode on a thread that has not sent yet (ADR-0143): the composer's toggle saves the choice on Sotto's own record,
// a change of model keeps it, it outlives a restart, and the first send creates the provider's thread with it.
import { describe, expect, it } from 'vitest'
import { agentCommandSchema, type AgentSpeed } from '../../../src/shared/agents'
import { speedRuns } from '../../../src/main/agents/threadOptions'

import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { cleanup, fixture, send } from '../../fixtures/workspaceTestFixture'

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Codex offers fast mode on its first model and not on a second. */
async function draft(f: Fixture, speed?: AgentSpeed): Promise<{ fast: string; plain: string }> {
  const codex = f.adapters.codex.state
  codex.models[0]!.fastMode = { description: '1.5x speed, increased usage' }
  codex.models[0]!.speeds = [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }]
  codex.models.push({ ...codex.models[0]!, id: 'fake:plain', name: 'Plain model' })
  delete codex.models[1]!.fastMode
  delete codex.models[1]!.speeds
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const fast = snapshot.models.find(model => model.providerId === 'codex' && model.fastMode)!.id
  const plain = snapshot.models.find(model => model.providerId === 'codex' && !model.fastMode)!.id
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'New task', modelId: fast, ...(speed ? { speed } : {}) })
  return { fast, plain }
}
const shown = (f: { host: Fixture['host'] }) => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!

describe('fast mode before the first send', () => {
  it('keeps a validated Watcher speed on creation without allowing an unsupported public selection', async () => {
    const f = await fixture()
    const { fast, plain } = await draft(f)
    const projectId = shown(f).projectId
    const command = { type: 'create-thread' as const, commandId: 'create-kept', threadId: 'kept', projectId, title: 'Watcher', modelId: plain, speed: 'ultrafast' as const }
    await expect(f.host.execute(command)).rejects.toThrow('This model does not offer ultrafast speed.')
    expect(agentCommandSchema.safeParse({ type: 'create-thread', projectId, title: 'Watcher', modelId: plain, speed: 'ultrafast', keptSpeed: true }).success).toBe(false)
    await f.host.execute({ ...command, keptSpeed: true })
    const kept = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'kept')!
    expect(kept()).toMatchObject({ modelId: plain, speed: 'ultrafast', nativeSessionStarted: false })
    expect(speedRuns(f.host.workspaceSnapshot(), plain, kept().speed)).toBeNull()
    await f.host.execute({ type: 'configure-thread', commandId: 'restore-kept', threadId: 'kept', modelId: fast })
    expect(kept()).toMatchObject({ modelId: fast, speed: 'ultrafast' })
    expect(speedRuns(f.host.workspaceSnapshot(), fast, kept().speed)).toBe('ultrafast')
  })

  it('persists ultra fast before first send and clears it through the legacy toggle', async () => {
    const f = await fixture()
    await draft(f, 'ultrafast')
    expect(shown(f)).toMatchObject({ speed: 'ultrafast', nativeSessionStarted: false })
    expect(shown(f).fastMode).toBeUndefined()
    await f.stop()
    const reopened = await workspaceFixture(f.root, { adapters: f.adapters }); cleanup.push(reopened.stop)
    await reopened.host.connect()
    expect(shown(reopened).speed).toBe('ultrafast')
    await reopened.host.execute(send())
    expect(reopened.adapters.codex.commands.find(command => command.type === 'create-thread')).toMatchObject({ speed: 'ultrafast' })
    // A separate unsent draft verifies older clients can clear a named speed with fastMode: false.
    const clear = await fixture()
    await draft(clear)
    await clear.host.execute({ type: 'configure-thread', commandId: 'ultra', threadId: 'local', speed: 'ultrafast' })
    await clear.host.execute({ type: 'configure-thread', commandId: 'off', threadId: 'local', fastMode: false })
    expect(shown(clear).speed).toBeUndefined()
    expect(shown(clear).fastMode).toBeUndefined()
  })

  it('starts off, keeps the choice through a model without it, and outlives a restart', async () => {
    const f = await fixture()
    const { fast, plain } = await draft(f)
    expect(shown(f).fastMode).toBeUndefined()

    await f.host.execute({ type: 'configure-thread', commandId: 'on', threadId: 'local', fastMode: true })
    expect(shown(f)).toMatchObject({ nativeSessionStarted: false, fastMode: true })
    // A model without fast mode cannot have it turned on, but moving to one keeps the choice.
    await f.host.execute({ type: 'configure-thread', commandId: 'plain', threadId: 'local', modelId: plain })
    expect(shown(f)).toMatchObject({ modelId: plain, fastMode: true })
    await f.host.execute({ type: 'configure-thread', commandId: 'back', threadId: 'local', modelId: fast })
    expect(shown(f)).toMatchObject({ modelId: fast, fastMode: true })

    await f.stop()
    const reopened = await workspaceFixture(f.root, { adapters: f.adapters }); cleanup.push(reopened.stop)
    await reopened.host.connect()
    expect(shown(reopened)).toMatchObject({ nativeSessionStarted: false, fastMode: true })

    // The first send creates the provider's thread with the choice, which the adapter applies where the model has it.
    await reopened.host.execute(send())
    expect(reopened.adapters.codex.commands.find(command => command.type === 'create-thread')).toMatchObject({ fastMode: true })
  })

  it('refuses fast mode on a model without it and turns it off again', async () => {
    const f = await fixture()
    const { plain } = await draft(f)
    await f.host.execute({ type: 'configure-thread', commandId: 'on', threadId: 'local', fastMode: true })
    await f.host.execute({ type: 'configure-thread', commandId: 'plain', threadId: 'local', modelId: plain })
    await f.host.execute({ type: 'configure-thread', commandId: 'off', threadId: 'local', fastMode: false })
    expect(shown(f).fastMode).toBeUndefined()
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'refused', threadId: 'local', fastMode: true })).rejects.toThrow('This model does not offer fast mode.')
    expect(shown(f).fastMode).toBeUndefined()
    // A thread created without the choice sends none.
    await f.host.execute(send())
    expect(f.adapters.codex.commands.find(command => command.type === 'create-thread')).not.toHaveProperty('fastMode')
  })
})

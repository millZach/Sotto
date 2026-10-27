// @vitest-environment node
// Fast mode on a thread that has not sent yet (ADR-0143): the composer's toggle saves the choice on Sotto's own record,
// a change of model keeps it, it outlives a restart, and the first send creates the provider's thread with it.
import { describe, expect, it } from 'vitest'

import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { cleanup, fixture, send } from '../../fixtures/workspaceTestFixture'

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Codex offers fast mode on its first model and not on a second. */
async function draft(f: Fixture): Promise<{ fast: string; plain: string }> {
  const codex = f.adapters.codex.state
  codex.models[0]!.fastMode = { description: '1.5x speed, increased usage' }
  codex.models.push({ ...codex.models[0]!, id: 'fake:plain', name: 'Plain model' })
  delete codex.models[1]!.fastMode
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const fast = snapshot.models.find(model => model.providerId === 'codex' && model.fastMode)!.id
  const plain = snapshot.models.find(model => model.providerId === 'codex' && !model.fastMode)!.id
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'New task', modelId: fast })
  return { fast, plain }
}
const shown = (f: { host: Fixture['host'] }) => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!

describe('fast mode before the first send', () => {
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

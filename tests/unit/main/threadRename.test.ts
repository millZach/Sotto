// @vitest-environment node
/**
 * Renaming a thread after it is created: the coordinator's `rename-thread` command, the set-by-hand
 * mark it records, and the promise that a rename never waits on the turn the thread is running.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { agentCommandSchema, type AgentThread } from '../../../src/shared/agents'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const membership = { status: async () => ({ status: 'beta' as const, label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta' as const, label: 'Test', expiresAt: null }) }

const opened: { control: AgentControl; stop: () => Promise<void> }[] = []
const removals: (() => Promise<void>)[] = []
async function coordinator(root?: string) {
  const workspace = await workspaceFixture(root)
  if (root === undefined) removals.push(workspace.remove)
  const credentials = new AgentCredentials(workspace.root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: workspace.root, host: workspace.host, credentials, reasoner: e2eAgentReasoner, membership })
  opened.push({ control, stop: workspace.stop })
  await control.start()
  await control.command({ type: 'connect' })
  return { ...workspace, control }
}
/** The thread the fake Codex provider calls "Workshop", under the Sotto ID the registry gave it. */
const workshop = (control: AgentControl): AgentThread =>
  control.get().host.threads.find(thread => thread.title === 'Workshop' && thread.providerId === 'codex')
  ?? control.get().host.threads.find(thread => thread.providerId === 'codex')!
const titled = (control: AgentControl, threadId: string): AgentThread => control.get().host.threads.find(thread => thread.id === threadId)!

afterEach(async () => {
  for (const { control, stop } of opened.splice(0).reverse()) { control.dispose(); await stop() }
  for (const remove of removals.splice(0)) await remove()
})

describe('renaming a thread', () => {
  it('takes the new name, marks it set by hand, and keeps it across provider events and a restart', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    expect(titled(f.control, threadId).titleSource).toBeUndefined()
    const renamed = await f.control.command({ type: 'rename-thread', threadId, title: '  Palette work  ' })
    expect(renamed.error).toBeNull()
    expect(renamed.host.threads.find(thread => thread.id === threadId)).toMatchObject({ title: 'Palette work', titleSource: 'user' })
    // The provider still calls its session "Workshop"; its own title never comes back over the user's.
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect(titled(f.control, threadId)).toMatchObject({ title: 'Palette work', titleSource: 'user' })

    const reopened = await coordinator(f.root)
    expect(titled(reopened.control, threadId)).toMatchObject({ title: 'Palette work', titleSource: 'user' })
  })

  it('refuses an empty or whitespace-only name, and an archived thread, without changing the thread', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    for (const title of ['', '   ', '\n\t ']) {
      const refused = await f.control.command({ type: 'rename-thread', threadId, title })
      expect(refused.error).toBe('Type a name for this thread.')
      expect(titled(f.control, threadId)).toMatchObject({ title: 'Workshop' })
      expect(titled(f.control, threadId).titleSource).toBeUndefined()
    }
    // The command schema accepts the blank name so the refusal is this sentence and not a parse failure.
    expect(agentCommandSchema.safeParse({ type: 'rename-thread', threadId, title: '   ' }).success).toBe(true)

    f.adapters.codex.state.threads[0]!.archivedAt = new Date().toISOString()
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    const archived = await f.control.command({ type: 'rename-thread', threadId, title: 'Too late' })
    expect(archived.error).toMatch(/Archived/)
    expect(titled(f.control, threadId).title).toBe('Workshop')
  })

  it('does not wait on the turn the thread is running, and never tells the provider', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    const adapter = f.adapters.codex
    const inner = adapter.execute.bind(adapter)
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const sending = new Promise<void>(resolve => { started = resolve })
    adapter.execute = async (command: AgentHostCommand) => {
      if (command.type === 'send') { started(); await held }
      return inner(command)
    }
    const order: string[] = []
    const prompt = f.control.command({ type: 'manual-send', threadId, text: 'Start work' })
    void prompt.then(() => order.push('prompt'), () => order.push('prompt'))
    await sending

    await f.control.command({ type: 'rename-thread', threadId, title: 'Renamed mid-turn' })
    order.push('rename')
    // The rename landed while the prompt was still in the provider's hands.
    expect(order).toEqual(['rename'])
    expect(titled(f.control, threadId)).toMatchObject({ title: 'Renamed mid-turn', titleSource: 'user' })

    release()
    await prompt
    expect(order).toEqual(['rename', 'prompt'])
    expect(adapter.commands.map(command => command.type)).toEqual(['send'])
  })
})

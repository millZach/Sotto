// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { codexFixture } from '../fixtures/codexFixture'

it.each(['before-read', 'during-read'] as const)('keeps a native-confirmed send successful when streaming invalidates post-send reads (%s)', async confirmation => {
  const f = await codexFixture()
  const id = randomUUID()
  const draftId = randomUUID()
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    await control.start(); await control.command({ type: 'connect' })
    const seam = f.adapter as unknown as {
      emit(): void
      rpc(method: string, params: unknown, apply?: (value: unknown) => void | Promise<void>, rejected?: () => void | Promise<void>): Promise<void>
    }
    const emit = seam.emit.bind(seam), rpc = seam.rpc.bind(seam)
    const execute = f.host.execute.bind(f.host)
    const pieces: string[] = []
    let accepted = false
    let holdEcho = confirmation === 'during-read'
    const stream = async () => {
      pieces.push(`chunk ${pieces.length + 1}; `)
      await f.action(id, { type: 'notify', method: 'item/agentMessage/delta', params: { itemId: 'live-output', delta: pieces.at(-1) } })
      await expect.poll(() => control.get().host.threads.find(thread => thread.id === id)?.messages.find(message => message.id === 'live-output')?.text).toBe(pieces.join(''))
    }
    vi.spyOn(seam, 'emit').mockImplementation(() => { if (!holdEcho) emit() })
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      const result = await execute(command)
      if (command.type === 'send' && result.accepted) {
        accepted = true
        if (!holdEcho) await stream()
      }
      return result
    })
    vi.spyOn(seam, 'rpc').mockImplementation(async (method, params, apply, rejected) => {
      if (method === 'thread/read' && accepted) {
        // Delay each reconciliation read until a real native delta arrives.
        // Every attempt becomes stale, without depending on a timer race.
        holdEcho = false
        await stream()
      }
      return rpc(method, params, apply, rejected)
    })
    const result = await control.command({ type: 'manual-send', threadId: id, text: 'Confirmed native prompt', draftId })
    expect(result.deliveredDrafts).toContainEqual({ threadId: id, draftId })
    expect(result.deliveries).toContainEqual(expect.objectContaining({ threadId: id, draftId, status: 'accepted' }))
    expect(result.threadDrafts).toEqual([])
    expect(result.draft).toBe('')
    expect(result.error, 'a confirmed native message must not become a failed send when display reads stay busy').toBeNull()
    expect(result.host.threads.find(thread => thread.id === id)?.messages.filter(message => message.role === 'user')).toHaveLength(1)
    await stream()
    expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toHaveLength(1)
  } finally { vi.restoreAllMocks(); control.dispose(); await control.privacyChanged(); await f.cleanup() }
})

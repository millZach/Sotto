// @vitest-environment node
// Opt-in only: creates a fresh native Muse session and sends one text-only synthetic prompt.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MuseMspHost } from '../../src/main/agents/muse'

describe('requires SOTTO_MUSE_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_MUSE_LIVE !== '1')('native Muse creates, prompts, skips unsafe side writing, and resumes an owned synthetic session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-muse-live-'))
    let host = new MuseMspHost(root)
    try {
      const initial = await host.connect()
      // The floor is not a pin (ADR-0042): whatever is installed reports itself here.
      expect(initial.version).toContain(' / MSP 1')
      expect(initial.models.length).toBeGreaterThan(0)
      const threadId = randomUUID()
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'smoke', title: 'Synthetic smoke', path: root })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'smoke', title: 'Sotto synthetic adapter smoke', modelId: initial.models[0]!.id })
      expect(await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'smoke-prompt', text: 'Reply with exactly SOTTO_MUSE_SMOKE. Do not use tools, read files, or execute commands.' })).toEqual({ accepted: true })
      await expect.poll(async () => (await host.snapshot()).threads[0]!.status, { timeout: 90_000, interval: 1000 }).toBe('idle')
      const before = (await host.snapshot()).threads[0]!
      expect(before.messages.some(message => message.role === 'assistant' && message.text.includes('SOTTO_MUSE_SMOKE'))).toBe(true)
      expect(before.messages.filter(message => message.role === 'user')).toHaveLength(1)
      const title = await host.writeShortText(threadId, { instruction: 'Name this conversation in a few words.', material: 'First message:\nReply with exactly SOTTO_MUSE_SMOKE.' })
      expect(title).toBeNull()
      expect((await host.snapshot()).threads).toHaveLength(1)
      host.disconnect(); await host.closed()
      host = new MuseMspHost(root)
      const reopened = await host.connect()
      host.observeThreads?.([threadId])
      await expect.poll(async () => (await host.snapshot()).threads[0]!.messages.map(message => message.id), { timeout: 30_000, interval: 500 })
        .toEqual(before.messages.map(message => message.id))
      expect(reopened.connected).toBe(true)
    } finally { host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
  }, 180_000)
})

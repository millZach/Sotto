// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { projectWatcherMessages, watcherDisplayPrompt, WatcherMessageDisplay } from '../../../src/main/agents/watcherMessageDisplay'
import type { AgentMessage } from '../../../src/shared/agents'
import { watcherRecordFixture } from '../../fixtures/watcher'
vi.mock('node:crypto', async importActual => ({ ...await importActual<typeof import('node:crypto')>(),
  createHash: vi.fn((await importActual<typeof import('node:crypto')>()).createHash) }))

function fixture() {
  const record = watcherRecordFixture(), request = record.requests[0]!, original = 'Inspect Ω 😃\nKeep this line.'
  const wire = `${original}\n\n[Sotto Watcher request: synthetic. Local host: synthetic. Keep native context.]`
  const owner = { ...request.watcher }
  request.displayPrompt = watcherDisplayPrompt(original, wire)
  const messages: AgentMessage[] = [{ id: request.rootUserMessageId, role: 'user', text: wire, createdAt: request.createdAt }]
  const show = () => projectWatcherMessages(owner.hostId, owner.threadId, messages, record.requests)
  return { record, request, owner, original, wire, messages, show }
}

describe('owned Watcher message presentation', () => {
  it('projects exact owned text, keeps native input whole and is idempotent on an already presented message', () => {
    const f = fixture(), before = structuredClone(f.messages)
    f.messages[0]!.attachments = [{ id: 'image', name: 'image.png', mimeType: 'image/png', sizeBytes: 1 }]
    before[0]!.attachments = structuredClone(f.messages[0]!.attachments)
    const presented = f.show()
    expect(presented).toMatchObject([{ id: f.request.rootUserMessageId, text: f.original }])
    expect(f.messages).toEqual(before)
    expect(presented[0]!.attachments).toBe(f.messages[0]!.attachments)
    expect(projectWatcherMessages(f.request.watcher.hostId, f.request.watcher.threadId, presented, f.record.requests)).toBe(presented)
  })
  it('keeps an exact literal footer inside the proven original and supports delivered follow-ups', () => {
    const f = fixture(), original = `${f.original}\n\n[Sotto Watcher request: literal. Call list_projects for choices.]`
    const wire = `${original}\n\nActual injected context`
    f.request.userFollowups = [{ draftId: f.request.id, messageId: 'follow-up', displayPrompt: watcherDisplayPrompt(original, wire) }]
    f.messages.push({ id: 'follow-up', role: 'user', text: wire, createdAt: f.request.createdAt })
    expect(f.show().map(message => message.text)).toEqual([f.original, original])
  })
  it.each(['host', 'thread', 'id', 'role', 'digest', 'native edit', 'partial', 'absent proof'] as const)(
    'keeps %s messages whole without guessing their original boundary', scenario => {
      const f = fixture()
      if (scenario === 'host') f.request.watcher.hostId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      if (scenario === 'thread') f.request.watcher.threadId = 'foreign-thread'
      if (scenario === 'id') f.messages[0]!.id = 'foreign-message'
      if (scenario === 'role') f.messages[0]!.role = 'assistant'
      if (scenario === 'digest') f.request.displayPrompt!.wireDigest = '0'.repeat(64)
      if (scenario === 'native edit') f.messages[0]!.text = 'i' + f.wire.slice(1)
      if (scenario === 'partial') f.messages[0]!.text = f.wire.slice(0, -1)
      if (scenario === 'absent proof') delete f.request.displayPrompt
      const own = f.owner
      expect(projectWatcherMessages(own.hostId, own.threadId, f.messages, f.record.requests)).toBe(f.messages)
    })
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, 'split emoji'] as const)('refuses an invalid UTF-16 boundary %s', value => {
    const f = fixture()
    f.request.displayPrompt!.originalLength = value === 'split emoji' ? f.original.indexOf('😃') + 1 : value
    expect(f.show()).toBe(f.messages)
  })
  it('retains closed request proofs and fails closed for conflicting duplicate message ownership', () => {
    const f = fixture()
    f.request.state = 'closed'; f.request.closedAt = f.request.createdAt
    expect(f.show()[0]!.text).toBe(f.original)
    f.request.userFollowups = [{ draftId: f.request.id, messageId: f.request.rootUserMessageId,
      displayPrompt: { ...f.request.displayPrompt!, originalLength: 1 } }]
    expect(f.show()).toBe(f.messages)
  })
  it('returns ordinary and not-ready input by identity', () => {
    const f = fixture()
    expect(projectWatcherMessages(undefined, f.request.watcher.threadId, f.messages, f.record.requests)).toBe(f.messages)
    expect(projectWatcherMessages(f.request.watcher.hostId, 'ordinary-thread', f.messages, f.record.requests)).toBe(f.messages)
  })
  it('shares exact text verification through unrelated metadata changes and prunes the current window cache', () => {
    const f = fixture(), display = new WatcherMessageDisplay()
    display.update(f.record.requests); display.retain(f.owner.hostId, [f.owner.threadId]); vi.mocked(createHash).mockClear()
    expect(display.project(f.request.watcher.hostId, 'ordinary', f.messages)).toBe(f.messages)
    expect(createHash).not.toHaveBeenCalled()
    expect(display.project(f.request.watcher.hostId, f.request.watcher.threadId, f.messages)[0]!.text).toBe(f.original)
    for (let chunk = 0; chunk < 4; chunk++) {
      const records = structuredClone(f.record.requests); records[0]!.participants = []
      display.update(records)
      const current = [...structuredClone(f.messages), { id: 'reply', role: 'assistant' as const, text: 'Streaming '.repeat(chunk + 1), createdAt: f.request.createdAt }]
      expect(display.project(f.request.watcher.hostId, f.request.watcher.threadId, current)[0]!.text).toBe(f.original)
    }
    expect(createHash).toHaveBeenCalledTimes(1)
    display.project(f.request.watcher.hostId, f.request.watcher.threadId, [])
    display.project(f.request.watcher.hostId, f.request.watcher.threadId, f.messages)
    expect(createHash).toHaveBeenCalledTimes(2)
    const changed = structuredClone(f.record.requests); changed[0]!.displayPrompt!.wireDigest = '0'.repeat(64)
    display.update(changed)
    expect(display.project(f.request.watcher.hostId, f.request.watcher.threadId, f.messages)).toBe(f.messages)
    expect(createHash).toHaveBeenCalledTimes(3)
  })
  it('releases closed owner text without forgetting its proof or retaining offscreen reads', () => {
    const f = fixture(), display = new WatcherMessageDisplay()
    display.update(f.record.requests); display.retain(f.owner.hostId, [f.owner.threadId]); vi.mocked(createHash).mockClear()
    const show = () => display.project(f.owner.hostId, f.owner.threadId, f.messages)
    expect(show()[0]!.text).toBe(f.original); expect(show()[0]!.text).toBe(f.original)
    expect(createHash).toHaveBeenCalledTimes(1)
    display.retain(f.owner.hostId, [])
    expect(show()[0]!.text).toBe(f.original); expect(show()[0]!.text).toBe(f.original)
    expect(createHash).toHaveBeenCalledTimes(3)
    display.retain(f.owner.hostId, [f.owner.threadId])
    expect(show()[0]!.text).toBe(f.original); expect(show()[0]!.text).toBe(f.original)
    expect(createHash).toHaveBeenCalledTimes(4)
    display.retain(undefined, [])
    expect(show()[0]!.text).toBe(f.original)
    expect(createHash).toHaveBeenCalledTimes(5)
  })
})

// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { watcherRecordForDisk } from '../../../src/main/agents/watcherRecords'
import type { WatcherRecord } from '../../../src/shared/watcher'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'
import { watcherRecordFixture } from '../../fixtures/watcher'

/** What these tests reach inside the coordinator: the saved state, its serialization and the fields it is built from. */
type Inside = {
  state: { configuration: { defaultModelId: string }; deliveredDrafts?: { threadId: string; draftId: string }[]; obsoleteDrafts?: { threadId: string; draftId: string }[]; activeThreadId: string | null; draftRequestId?: string | null | undefined }
  watcher: WatcherRecord
  deliveredPromptDigests: { threadId: string; draftId: string; digest: string }[]
  answeredRequests: { threadId: string; provider: string; requestId: string; questionsDigest: string }[]
  savedOverLiveState(): Record<string, unknown>
  store: { write(value: unknown, compact?: string): Promise<void> }
  persist(closing?: boolean): Promise<void>
  savedWhole(saved: unknown): unknown
  mutateWatcher(update: (record: WatcherRecord) => void): void
}

const roots: string[] = []
const controls: AgentControl[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-saved-sections-'))
  roots.push(root)
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const host = new E2EAgentHost()
  const control = createAgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner })
  controls.push(control)
  await control.start()
  const inside = control as unknown as Inside
  const file = async (): Promise<string> => readFile(join(root, 'agents.json'), 'utf8')
  /** What the code before #1332 wrote for the state as it is now: `JSON.stringify` of all of it, and the store's newline. */
  const stringified = (): string => `${JSON.stringify(inside.savedOverLiveState())}\n`
  return { root, control, inside, file, stringified }
}

/** A Watcher record with more reservations than the file keeps, so its disk view is a copy rather than the record. */
function bigWatcherRecord(): WatcherRecord {
  const record = watcherRecordFixture()
  const reservation = record.reservations[0]!, operation = record.operations[0]!
  const ids = Array.from({ length: 12 }, () => randomUUID())
  record.operations = ids.map((id, index) => ({ ...operation, id, retryKey: randomUUID(), target: { ...operation.target, threadId: `thread-${index}` } }))
  record.reservations = ids.map((id, index) => ({ ...reservation, operationId: id, target: { ...reservation.target, threadId: `thread-${index}` } }))
  record.wakeEventIds = Array.from({ length: 200 }, () => randomUUID())
  return record
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('agents.json sections', () => {
  it('serializes to exactly what JSON.stringify of the saved state gives, and writes those bytes', async () => {
    const { inside, file, stringified } = await fixture()
    inside.mutateWatcher(record => Object.assign(record, bigWatcherRecord()))
    inside.deliveredPromptDigests = [{ threadId: 'a', draftId: randomUUID(), digest: 'd1' }]
    inside.answeredRequests = [{ threadId: 'a', provider: 'codex', requestId: 'r1', questionsDigest: 'q1' }]
    inside.state.deliveredDrafts = [{ threadId: 'a', draftId: randomUUID() }]
    inside.state.obsoleteDrafts = [{ threadId: 'b', draftId: randomUUID() }]
    for (let round = 0; round < 3; round++) {
      await inside.persist()
      expect(await file()).toBe(stringified())
      inside.state.configuration.defaultModelId = `model-${round}`
    }
    // A key whose value serializes to nothing is left out, as JSON.stringify leaves it out.
    inside.state.draftRequestId = undefined
    await inside.persist()
    expect(await file()).toBe(stringified())
    expect(await file()).not.toContain('"draftRequestId"')
    expect(JSON.parse(await file()).watcher).toEqual(JSON.parse(JSON.stringify(watcherRecordForDisk(inside.watcher))))
  })

  it('writes a change to every section, whether it is edited in place or replaced', async () => {
    const { inside, file, stringified } = await fixture()
    await inside.persist()
    const changes: [string, () => void, (saved: Record<string, unknown>) => unknown][] = [
      ['configuration', () => { inside.state.configuration.defaultModelId = 'edited-in-place' }, saved => (saved.configuration as { defaultModelId: string }).defaultModelId],
      ['activeThreadId', () => { inside.state.activeThreadId = 'workshop' }, saved => saved.activeThreadId],
      ['watcher', () => inside.mutateWatcher(record => { record.wakeEventIds = ['wake-1'] }), saved => (saved.watcher as WatcherRecord).wakeEventIds],
      ['watcher, past eight reservations', () => inside.mutateWatcher(record => Object.assign(record, bigWatcherRecord())), saved => (saved.watcher as WatcherRecord).reservations.length],
      ['watcher, again', () => inside.mutateWatcher(record => { record.wakeEventIds = ['wake-2'] }), saved => (saved.watcher as WatcherRecord).wakeEventIds],
      ['deliveredPromptDigests', () => { inside.deliveredPromptDigests = [...inside.deliveredPromptDigests, { threadId: 'a', draftId: randomUUID(), digest: 'd' }] }, saved => (saved.deliveredPromptDigests as unknown[]).length],
      ['answeredRequests', () => { inside.answeredRequests = [...inside.answeredRequests, { threadId: 'a', provider: 'codex', requestId: 'r', questionsDigest: 'q' }] }, saved => (saved.answeredRequests as unknown[]).length],
      ['deliveredDrafts', () => { inside.state.deliveredDrafts = [...inside.state.deliveredDrafts ?? [], { threadId: 'a', draftId: randomUUID() }] }, saved => (saved.deliveredDrafts as unknown[]).length],
      ['obsoleteDrafts', () => { inside.state.obsoleteDrafts = [...inside.state.obsoleteDrafts ?? [], { threadId: 'a', draftId: randomUUID() }] }, saved => (saved.obsoleteDrafts as unknown[]).length],
    ]
    for (const [, change, read] of changes) {
      const before = await file()
      change()
      await inside.persist()
      const after = await file()
      expect(after).not.toBe(before)
      expect(after).toBe(stringified())
      expect(read(JSON.parse(after))).toEqual(read(JSON.parse(JSON.stringify(inside.savedOverLiveState()))))
    }
  })

  it('serializes no replaced section again on a save with nothing new, and writes nothing', async () => {
    const { inside, file } = await fixture()
    inside.mutateWatcher(record => Object.assign(record, bigWatcherRecord()))
    inside.deliveredPromptDigests = [{ threadId: 'a', draftId: randomUUID(), digest: 'd1' }]
    inside.answeredRequests = [{ threadId: 'a', provider: 'codex', requestId: 'r1', questionsDigest: 'q1' }]
    await inside.persist()
    const written = await file()
    const replaced = new Set<unknown>([inside.watcher, inside.deliveredPromptDigests, inside.answeredRequests, inside.state.deliveredDrafts, inside.state.obsoleteDrafts])
    const write = vi.spyOn(inside.store, 'write')
    const stringify = vi.spyOn(JSON, 'stringify')
    await inside.persist()
    const serializedValues = stringify.mock.calls.map(([value]) => value)
    stringify.mockRestore()
    expect(write).not.toHaveBeenCalled()
    // Neither the whole state nor any section that is only replaced was serialized for this save: the state was serialized
    // once, with a stand-in for each replaced section, as often as it was before.
    const states = serializedValues.filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && 'configuration' in value && 'watcher' in value)
    expect(states).toHaveLength(1)
    expect(typeof states[0]!.watcher).toBe('string')
    expect(serializedValues.some(value => replaced.has(value) || (value !== null && typeof value === 'object' && 'reservations' in value && 'operations' in value))).toBe(false)
    expect(await file()).toBe(written)
  })

  it('serializes the state whole when a stand-in for a section turns up in what the user wrote', async () => {
    const { inside, file, stringified } = await fixture()
    await inside.persist()
    const whole = vi.spyOn(inside, 'savedWhole')
    // A key named like a section, holding a stand-in's exact words, ahead of the section itself.
    Object.assign(inside.state.configuration, { watcher: '\u0000sotto-saved-section\u0000watcher' })
    const write = vi.spyOn(inside.store, 'write')
    await inside.persist()
    expect(whole).toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
    expect(await file()).toBe(stringified())
    // And with nothing new after it, nothing is written again.
    await inside.persist()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('serializes the state whole when the markers around a section not kept yet turn up in what the user wrote', async () => {
    const { inside, file, stringified } = await fixture()
    await inside.persist()
    const whole = vi.spyOn(inside, 'savedWhole')
    // The opening marker of a section not kept yet, followed by that section's own name, exactly as the serialization
    // writes it, ahead of the section itself: the marker is then found twice.
    Object.assign(inside.state.configuration, { '\u0000sotto-saved-section-before\u0000deliveredDrafts': 0, deliveredDrafts: [] })
    inside.state.deliveredDrafts = [{ threadId: 'a', draftId: randomUUID() }]
    const write = vi.spyOn(inside.store, 'write')
    await inside.persist()
    expect(whole).toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
    expect(await file()).toBe(stringified())
  })

  it('refuses a write into a section whose text it keeps', async () => {
    const { inside } = await fixture()
    await inside.persist()
    expect(() => { inside.watcher.wakeEventIds = ['edited'] }).toThrow(TypeError)
    expect(() => { (inside.watcher.requests as unknown[]).push({}) }).toThrow(TypeError)
    expect(() => { inside.answeredRequests.push({ threadId: 'a', provider: 'codex', requestId: 'r', questionsDigest: 'q' }) }).toThrow(TypeError)
    expect(() => { inside.state.deliveredDrafts!.push({ threadId: 'a', draftId: randomUUID() }) }).toThrow(TypeError)
    // The coordinator's own way to change the record still works.
    inside.mutateWatcher(record => { record.wakeEventIds = ['changed'] })
    expect(inside.watcher.wakeEventIds).toEqual(['changed'])
  })
})

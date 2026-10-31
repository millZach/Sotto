// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { watcherRecordForDisk } from '../../../src/main/agents/watcherRecords'
import { WATCHER_RECORD_FILE } from '../../../src/main/agents/watcherRecordFile'
import type { WatcherRecord } from '../../../src/shared/watcher'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'
import { watcherRecordFixture } from '../../fixtures/watcher'
import { deferred } from '../../fixtures/deferred'

/** What these tests reach inside the coordinator: the saved state, its serialization and the fields it is built from. */
type Inside = {
  state: { configuration: { defaultModelId: string }; deliveredDrafts?: { threadId: string; draftId: string }[]; obsoleteDrafts?: { threadId: string; draftId: string }[]; activeThreadId: string | null; draftRequestId?: string | null | undefined }
  watcher: WatcherRecord
  deliveredPromptDigests: { threadId: string; draftId: string; digest: string }[]
  answeredRequests: { threadId: string; provider: string; requestId: string; questionsDigest: string }[]
  savedOverLiveState(): Record<string, unknown>
  store: { write(value: unknown, compact?: string): Promise<void> }
  watcherStore: { writeSerialized(serialized: string): Promise<void> }
  persist(closing?: boolean): Promise<void>
  savedWhole(saved: unknown): unknown
  mutateWatcher(update: (record: WatcherRecord) => void): void
}

const roots: string[] = []
const controls: AgentControl[] = []

async function fixture(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-saved-sections-'))
  roots.push(root)
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const host = new E2EAgentHost()
  const control = createAgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner })
  controls.push(control)
  await control.start()
  const inside = control as unknown as Inside
  const file = async (): Promise<string> => readFile(join(root, 'agents.json'), 'utf8')
  const watcherFile = async (): Promise<string> => readFile(join(root, WATCHER_RECORD_FILE), 'utf8')
  /**
   * What the code before #1332 wrote for the state as it is now, `JSON.stringify` of all of it and the store's newline,
   * but Watcher's record, which has a file of its own (`watcherStringified`).
   */
  const stringified = (): string => { const { watcher, ...rest } = inside.savedOverLiveState(); void watcher; return `${JSON.stringify(rest)}\n` }
  const watcherStringified = (): string => `${JSON.stringify({ watcher: inside.savedOverLiveState().watcher })}\n`
  return { root, control, inside, file, watcherFile, stringified, watcherStringified }
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
    const { inside, file, watcherFile, stringified, watcherStringified } = await fixture()
    inside.mutateWatcher(record => Object.assign(record, bigWatcherRecord()))
    inside.deliveredPromptDigests = [{ threadId: 'a', draftId: randomUUID(), digest: 'd1' }]
    inside.answeredRequests = [{ threadId: 'a', provider: 'codex', requestId: 'r1', questionsDigest: 'q1' }]
    inside.state.deliveredDrafts = [{ threadId: 'a', draftId: randomUUID() }]
    inside.state.obsoleteDrafts = [{ threadId: 'b', draftId: randomUUID() }]
    for (let round = 0; round < 3; round++) {
      await inside.persist()
      expect(await file()).toBe(stringified())
      expect(await watcherFile()).toBe(watcherStringified())
      inside.state.configuration.defaultModelId = `model-${round}`
    }
    // A key whose value serializes to nothing is left out, as JSON.stringify leaves it out.
    inside.state.draftRequestId = undefined
    await inside.persist()
    expect(await file()).toBe(stringified())
    expect(await file()).not.toContain('"draftRequestId"')
    expect(JSON.parse(await watcherFile()).watcher).toEqual(JSON.parse(JSON.stringify(watcherRecordForDisk(inside.watcher))))
    expect(JSON.parse(await file())).not.toHaveProperty('watcher')
  })

  it('writes a change to every section, whether it is edited in place or replaced', async () => {
    const { inside, file, watcherFile, stringified, watcherStringified } = await fixture()
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
    for (const [section, change, read] of changes) {
      // Watcher's record is written to its own file, everything else to agents.json.
      const [saved, expected] = section.startsWith('watcher') ? [watcherFile, watcherStringified] : [file, stringified]
      const before = await saved()
      change()
      await inside.persist()
      const after = await saved()
      expect(after).not.toBe(before)
      expect(after).toBe(expected())
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
    const write = vi.spyOn(inside.store, 'write'), watcherWrite = vi.spyOn(inside.watcherStore, 'writeSerialized')
    const stringify = vi.spyOn(JSON, 'stringify')
    await inside.persist()
    const serializedValues = stringify.mock.calls.map(([value]) => value)
    stringify.mockRestore()
    expect(write).not.toHaveBeenCalled()
    expect(watcherWrite).not.toHaveBeenCalled()
    // Neither the whole state, Watcher's record nor any section that is only replaced was serialized for this save: the
    // state was serialized once, with a stand-in for each replaced section, as often as it was before.
    const states = serializedValues.filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && 'configuration' in value)
    expect(states).toHaveLength(1)
    expect(states[0]).not.toHaveProperty('watcher')
    expect(typeof states[0]!.deliveredDrafts).toBe('string')
    expect(serializedValues.some(value => replaced.has(value) || (value !== null && typeof value === 'object' && 'reservations' in value && 'operations' in value))).toBe(false)
    expect(await file()).toBe(written)
  })

  it('serializes the state whole when a stand-in for a section turns up in what the user wrote', async () => {
    const { inside, file, stringified } = await fixture()
    await inside.persist()
    const whole = vi.spyOn(inside, 'savedWhole')
    // A key named like a section, holding a stand-in's exact words, ahead of the section itself.
    Object.assign(inside.state.configuration, { deliveredDrafts: '\u0000sotto-saved-section\u0000deliveredDrafts' })
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

describe('Watcher\u2019s own file', () => {
  it('writes only agents.json for a save that leaves Watcher\u2019s record as it was, and Watcher\u2019s file when it changed', async () => {
    const { inside, file, watcherFile } = await fixture()
    inside.mutateWatcher(record => Object.assign(record, bigWatcherRecord()))
    await inside.persist()
    const write = vi.spyOn(inside.store, 'write'), watcherWrite = vi.spyOn(inside.watcherStore, 'writeSerialized')
    // A pause in typing, a thread selected: agents.json alone, without the record that was most of it.
    inside.state.activeThreadId = 'workshop'
    await inside.persist()
    expect(write).toHaveBeenCalledTimes(1)
    expect(watcherWrite).not.toHaveBeenCalled()
    expect(Buffer.byteLength(await file())).toBeLessThan(Buffer.byteLength(await watcherFile()) / 4)
    inside.mutateWatcher(record => { record.wakeEventIds = ['wake-1'] })
    await inside.persist()
    expect(watcherWrite).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('writes Watcher\u2019s file before agents.json, and leaves agents.json as it was when Watcher\u2019s file is not written', async () => {
    const { inside, file, watcherFile, stringified, watcherStringified } = await fixture()
    await inside.persist()
    const order: string[] = []
    const write = inside.store.write.bind(inside.store), watcherWrite = inside.watcherStore.writeSerialized.bind(inside.watcherStore)
    let failWatcher = true
    vi.spyOn(inside.store, 'write').mockImplementation(async (...args) => { order.push('agents.json'); return write(...args) })
    vi.spyOn(inside.watcherStore, 'writeSerialized').mockImplementation(async serialized => {
      order.push(WATCHER_RECORD_FILE)
      if (failWatcher) { failWatcher = false; throw new Error('Synthetic disk failure') }
      return watcherWrite(serialized)
    })
    const agentsBefore = await file(), watcherBefore = await watcherFile()
    inside.mutateWatcher(record => { record.wakeEventIds = ['wake-1'] })
    inside.state.activeThreadId = 'workshop'
    await expect(inside.persist()).rejects.toThrow('Synthetic disk failure')
    expect(order).toEqual([WATCHER_RECORD_FILE])
    expect(await file()).toBe(agentsBefore)
    expect(await watcherFile()).toBe(watcherBefore)
    // The next save writes both, Watcher's first.
    await inside.persist()
    expect(order).toEqual([WATCHER_RECORD_FILE, WATCHER_RECORD_FILE, 'agents.json'])
    expect(await watcherFile()).toBe(watcherStringified())
    expect(await file()).toBe(stringified())
  })

  it('writes Watcher\u2019s file again after a failed write that a record serializing to the same text took over (review)', async () => {
    const { inside, watcherFile, watcherStringified } = await fixture()
    await inside.persist()
    const write = inside.watcherStore.writeSerialized.bind(inside.watcherStore), landed = deferred<void>()
    let writes = 0
    vi.spyOn(inside.watcherStore, 'writeSerialized').mockImplementation(async serialized => {
      writes++
      if (writes === 1) { await landed.promise; throw new Error('Synthetic disk failure') }
      return write(serialized)
    })
    inside.mutateWatcher(record => { record.wakeEventIds = ['wake-1'] })
    const first = inside.persist()
    // Another record whose saved text is the same, as when only reservations past the eight saved changed.
    inside.watcher = Object.freeze({ ...inside.watcher })
    const second = inside.persist()
    landed.resolve()
    await expect(first).rejects.toThrow('Synthetic disk failure')
    await expect(second).rejects.toThrow('Synthetic disk failure')
    await inside.persist()
    expect(writes).toBe(2)
    expect(await watcherFile()).toBe(watcherStringified())
  })

  it('reads the record a store saved before Watcher had a file of its own kept in agents.json, and moves it across', async () => {
    const first = await fixture()
    first.inside.mutateWatcher(record => Object.assign(record, bigWatcherRecord()))
    await first.inside.persist()
    const record = JSON.parse(await first.watcherFile()) as { watcher: WatcherRecord }
    first.control.dispose(); await first.control.closed()
    // As a build before this one left it: the record in agents.json, and no file of Watcher's own.
    await writeFile(join(first.root, 'agents.json'), JSON.stringify({ ...JSON.parse(await first.file()) as object, watcher: record.watcher }))
    await rm(join(first.root, WATCHER_RECORD_FILE))
    const reopened = await fixture(first.root)
    expect(reopened.inside.watcher).toEqual(record.watcher)
    reopened.inside.state.activeThreadId = 'workshop'
    await reopened.inside.persist()
    expect(JSON.parse(await reopened.watcherFile())).toEqual(record)
    expect(JSON.parse(await reopened.file())).not.toHaveProperty('watcher')
  })

  it('reads Watcher\u2019s own file over a record agents.json still holds, as after a crash while the record moved across', async () => {
    const first = await fixture()
    first.inside.mutateWatcher(record => { record.wakeEventIds = ['newer'] })
    await first.inside.persist()
    first.control.dispose(); await first.control.closed()
    const older = watcherRecordFixture()
    await writeFile(join(first.root, 'agents.json'), JSON.stringify({ ...JSON.parse(await first.file()) as object, watcher: older }))
    const reopened = await fixture(first.root)
    expect(reopened.inside.watcher.wakeEventIds).toEqual(['newer'])
  })
})

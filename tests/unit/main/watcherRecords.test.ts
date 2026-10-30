// @vitest-environment node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateWatcherRecord, migrateWorkspaceThreadKinds, prunePromptTurns, WATCHER_PROMPT_TURNS_KEPT } from '../../../src/main/agents/watcherRecords'
import { agentThreadSchema } from '../../../src/shared/agents'
import { emptyWatcherRecord, watcherRecordSchema } from '../../../src/shared/watcher'
import { watcherRecordFixture } from '../../fixtures/watcher'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { WatcherService } from '../../../src/main/agents/watcher'
import { WatcherToolServer } from '../../../src/main/agents/watcherTools'
import { speedRuns } from '../../../src/main/agents/threadOptions'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('watcher records and workspace migration', () => {
  it('keeps a first-entry speed from its source model without allowing unsupported explicit selections', async () => {
    const workspace = await workspaceFixture(undefined, { history: false })
    const source = workspace.adapters.codex.state.models[0]!
    source.speeds = [{ id: 'ultrafast', name: 'Ultrafast' }]
    workspace.adapters.codex.state.models.push({ ...source, id: 'plain', name: 'Plain', speeds: [] })
    const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
      control: { historyEnabled: () => false, watcherEnabled: true } })
    const watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false })
    const tools = new WatcherToolServer(watcher)
    workspace.host.useWatcherTools(tools)
    cleanup.push(async () => { watcher.close(); await tools.close(); await f.dispose(); await workspace.stop(); await workspace.remove() })
    await f.control.start()
    await f.control.commandShell({ type: 'connect', provider: 'codex' })
    const models = f.control.watcherSnapshot().models
    const fast = models.find(model => model.providerId === 'codex' && model.speeds?.length)!.id
    const plain = models.find(model => model.providerId === 'codex' && model.speeds?.length === 0)!.id
    const choice = { provider: 'codex' as const, modelId: plain, speed: 'ultrafast' as const }
    for (const input of [choice, { ...choice, speedSourceModelId: plain }, { ...choice, speedSourceModelId: 'missing' }]) {
      expect(await watcher.open(input)).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
      expect(f.control.watcherRecord().current).toBeNull()
    }
    const opened = await watcher.open({ ...choice, speedSourceModelId: fast })
    expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'ok' })
    const threadId = watcher.state().current!.target.threadId
    expect(watcher.state().currentOptions).toMatchObject({ modelId: plain, speed: 'ultrafast' })
    expect(speedRuns(f.control.watcherSnapshot(), plain, 'ultrafast')).toBeNull()
    expect(f.control.watcherRecord().creation).toBeNull()
    // Source metadata cannot turn an explicit reconfiguration into a saved choice.
    expect(await watcher.open({ ...choice, speedSourceModelId: fast })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
    expect(await f.control.commandShell({ type: 'configure-thread', threadId, speed: 'ultrafast' })).toMatchObject({ error: 'This model does not offer ultrafast speed.' })
    expect(await watcher.open({ provider: 'codex', modelId: fast })).toMatchObject({ status: 'ok' })
    expect(watcher.state().currentOptions).toMatchObject({ modelId: fast, speed: 'ultrafast' })
    expect(speedRuns(f.control.watcherSnapshot(), fast, 'ultrafast')).toBe('ultrafast')
  })

  it('defaults only a missing record and never repairs conflicting identities or unknown prose silently', () => {
    expect(migrateWatcherRecord(undefined)).toEqual(emptyWatcherRecord())
    expect(migrateWatcherRecord(watcherRecordFixture())).toEqual(watcherRecordFixture())
    for (const input of [null, { ...emptyWatcherRecord(), version: 2 }, { ...emptyWatcherRecord(), prompt: 'private' }]) {
      expect(() => migrateWatcherRecord(input)).toThrow()
    }
    const record = watcherRecordFixture()
    record.creation = { identity: { ...record.current!, target: { ...record.current!.target, threadId: 'another' } }, phase: 'intent', replaces: null }
    expect(() => migrateWatcherRecord(record)).toThrow()
  })
  it('retains the old current identity while a replacement is only an intent', () => {
    const record = watcherRecordFixture()
    record.creation = { identity: { ...record.current!, target: { ...record.current!.target, threadId: 'replacement' }, provider: 'claude' },
      phase: 'intent', replaces: record.current!.target }
    expect(migrateWatcherRecord(record)).toEqual(record)
    expect(() => migrateWatcherRecord({ ...record, creation: { ...record.creation, replaces: { ...record.current!.target, threadId: 'wrong-current' } } })).toThrow()
    expect(() => migrateWatcherRecord({ ...record, creation: { ...record.creation, identity: record.current } })).toThrow()
  })
  it('migrates only absent workspace kinds, preserving current and retired roles without mutating input', () => {
    const input = { threads: [{ id: 'old' }, { id: 'current', kind: 'watcher' }, { id: 'retired', kind: 'watcher-history' }] }
    expect(migrateWorkspaceThreadKinds(input)).toEqual({ threads: [{ id: 'old', kind: 'project' }, input.threads[1], input.threads[2]] })
    expect(input.threads[0]).not.toHaveProperty('kind')
    const base = { id: 'old', projectId: 'p', title: 'Old', modelId: 'm', status: 'idle', messages: [], requests: [] }
    expect(agentThreadSchema.safeParse({ ...base, kind: 'invented' }).success).toBe(false)
    expect(agentThreadSchema.safeParse(base).success).toBe(true)
  })
  it('loads old workspace files and preserves special kinds through native refresh and restart', async () => {
    const f = await workspaceFixture()
    cleanup.push(async () => { await f.stop(); await f.remove() })
    await f.host.connect()
    const project = f.host.workspaceSnapshot().projects[0]!
    const model = f.host.workspaceSnapshot().models[0]!
    for (const threadId of ['ordinary', 'center', 'retired']) await f.host.execute({ type: 'create-thread', commandId: `create-${threadId}`,
      threadId, projectId: project.id, modelId: model.id, title: 'Watcher' })
    await f.stop()
    const path = join(f.root, 'workspace.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    for (const thread of saved.snapshot.threads) {
      if (thread.id === 'ordinary') delete thread.kind
      else thread.kind = thread.id === 'center' ? 'watcher' : 'watcher-history'
    }
    await writeFile(path, JSON.stringify(saved), 'utf8')
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    const check = () => {
      const threads = reopened.host.workspaceSnapshot().threads
      expect(threads.find(thread => thread.id === 'ordinary')?.kind).toBe('project')
      expect(threads.find(thread => thread.id === 'center')?.kind).toBe('watcher')
      expect(threads.find(thread => thread.id === 'retired')?.kind).toBe('watcher-history')
    }
    check(); await reopened.host.connect(); check(); await reopened.stop()
    expect((await readdir(f.root)).some(name => name.includes('.corrupt-'))).toBe(false)
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted.snapshot.threads.find((thread: { id: string }) => thread.id === 'center').kind).toBe('watcher')
  })
})

describe('prompt turns Watcher keeps', () => {
  const turn = (index: number, threadId = 'center') => ({ id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    watcher: { hostId: '11111111-1111-4111-8111-111111111111', threadId }, createdAt: '2026-10-17T12:00:00.000Z', rootUserMessageId: `message-${index}` })

  it('keeps every turn while there are few', () => {
    const record = watcherRecordFixture()
    record.promptTurns = Array.from({ length: WATCHER_PROMPT_TURNS_KEPT }, (_, index) => turn(index))
    prunePromptTurns(record)
    expect(record.promptTurns).toHaveLength(WATCHER_PROMPT_TURNS_KEPT)
  })

  it('keeps the turns operations count against, each Watcher\'s newest and the most recent, in order', () => {
    const record = watcherRecordFixture()
    // An earlier Watcher's only turn, a turn an operation still counts against, then many newer turns of the current Watcher.
    record.promptTurns = [turn(0, 'earlier'), ...Array.from({ length: 600 }, (_, index) => turn(index + 1))]
    record.operations[0]!.promptTurnId = turn(5).id
    prunePromptTurns(record)
    expect(record.promptTurns.map(item => item.id)).toEqual([turn(0, 'earlier').id, turn(5).id,
      ...Array.from({ length: WATCHER_PROMPT_TURNS_KEPT }, (_, index) => turn(600 - WATCHER_PROMPT_TURNS_KEPT + 1 + index).id)])
    // What is left is still a record the schema accepts.
    expect(() => watcherRecordSchema.parse(record)).not.toThrow()
  })

  it.each([['Owl', true], ['stable', false]] as const)('lets go of the turns nothing reads on %s only, and keeps the record when nothing changes after', async (_track, owl) => {
    const workspace = await workspaceFixture(undefined, { history: false, watcherEnabled: owl })
    const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
      control: { historyEnabled: () => false, watcherEnabled: owl } })
    cleanup.push(async () => { await f.dispose(); await workspace.stop(); await workspace.remove() })
    await f.control.start()
    f.control.mutateWatcher(record => { record.promptTurns = Array.from({ length: 120 }, (_, index) => turn(index)) })
    // Stable keeps Watcher's saved record whole (ADR-0072).
    expect(f.control.watcherRecordView().promptTurns).toHaveLength(owl ? WATCHER_PROMPT_TURNS_KEPT : 120)
    const trimmed = f.control.watcherRecordView()
    f.control.mutateWatcher(() => undefined)
    expect(f.control.watcherRecordView()).toBe(trimmed)
  })
})

// @vitest-environment node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateCommandCenterRecord, migrateWorkspaceThreadKinds } from '../../../src/main/agents/commandCenterRecords'
import { agentThreadSchema } from '../../../src/shared/agents'
import { emptyCommandCenterRecord } from '../../../src/shared/commandCenter'
import { commandCenterRecordFixture } from '../../fixtures/commandCenter'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('command-center records and workspace migration', () => {
  it('defaults only a missing record and never repairs conflicting identities or unknown prose silently', () => {
    expect(migrateCommandCenterRecord(undefined)).toEqual(emptyCommandCenterRecord())
    expect(migrateCommandCenterRecord(commandCenterRecordFixture())).toEqual(commandCenterRecordFixture())
    for (const input of [null, { ...emptyCommandCenterRecord(), version: 2 }, { ...emptyCommandCenterRecord(), prompt: 'private' }]) {
      expect(() => migrateCommandCenterRecord(input)).toThrow()
    }
    const record = commandCenterRecordFixture()
    record.creation = { identity: { ...record.current!, target: { ...record.current!.target, threadId: 'another' } }, phase: 'intent', replaces: null }
    expect(() => migrateCommandCenterRecord(record)).toThrow()
  })
  it('retains the old current identity while a replacement is only an intent', () => {
    const record = commandCenterRecordFixture()
    record.creation = { identity: { ...record.current!, target: { ...record.current!.target, threadId: 'replacement' }, provider: 'claude' },
      phase: 'intent', replaces: record.current!.target }
    expect(migrateCommandCenterRecord(record)).toEqual(record)
    expect(() => migrateCommandCenterRecord({ ...record, creation: { ...record.creation, replaces: { ...record.current!.target, threadId: 'wrong-current' } } })).toThrow()
    expect(() => migrateCommandCenterRecord({ ...record, creation: { ...record.creation, identity: record.current } })).toThrow()
  })
  it('migrates only absent workspace kinds, preserving current and retired roles without mutating input', () => {
    const input = { threads: [{ id: 'old' }, { id: 'current', kind: 'command-center' }, { id: 'retired', kind: 'command-center-history' }] }
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
      threadId, projectId: project.id, modelId: model.id, title: 'Command center' })
    await f.stop()
    const path = join(f.root, 'workspace.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    for (const thread of saved.snapshot.threads) {
      if (thread.id === 'ordinary') delete thread.kind
      else thread.kind = thread.id === 'center' ? 'command-center' : 'command-center-history'
    }
    await writeFile(path, JSON.stringify(saved), 'utf8')
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    const check = () => {
      const threads = reopened.host.workspaceSnapshot().threads
      expect(threads.find(thread => thread.id === 'ordinary')?.kind).toBe('project')
      expect(threads.find(thread => thread.id === 'center')?.kind).toBe('command-center')
      expect(threads.find(thread => thread.id === 'retired')?.kind).toBe('command-center-history')
    }
    check(); await reopened.host.connect(); check(); await reopened.stop()
    expect((await readdir(f.root)).some(name => name.includes('.corrupt-'))).toBe(false)
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted.snapshot.threads.find((thread: { id: string }) => thread.id === 'center').kind).toBe('command-center')
  })
})

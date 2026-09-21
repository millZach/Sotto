// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import type { AgentActivity } from '../../../src/shared/agentActivity'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(history: () => boolean = () => true, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-activity-persistence-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-activity-persistence-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  const provider = new FakeProviderHost()
  provider.state.threads[0]!.activities = [activity('old', 'Retained tool output')]
  if (legacy) await writeFile(join(directory, 'workspace.json'), JSON.stringify({ snapshot: provider.state, creations: [], projectAliases: [] }))
  const closed = new Set<WorkspaceHost>()
  const close = async (host: WorkspaceHost) => {
    if (closed.has(host)) return
    host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose(); closed.add(host)
  }
  const open = async () => {
    const host = new WorkspaceHost(provider, directory, history)
    cleanup.push(() => close(host))
    await host.initialize()
    return host
  }
  return { directory, provider, open, close }
}
function activity(id: string, output: string): AgentActivity {
  return { id, turnId: 'turn', sequence: id === 'old' ? 0 : 1, kind: 'tool', status: 'completed', title: 'Tool', output,
    changes: [{ path: 'file.txt', kind: 'modify', diff: 'Retained diff' }] }
}

it('migrates legacy activity without putting output back in workspace JSON and retains it after restart', async () => {
  const f = await fixture(() => true, true)
  const host = await f.open()
  expect(host.workspaceSnapshot().threads[0]!.activities).toEqual(f.provider.state.threads[0]!.activities)
  const saved = await readFile(join(f.directory, 'workspace.json'), 'utf8')
  expect(saved).not.toContain('Retained tool output')
  expect(saved).not.toContain('Retained diff')
  await f.close(host)
  const reopened = await f.open()
  expect(reopened.workspaceSnapshot().threads[0]!.activities).toEqual(f.provider.state.threads[0]!.activities)
})

it('persists changed activity independently while repeated frames avoid organization writes', async () => {
  const f = await fixture()
  const host = await f.open()
  await host.connect()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
  const thread = f.provider.state.threads[0]!
  for (let index = 0; index < 5; index++) {
    thread.activities = [activity('old', `Changed output ${index}`)]
    f.provider.emit()
    await host.snapshot()
  }
  expect(write).not.toHaveBeenCalled()
  expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain('Changed output')
  await f.close(host)
  const reopened = await f.open()
  expect(reopened.workspaceSnapshot().threads[0]!.activities?.[0]?.output).toBe('Changed output 4')
})

it('keeps activity snapshots independently mutable without corrupting saved history', async () => {
  const f = await fixture()
  const host = await f.open()
  await host.connect()
  const snapshot = host.workspaceSnapshot()
  snapshot.threads[0]!.activities![0]!.changes![0]!.diff = 'Consumer edit'
  snapshot.threads[0]!.activities![0]!.output = 'Consumer edit'
  expect(host.workspaceSnapshot().threads[0]!.activities?.[0]).toEqual(activity('old', 'Retained tool output'))
})

it('erases old activity on privacy changes and never revives it when history is enabled again', async () => {
  let history = true
  const f = await fixture(() => history)
  const host = await f.open()
  await host.connect()
  history = false
  await host.privacyChanged()
  f.provider.state.threads[0]!.activities!.push(activity('private', 'PRIVATE_ACTIVITY_MARKER'))
  await host.snapshot()
  history = true
  await host.privacyChanged()
  await host.snapshot()
  f.provider.state.threads[0]!.activities!.push(activity('fresh', 'Fresh saved output'))
  await host.snapshot()
  await f.close(host)
  const disk = (await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name), 'latin1')))).join('')
  expect(disk.includes('Retained tool output')).toBe(false)
  expect(disk.includes('PRIVATE_ACTIVITY_MARKER')).toBe(false)
  const reopened = await f.open()
  expect(reopened.workspaceSnapshot().threads[0]!.activities?.map(item => item.output)).toEqual(['Fresh saved output'])
})


it('keeps legacy activity recoverable when migration fails, then imports it on the next start', async () => {
  const f = await fixture(() => true, true)
  const sync = vi.spyOn(ThreadStore.prototype, 'syncActivities').mockImplementation(() => { throw new Error('disk unavailable') })
  const host = await f.open()
  expect(host.workspaceSnapshot().threads[0]!.activities?.[0]?.output).toBe('Retained tool output')
  expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).toContain('Retained tool output')
  await f.close(host)
  sync.mockRestore()
  const recovered = await f.open()
  expect(recovered.workspaceSnapshot().threads[0]!.activities?.[0]?.output).toBe('Retained tool output')
  expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain('Retained tool output')
})

it('retries a failed activity save without treating the failed data as committed', async () => {
  const f = await fixture()
  const host = await f.open()
  await host.connect()
  f.provider.state.threads[0]!.activities = [activity('old', 'Recovered output')]
  vi.spyOn(ThreadStore.prototype, 'syncActivities').mockImplementationOnce(() => { throw new Error('disk unavailable') })
  await expect(host.snapshot()).rejects.toThrow('disk unavailable')
  await host.snapshot()
  await f.close(host)
  const recovered = await f.open()
  expect(recovered.workspaceSnapshot().threads[0]!.activities?.[0]?.output).toBe('Recovered output')
})

it('commits a newer return to the old name after an overlapping save finishes', async () => {
  const f = await fixture()
  const host = await f.open()
  await host.connect()
  const actual = AtomicJsonStore.prototype.write
  let release!: () => void
  let writing!: () => void
  const started = new Promise<void>(resolve => { writing = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementationOnce(async function (this: AtomicJsonStore<unknown>, value: unknown) {
    writing(); await held; return actual.call(this, value)
  })
  const first = host.renameThread('session-workshop', 'Temporary name')
  await started
  const restored = host.renameThread('session-workshop', 'Workshop')
  release()
  await Promise.all([first, restored])
  const saved = JSON.parse(await readFile(join(f.directory, 'workspace.json'), 'utf8'))
  expect(saved.snapshot.threads[0].title).toBe('Workshop')
})


it('still erases durable history when activity synchronization would fail during a privacy change', async () => {
  let history = true
  const f = await fixture(() => history)
  const host = await f.open()
  f.provider.state.threads[0]!.messages = [{ id: 'secret', role: 'user', text: 'DURABLE_MESSAGE_MARKER', createdAt: '2026-09-20T10:00:00.000Z' }]
  await host.connect()
  const sync = vi.spyOn(ThreadStore.prototype, 'syncActivities').mockImplementation(() => { throw new Error('invalid activity') })
  history = false
  await host.privacyChanged().catch(() => undefined)
  sync.mockRestore()
  const disk = (await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name), 'latin1')))).join('')
  expect(disk.includes('DURABLE_MESSAGE_MARKER')).toBe(false)
  expect(disk.includes('Retained tool output')).toBe(false)
})


it('updates one record across four large activity archives without encoding or saving the others', async () => {
  const f = await fixture()
  const base = f.provider.state.threads[0]!
  f.provider.state.threads = Array.from({ length: 4 }, (_, threadIndex) => ({ ...base, id: `large-${threadIndex}`,
    activities: Array.from({ length: 96 }, (_, index) => ({ ...activity(`activity-${threadIndex}-${index}`, 'x'.repeat(65_500)), sequence: index })) }))
  const host = await f.open()
  await host.connect()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
  const encode = vi.spyOn(JSON, 'stringify')
  f.provider.state.threads[0]!.activities![0]!.output = 'One updated record'
  await host.snapshot()
  expect(write.mock.calls.length).toBe(0)
  const activityEncodings = encode.mock.calls.filter(([value]) => value && typeof value === 'object' && 'output' in value)
  expect(activityEncodings.length).toBe(1)
  encode.mockRestore()
  await f.close(host)
  const reopened = await f.open()
  const threads = reopened.workspaceSnapshot().threads
  expect(threads).toHaveLength(4)
  expect(threads[0]!.activities![0]!.output).toBe('One updated record')
  expect(threads[3]!.activities).toHaveLength(96)
  expect(threads[3]!.activities![95]!.output?.length).toBe(65_500)
})


it('suppresses legacy activity when first opened with history off, including restart before enabling', async () => {
  let history = false
  const f = await fixture(() => history, true)
  const initial = await f.open()
  await f.close(initial)
  const host = await f.open()
  history = true
  await host.privacyChanged()
  await host.connect()
  await f.close(host)
  const reopened = await f.open()
  expect(reopened.workspaceSnapshot().threads[0]!.activities ?? []).toEqual([])
})

it('never falls back to JSON containing private activity when enabling history fails', async () => {
  let history = false
  const f = await fixture(() => history)
  const host = await f.open()
  await host.connect()
  const sync = vi.spyOn(ThreadStore.prototype, 'syncActivities').mockImplementation(() => { throw new Error('storage unavailable') })
  history = true
  await host.privacyChanged().catch(() => undefined)
  sync.mockRestore()
  const saved = await readFile(join(f.directory, 'workspace.json'), 'utf8')
  expect(saved.includes('Retained tool output')).toBe(false)
})

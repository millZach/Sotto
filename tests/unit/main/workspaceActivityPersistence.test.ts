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

it.each(['retry while off', 'resume before retry', 'successful transition'])('keeps private messages and activity out of durable history (%s)', async mode => {
  let history = true
  const f = await fixture(() => history)
  const host = await f.open()
  const thread = f.provider.state.threads[0]!
  thread.messages.push({ id: 'old-message', role: 'user', text: 'OLD_MESSAGE_BEFORE_HISTORY_OFF', createdAt: new Date().toISOString() })
  await host.connect()
  const transition = vi.spyOn(ThreadStore.prototype, 'becomeEphemeral')
  if (mode !== 'successful transition') transition.mockImplementationOnce(() => { throw new Error('Synthetic failed redaction') })
  history = false
  if (mode === 'successful transition') await host.privacyChanged()
  else await expect(host.privacyChanged()).rejects.toThrow('Thread messages could not be removed')
  thread.activities!.push(activity('private', 'PRIVATE_ACTIVITY_DURING_RETRY'))
  thread.messages.push({ id: 'private-message', role: 'assistant', text: 'PRIVATE_MESSAGE_DURING_RETRY', createdAt: new Date().toISOString() })
  await host.snapshot()
  const disk = new ThreadStore(join(f.directory, 'threads.sqlite'))
  disk.open()
  try {
    expect(disk.readActivities(thread.id).map(record => record.output)).not.toContain('PRIVATE_ACTIVITY_DURING_RETRY')
    expect(disk.readMessages(thread.id).messages.map(message => message.text)).not.toContain('PRIVATE_MESSAGE_DURING_RETRY')
  } finally { disk.close() }
  if (mode === 'resume before retry') {
    history = true
    thread.messages.push({ id: 'resumed-message', role: 'assistant', text: 'Message after history resumed', createdAt: new Date().toISOString() })
    expect((await host.snapshot()).threads[0]!.messages.map(message => message.text)).toContain('Message after history resumed')
  }
  await host.privacyChanged()
  expect(transition).toHaveBeenCalledTimes(mode === 'successful transition' ? 1 : 2)
  history = true
  await host.privacyChanged()
  thread.activities!.push(activity('fresh', 'Fresh retained output'))
  thread.messages.find(message => message.id === 'private-message')!.text += ' with a later streaming update'
  thread.messages.push({ id: 'fresh-message', role: 'assistant', text: 'Fresh retained message', createdAt: new Date().toISOString() })
  await host.snapshot()
  disk.open()
  try {
    expect(disk.readActivities(thread.id).map(record => record.output)).toEqual(['Fresh retained output'])
    expect(disk.readMessages(thread.id).messages.map(message => message.text)).toEqual([
      ...(mode === 'resume before retry' ? ['Message after history resumed'] : []), 'Fresh retained message',
    ])
  } finally { disk.close() }
  await f.close(host)
  const bytes = (await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name), 'latin1')))).join('')
  expect(bytes).not.toContain('Retained tool output')
  expect(bytes).not.toContain('OLD_MESSAGE_BEFORE_HISTORY_OFF')
  expect(bytes).not.toContain('PRIVATE_ACTIVITY_DURING_RETRY')
  expect(bytes).not.toContain('PRIVATE_MESSAGE_DURING_RETRY')
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

it.each([false, true])('keeps Threads usable after a failed durable reopen and recovers on restart (redaction retry: %s)', async retry => {
  let history = retry
  const f = await fixture(() => history)
  const host = await f.open()
  await host.connect()
  const thread = f.provider.state.threads[0]!
  if (retry) {
    vi.spyOn(ThreadStore.prototype, 'becomeEphemeral').mockImplementationOnce(() => { throw new Error('Synthetic failed redaction') })
    history = false
    await expect(host.privacyChanged()).rejects.toThrow('Thread messages could not be removed')
  }
  const reopen = ThreadStore.prototype.becomeDurable
  vi.spyOn(ThreadStore.prototype, 'becomeDurable').mockImplementationOnce(function (this: ThreadStore) {
    vi.spyOn(ThreadStore.prototype, 'open').mockImplementationOnce(() => { throw new Error('Synthetic locked file') })
    reopen.call(this)
  })
  history = true
  await expect(host.privacyChanged()).rejects.toThrow('Thread messages could not be opened')
  await expect(host.snapshot()).resolves.toMatchObject({ connected: true })
  await expect(host.refreshThread(thread.id)).resolves.toMatchObject({ connected: true })
  expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain('Retained tool output')
  await f.close(host)
  const recovered = await f.open()
  await recovered.connect()
  thread.activities!.push(activity('after-restart', 'Retained after restart'))
  await recovered.snapshot()
  const disk = new ThreadStore(join(f.directory, 'threads.sqlite'))
  disk.open()
  try { expect(disk.readActivities(thread.id).map(record => record.output)).toContain('Retained after restart') }
  finally { disk.close() }
})

it('keeps legacy messages private across a rewind after history resumes', async () => {
  let history = true
  const f = await fixture(() => history)
  const host = await f.open()
  await host.connect()
  const thread = f.provider.state.threads[0]!
  history = false
  await host.privacyChanged()
  thread.messages.push({ id: 'private-before-rewind', role: 'user', text: 'PRIVATE_REWOUND_MESSAGE', createdAt: new Date().toISOString() })
  await host.snapshot()
  history = true
  await host.privacyChanged()
  thread.historyEpoch = 'rewound-epoch'
  thread.messages.push({ id: 'fresh-after-rewind', role: 'assistant', text: 'Fresh after rewind', createdAt: new Date().toISOString() })
  const messages = (await host.snapshot()).threads[0]!.messages.map(message => message.text)
  expect(messages).toEqual(['Fresh after rewind'])
  const disk = new ThreadStore(join(f.directory, 'threads.sqlite'))
  disk.open()
  try { expect(disk.readMessages(thread.id).messages.map(message => message.text)).toEqual(['Fresh after rewind']) }
  finally { disk.close() }
})

it('scrubs pending permission words from workspace JSON even when redaction fails', async () => {
  let history = true
  const f = await fixture(() => history)
  const host = await f.open()
  const thread = f.provider.state.threads[0]!
  thread.requests = [{ id: 'pending', kind: 'permission', text: 'PRIVATE_PERMISSION_TEXT', options: [], context: { command: 'PRIVATE_PENDING_COMMAND' } }]
  await host.connect()
  const path = join(f.directory, 'workspace.json')
  expect(await readFile(path, 'utf8')).toContain('PRIVATE_PENDING_COMMAND')
  vi.spyOn(ThreadStore.prototype, 'becomeEphemeral').mockImplementationOnce(() => { throw new Error('Synthetic failed redaction') })
  history = false
  await expect(host.privacyChanged()).rejects.toThrow('Thread messages could not be removed')
  const saved = await readFile(path, 'utf8')
  expect(saved).not.toContain('PRIVATE_PERMISSION_TEXT')
  expect(saved).not.toContain('PRIVATE_PENDING_COMMAND')
  expect(JSON.parse(saved).snapshot.threads.every((item: { requests: unknown[] }) => item.requests.length === 0)).toBe(true)
  await host.privacyChanged()
})

it('keeps Threads usable and retries when redaction closes the store but memory open fails', async () => {
  let history = true
  const f = await fixture(() => history)
  const host = await f.open()
  await host.connect()
  const thread = f.provider.state.threads[0]!
  vi.spyOn(ThreadStore.prototype, 'open').mockImplementationOnce(() => { throw new Error('Synthetic failed memory open') })
  history = false
  await expect(host.privacyChanged()).rejects.toThrow('Thread messages could not be removed')
  await expect(host.snapshot()).resolves.toMatchObject({ connected: true })
  await expect(host.refreshThread(thread.id)).resolves.toMatchObject({ connected: true })
  thread.activities!.push(activity('private-after-close', 'PRIVATE_AFTER_FAILED_MEMORY_OPEN'))
  await host.snapshot()
  await host.privacyChanged()
  history = true
  await host.privacyChanged()
  thread.activities!.push(activity('fresh-after-retry', 'Fresh after memory retry'))
  await host.snapshot()
  const disk = new ThreadStore(join(f.directory, 'threads.sqlite'))
  disk.open()
  try { expect(disk.readActivities(thread.id).map(record => record.output)).toEqual(['Fresh after memory retry']) }
  finally { disk.close() }
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


it.each([false, true])('preserves legacy activity evidence across restarts when known-empty is %s', async known => {
  const f = await fixture()
  const thread = f.provider.state.threads[0]!
  if (known) thread.activities = []
  else delete thread.activities
  await writeFile(join(f.directory, 'workspace.json'), JSON.stringify({ snapshot: f.provider.state, creations: [], projectAliases: [] }))
  for (let restart = 0; restart < 2; restart++) {
    const host = await f.open()
    expect(host.activities(thread.id)).toEqual(known ? [] : undefined)
    expect(JSON.parse(await readFile(join(f.directory, 'workspace.json'), 'utf8')).snapshot.threads[0]).not.toHaveProperty('activities')
    await f.close(host)
  }
})


it.each([
  { legacy: true, epoch: 'new-epoch', empty: false },
  { legacy: true, epoch: 'new-epoch', empty: true },
  { legacy: true, epoch: undefined, empty: false },
  { legacy: false, epoch: 'new-epoch', empty: false },
  { legacy: true, epoch: 'old-epoch', empty: false },
])('keeps the committed activity generation after an interrupted JSON save: %j', async ({ legacy, epoch, empty }) => {
  const f = await fixture()
  const thread = f.provider.state.threads[0]!
  thread.historyEpoch = 'old-epoch'
  if (!legacy) delete thread.activities
  thread.messages = epoch === 'old-epoch' ? [] : [{ id: 'stale-message', role: 'user', text: 'Stale old-generation message', createdAt: '2026-09-20T00:00:00Z' }]
  await writeFile(join(f.directory, 'workspace.json'), JSON.stringify({ snapshot: f.provider.state, creations: [], projectAliases: [] }))
  const committed = empty ? [] : [activity('fresh', 'New committed output')]
  const retainedMessage = { id: 'current-message', role: 'user' as const, text: 'Current generation message', createdAt: '2026-09-20T00:00:01Z' }
  const store = new ThreadStore(join(f.directory, 'threads.sqlite'))
  store.open()
  try {
    store.replaceThreadMessages(thread.id, [retainedMessage], epoch)
    store.syncActivities(thread.id, committed, epoch)
  } finally { store.close() }
  for (let restart = 0; restart < 2; restart++) {
    const host = await f.open()
    const restored = host.workspaceSnapshot().threads[0]!
    expect(restored.historyEpoch).toBe(epoch)
    expect(restored.activities).toEqual(committed)
    expect(host.threadMessages(thread.id)).toEqual([retainedMessage])
    await f.close(host)
  }
})

it.each([
  { previous: 'old-epoch', epoch: 'new-epoch', empty: false, legacy: true },
  { previous: 'old-epoch', epoch: undefined, empty: false, legacy: true },
  { previous: undefined, epoch: undefined, empty: false, legacy: true },
  { previous: undefined, epoch: undefined, empty: true, legacy: true },
  { previous: 'old-epoch', epoch: 'new-epoch', empty: false, legacy: false },
])('keeps the committed message generation when activity sync never committed: %j', async ({ previous, epoch, empty, legacy }) => {
  const f = await fixture()
  const thread = f.provider.state.threads[0]!
  if (previous === undefined) delete thread.historyEpoch
  else thread.historyEpoch = previous
  const stale = { id: 'stale-message', role: 'user' as const, text: 'Stale split-commit message', createdAt: '2026-09-20T00:00:00Z' }
  const current = { id: 'current-message', role: 'user' as const, text: 'Current split-commit message', createdAt: '2026-09-20T00:00:01Z' }
  thread.messages = [stale]
  if (!legacy) delete thread.activities
  await writeFile(join(f.directory, 'workspace.json'), JSON.stringify({ snapshot: f.provider.state, creations: [], projectAliases: [] }))
  const store = new ThreadStore(join(f.directory, 'threads.sqlite'))
  store.open()
  try {
    store.replaceThreadMessages(thread.id, [stale], previous)
    store.syncActivities(thread.id, [activity('old', 'Stale split-commit activity')], previous)
    store.replaceThreadMessages(thread.id, empty ? [] : [current], epoch)
    // Simulate exit after the message transaction committed, before activity sync or JSON save.
    expect(store.readActivityResetSequence(thread.id)).not.toBe(store.readMessageEpoch(thread.id)?.sequence)
  } finally { store.close() }
  for (let restart = 0; restart < 2; restart++) {
    const host = await f.open()
    const restored = host.workspaceSnapshot().threads[0]!
    expect(restored.historyEpoch).toBe(epoch)
    expect(restored.activities).toEqual([])
    expect(host.threadMessages(thread.id)).toEqual(empty ? [] : [current])
    await f.close(host)
  }
})
it.each(['none', 'before-activity', 'after-activity'])('keeps legacy messages and activity through restart with interrupted migration=%s', async interrupted => {
  const f = await fixture()
  const thread = f.provider.state.threads[0]!
  thread.messages = [{ id: 'legacy-message', role: 'user', text: 'Legacy message beside retained activity', createdAt: '2026-09-20T00:00:00Z' }]
  const messages = structuredClone(thread.messages)
  const activities = structuredClone(thread.activities!)
  await writeFile(join(f.directory, 'workspace.json'), JSON.stringify({ snapshot: f.provider.state, creations: [], projectAliases: [] }))
  if (interrupted !== 'none') {
    const sync = ThreadStore.prototype.syncActivities
    let calls = 0
    const failure = vi.spyOn(ThreadStore.prototype, 'syncActivities').mockImplementation(function (this: ThreadStore, ...args) {
      if (++calls > (interrupted === 'before-activity' ? 0 : 1)) throw new Error('Fixture interrupted activity migration')
      return sync.apply(this, args)
    })
    const host = new WorkspaceHost(f.provider, f.directory)
    try {
      if (interrupted === 'before-activity') {
        await host.initialize()
        expect(host.workspaceSnapshot().error).toContain('Thread activity could not be saved')
      } else await expect(host.initialize()).rejects.toThrow('Fixture interrupted activity migration')
    } finally { host.dispose(); failure.mockRestore() }
  } else {
    const host = await f.open()
    expect(host.threadMessages(thread.id)).toEqual(messages)
    expect(host.workspaceSnapshot().threads[0]?.activities).toEqual(activities)
    await f.close(host)
  }
  const reopened = await f.open()
  expect(reopened.threadMessages(thread.id)).toEqual(messages)
  expect(reopened.workspaceSnapshot().threads[0]?.activities).toEqual(activities)
  await f.close(reopened)
})

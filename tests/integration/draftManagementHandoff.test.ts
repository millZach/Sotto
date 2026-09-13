// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'

const fixtures: Awaited<ReturnType<typeof draftHandoffFixture>>[] = []
async function fixture() { const f = await draftHandoffFixture(); fixtures.push(f); return f }
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close() })

it('does not let a delayed manual autosave overwrite a newer managed revision', async () => {
  const f = await fixture(); const threadId = 'workshop'
  await f.command({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Saved manual draft' })
  const store = f.store(); store.edit(threadId, { text: 'Pending manual edit' })
  await f.command({ type: 'assign', threadId })
  expect(f.control.get().draft).toBe('Saved manual draft')
  await f.command({ type: 'compose', text: 'New managed edit' })
  const managedId = f.control.get().threadDrafts!.find(d => d.threadId === threadId)!.draftId
  store.flush(threadId)
  await expect.poll(() => store.snapshot(threadId).save).not.toBe('saving')
  expect(f.control.get().draft).toBe('New managed edit')
  expect(f.control.get().threadDrafts!.find(d => d.threadId === threadId)?.draftId).toBe(managedId)
  expect(store.draft(threadId).text).toBe('Pending manual edit')
})

const image = { id: 'image', name: 'pixel.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
const skills = [{ name: 'build', path: 'C:/synthetic/skills/build/SKILL.md' }]
function gate() { let release!: () => void; return { promise: new Promise<void>(done => { release = done }), release: () => release() } }

it.each(['assign', 'resume'] as const)('hands the exact latest text, image and skill revision to %s before managed edits/reload/privacy', async action => {
  const f = await fixture(); const threadId = 'workshop'
  if (action === 'resume') {
    await f.command({ type: 'assign', threadId })
    f.host.event({ type: 'manual', threadId, text: 'Explicit manual takeover', status: 'idle' })
    expect(f.control.get().assignments[0]?.mode).toBe('manual')
  }
  await f.command({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Old saved input' })
  const store = f.store(); store.edit(threadId, { text: '$build Latest manual edit', attachments: [image], skills })
  const revision = store.draft(threadId).draftId
  const result = await store.handoffToManagement(threadId, action)
  expect(result?.error).toBeNull()
  expect(result).toMatchObject({ draft: '$build Latest manual edit', draftAttachments: [image], draftThreadId: threadId })
  expect(result?.threadDrafts).toContainEqual(expect.objectContaining({ threadId, draftId: revision, skills, attachments: [image] }))
  expect(result?.threadDraftPersistence).toContainEqual({ threadId, draftId: revision, status: 'saved' })
  const oldReply = f.control.get()
  await f.command({ type: 'compose', text: '$build New managed edit' })
  const managed = f.control.get().threadDrafts!.find(d => d.threadId === threadId)!
  expect(managed).toMatchObject({ skills, attachments: [image] }); expect(managed.draftId).not.toBe(revision)
  store.receive(oldReply) // A reordered old save/assign response cannot roll the renderer back either.
  expect(store.draft(threadId).draftId).toBe(managed.draftId)
  await f.flush(store, threadId)
  expect(f.control.get().threadDrafts).toContainEqual(managed)
  f.setHistory(false); await f.control.privacyChanged()
  expect((await f.disk()).threadDrafts).toContainEqual(managed)
  await f.restart(); const reloaded = f.store()
  expect(reloaded.draft(threadId)).toMatchObject({ draftId: managed.draftId, text: managed.text, skills, attachments: [image] })
  expect(f.attempts).toEqual([])
})

it('waits for earlier in-flight saves and the latest typing despite reordered acknowledgements', async () => {
  const f = await fixture(); const first = gate(); let oldSaveStarted = false
  const store = f.store(async command => {
    const result = await f.command(command)
    if (command.type === 'save-thread-draft' && command.text === 'First edit') { oldSaveStarted = true; await first.promise }
    return result
  })
  store.edit('workshop', { text: 'First edit' }); const older = store.flush('workshop')
  await expect.poll(() => oldSaveStarted).toBe(true)
  store.edit('workshop', { text: '$build Latest edit', attachments: [image], skills })
  const newestId = store.draft('workshop').draftId
  const handoff = store.handoffToManagement('workshop', 'assign')
  expect(store.handoffToManagement('workshop', 'assign')).toBe(handoff)
  try {
    await expect.poll(() => store.snapshot('workshop').save).toBe('saved')
    expect(f.control.get().assignments).toEqual([])
    // The barrier must not block a different thread's persistence.
    store.edit('docs', { text: 'Other thread remains usable' }); await f.flush(store, 'docs')
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'docs', text: 'Other thread remains usable' }))
    store.edit('workshop', { text: '$build Typed while the barrier waits' })
  } finally { first.release(); await older }
  expect((await handoff)?.error).toBeNull()
  expect(f.control.get().draft).toBe('$build Typed while the barrier waits')
  expect(f.control.get().threadDrafts?.find(d => d.threadId === 'workshop')?.draftId).not.toBe(newestId)
  expect(f.control.get().threadDrafts?.find(d => d.threadId === 'workshop')).toMatchObject({ attachments: [image], skills })
  expect(f.attempts).toEqual([])
})

it('preserves both threads when the saved managed composer belongs to another owner', async () => {
  const f = await fixture()
  await f.command({ type: 'select-thread', threadId: 'docs' })
  await f.command({ type: 'compose', text: 'Foreign owned draft', attachments: [image] })
  const foreign = f.control.get().threadDrafts!.find(d => d.threadId === 'docs')!
  const store = f.store(); store.edit('workshop', { text: '$build Local handoff', skills })
  expect((await store.handoffToManagement('workshop', 'assign'))?.error).toBeNull()
  expect(f.control.get()).toMatchObject({ draftThreadId: 'docs', draft: 'Foreign owned draft', draftAttachments: [image] })
  expect(f.control.get().threadDrafts).toContainEqual(foreign)
  expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'workshop', text: '$build Local handoff', skills }))
  expect(f.attempts).toEqual([])
})

it('keeps unsaved content and authority unchanged when storage cannot confirm the handoff save', async () => {
  const f = await fixture(); const store = f.store()
  store.edit('workshop', { text: '$build Must survive storage failure', attachments: [image], skills })
  const draft = store.draft('workshop')
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValue(new Error('Synthetic storage failure'))
  expect(await store.handoffToManagement('workshop', 'assign')).toBeNull()
  expect(store.draft('workshop')).toEqual(draft)
  expect(store.snapshot('workshop')).toMatchObject({ save: 'unsaved', saveError: expect.any(String) })
  expect(f.control.get().assignments).toEqual([])
  expect(f.attempts).toEqual([])
  write.mockRestore()
  expect((await store.handoffToManagement('workshop', 'assign'))?.error).toBeNull()
  expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: draft.draftId, skills, attachments: [image] }))
})

it('checks the expected revision after a delayed management command before changing authority', async () => {
  const f = await fixture(); const hold = gate(); let entered = false
  const store = f.store(async command => {
    if (command.type === 'assign') { entered = true; await hold.promise }
    return f.command(command)
  })
  store.edit('workshop', { text: 'Original handoff' })
  const pending = store.handoffToManagement('workshop', 'assign')
  try {
    await expect.poll(() => entered).toBe(true)
    store.edit('workshop', { text: '$build Newer revision', attachments: [image], skills }); await f.flush(store, 'workshop')
  } finally { hold.release() }
  expect(await pending).toBeNull()
  expect(f.control.get().assignments).toEqual([])
  expect(store.draft('workshop')).toMatchObject({ text: '$build Newer revision', skills, attachments: [image] })
  expect(store.snapshot('workshop').saveError).toMatch(/draft changed/)
  expect(f.attempts).toEqual([])
})

it('retains uncertain delivery and a newer draft without granting management or replaying', async () => {
  const f = await fixture()
  vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
  await f.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Uncertain original' })
  const before = (await f.disk()).outbox
  const store = f.store(); store.edit('workshop', { text: '$build New unsent input', attachments: [image], skills })
  expect(await store.handoffToManagement('workshop', 'assign')).toBeNull()
  expect(store.snapshot('workshop').saveError).toMatch(/pending/)
  expect(store.draft('workshop')).toMatchObject({ text: '$build New unsent input', attachments: [image], skills })
  expect(f.control.get().assignments).toEqual([])
  expect((await f.disk()).outbox).toEqual(before)
  expect(f.host.execute).toHaveBeenCalledTimes(1)
})

it('waits for an actual pending disk write before transferring an image and skill draft', async () => {
  const f = await fixture(); const store = f.store(); const hold = gate(); let entered = false
  const original = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
    if (!entered && (value as { threadDrafts?: unknown[] }).threadDrafts?.length) { entered = true; await hold.promise }
    return original.call(this, value)
  })
  store.edit('workshop', { text: '$build Disk barrier', attachments: [image], skills })
  const handoff = store.handoffToManagement('workshop', 'assign')
  try {
    await expect.poll(() => entered).toBe(true)
    expect(f.control.get().assignments).toEqual([])
    expect(store.snapshot('workshop').save).toBe('saving')
  } finally { hold.release() }
  expect((await handoff)?.error).toBeNull()
  expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: '$build Disk barrier', attachments: [image], skills }))
  expect(f.attempts).toEqual([])
})

it('allows an identical managed revision to retry a failed save without accepting a conflicting manual revision', async () => {
  const f = await fixture(); const store = f.store()
  store.edit('workshop', { text: '$build Original', attachments: [image], skills })
  await store.handoffToManagement('workshop', 'assign')
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValue(new Error('Synthetic managed save failure'))
  await f.command({ type: 'compose', text: '$build Managed change' })
  const managedId = f.control.get().threadDrafts!.find(d => d.threadId === 'workshop')!.draftId
  expect(store.snapshot('workshop').save).toBe('unsaved')
  write.mockRestore()
  await f.flush(store, 'workshop', true)
  expect(store.snapshot('workshop').save).toBe('saved')
  expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: managedId, text: '$build Managed change', skills, attachments: [image] }))
  store.edit('workshop', { text: 'Conflicting manual change' }); await f.flush(store, 'workshop')
  expect(store.snapshot('workshop').save).toBe('unsaved')
  expect(f.control.get().draft).toBe('$build Managed change')
  expect(store.draft('workshop').text).toBe('Conflicting manual change')
})

it.each(['pristine', 'cleared'] as const)('safely hands off a %s empty draft without restoring old content', async kind => {
  const f = await fixture(); const store = f.store()
  if (kind === 'cleared') {
    store.edit('workshop', { text: 'Clear this', attachments: [image], skills }); await f.flush(store, 'workshop')
    store.edit('workshop', { text: '', attachments: [], skills: [] })
  }
  expect((await store.handoffToManagement('workshop', 'assign'))?.error).toBeNull()
  expect(f.control.get().threadDrafts).toEqual([])
  expect(f.control.get().draft).toBe('')
  expect(f.attempts).toEqual([])
})

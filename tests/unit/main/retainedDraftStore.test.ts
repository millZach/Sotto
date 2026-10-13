// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetainedDraftStore, type RetainedDraft } from '../../../src/main/agents/retainedDraftStore'
import type { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { DesktopHosts } from '../../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { AgentCredentials } from '../../../src/main/agents/credentials'

let directory: string
const hostId = randomUUID()
const edit = (text = 'Synthetic retained edit'): RetainedDraft => ({ hostId, providerId: 'codex', draft: { threadId: 'thread', draftId: randomUUID(),
  text, attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: false })
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-retained-drafts-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('retained remote draft storage', () => {
  it('records the acknowledged host revision without clearing an unresolved explicit Send marker', async () => {
    const store = new RetainedDraftStore({ directory }), latest = edit()
    const sendAttempt = { commandId: randomUUID(), draftId: latest.draft.draftId, requestId: null }
    store.put({ ...latest, baseDraftId: null, sendAttempt })
    const acknowledged = { ...latest.draft, draftId: randomUUID() }
    store.saved(hostId, latest.draft.threadId, latest.draft.draftId, acknowledged); await store.flush()
    expect(store.get(hostId, latest.draft.threadId)).toMatchObject({ hostDraftId: acknowledged.draftId, baseDraftId: acknowledged.draftId, sendAttempt })
    const replacement = new RetainedDraftStore({ directory }); await replacement.load()
    expect(replacement.get(hostId, latest.draft.threadId)).toMatchObject({ baseDraftId: acknowledged.draftId, sendAttempt })
  })
  it('ignores a late edit admitted after its host was forgotten, including a fresh disk reload', async () => {
    const store = new RetainedDraftStore({ directory }), latest = edit()
    store.put(latest); await store.flush(); await store.forgetHost(hostId)
    store.put(latest); await store.flush()
    const replacement = new RetainedDraftStore({ directory }); await replacement.load()
    expect(store.list(hostId)).toEqual([])
    expect(replacement.list(hostId)).toEqual([])
  })
  it('keeps the current saved registration through reload and ignores both earlier registrations and unscoped managed copies', async () => {
    const registrationId = randomUUID(), earlierRegistration = randomUUID(), latest = { ...edit('Current registration'), registrationId }
    const earlier = { ...edit('Earlier registration'), registrationId: earlierRegistration, draft: { ...edit().draft, threadId: 'earlier-thread' } }
    const unscoped = { ...edit('Unscoped unreleased copy'), draft: { ...edit().draft, threadId: 'unscoped-thread' } }
    await writeFile(join(directory, 'remote-drafts.json'), JSON.stringify([latest, earlier, unscoped]), 'utf8')
    const store = new RetainedDraftStore({ directory }); store.setSavedHosts([{ hostId, registrationId }])
    await store.load(); await store.flush()
    expect(store.list(hostId)).toEqual([{ ...latest, recovery: true }])
    expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([{ ...latest, recovery: true }])
  })
  it('rejects an earlier socket registration after re-add while accepting the new registration and preserving it on restart', async () => {
    const store = new RetainedDraftStore({ directory }), earlierRegistration = randomUUID(), registrationId = randomUUID()
    store.setSavedHosts([{ hostId, registrationId: earlierRegistration }])
    const earlier = { ...edit('Earlier socket update'), registrationId: earlierRegistration }
    store.put(earlier); await store.flush(); await store.forgetHost(hostId)
    store.allowHost(hostId, registrationId)
    const latest = { ...edit('New registration update'), registrationId }
    store.put(latest); store.put(earlier); await store.flush()
    expect(store.get(hostId, latest.draft.threadId)).toEqual(latest)
    const replacement = new RetainedDraftStore({ directory }); replacement.setSavedHosts([{ hostId, registrationId }]); await replacement.load()
    expect(replacement.list(hostId)).toEqual([{ ...latest, recovery: true }])
  })
  it('reports an off-wire write failure without draft contents and retains the dirty revision for repair', async () => {
    const onWriteFailure = vi.fn(), store = new RetainedDraftStore({ directory, onWriteFailure })
    await store.load()
    const old = edit('Earlier saved copy'); store.put(old); await store.flush()
    const disk = (store as unknown as { disk: AtomicJsonStore<RetainedDraft[]> }).disk
    const failure = vi.spyOn(disk, 'write').mockRejectedValueOnce(new Error('Synthetic storage denial'))
    const latest = edit('Newest off-wire text')
    store.put(latest)
    await expect(store.flush()).rejects.toThrow('Synthetic storage denial')
    expect(onWriteFailure).toHaveBeenCalledExactlyOnceWith()
    expect(store.get(hostId, 'thread')?.draft).toEqual(latest.draft)
    expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([old])
    failure.mockRestore(); await store.close()
    expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([latest])
  })
  it.each([false, true])('drains admitted edits on manager close with no sockets even if unrelated cleanup fails (%s)', async fails => {
    const store = new RetainedDraftStore({ directory }), router = new DesktopHostRouter(emptyDesktopState)
    const credentials = new AgentCredentials(directory, { isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('Unused fixture encryption') }, decryptString: () => { throw new Error('Unused fixture decryption') } })
    const manager = new DesktopHosts({ directory, credentials, router, retainedDrafts: store,
      localHostRunning: false, localHostEnabled: () => false, restart: () => undefined })
    const latest = edit('Admitted before quit')
    store.put(latest)
    if (fails) vi.spyOn((manager as unknown as { admins: { closeAll(): Promise<void> } }).admins, 'closeAll').mockRejectedValue(new Error('Synthetic unrelated teardown failure'))
    try {
      if (fails) await expect(manager.close()).rejects.toThrow('Synthetic unrelated teardown failure')
      else await manager.close()
      expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([latest])
    } finally { router.dispose() }
  })
  it('durably retains only the latest full revision across process replacement, including an explicit empty image list', async () => {
    const first = new RetainedDraftStore({ directory })
    await first.load()
    const initial = edit('First')
    initial.draft.attachments = [{ id: 'image', digest: 'a'.repeat(64), name: 'Synthetic.png', mimeType: 'image/png', sizeBytes: 1 }]
    first.put(initial)
    const latest = { ...edit('Latest text after removal'), draft: { ...edit('Latest text after removal').draft, attachments: [] } }
    first.put(latest)
    await first.close()
    const replacement = new RetainedDraftStore({ directory })
    await replacement.load()
    expect(replacement.list(hostId)).toEqual([{ ...latest, recovery: true }])
    expect(await readFile(join(directory, 'remote-drafts.json'), 'utf8')).not.toContain('First')
  })
  it('preserves unread original bytes and retries after repair without overwriting newer memory edits', async () => {
    const path = join(directory, 'remote-drafts.json'), onRecovery = vi.fn()
    await writeFile(path, '{"synthetic-unread-draft":', 'utf8')
    const store = new RetainedDraftStore({ directory, onRecovery })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.storageAvailable).toBe(false)
    expect(store.requiresDurableWrites).toBe(true)
    const latest = edit('Newer memory edit')
    store.put(latest)
    await expect(store.flush()).rejects.toThrow('Saved remote drafts could not be read')
    expect(await readFile(path, 'utf8')).toBe('{"synthetic-unread-draft":')
    expect(await readdir(directory)).toEqual(['remote-drafts.json'])
    expect(onRecovery).toHaveBeenCalled()
    await writeFile(path, JSON.stringify([edit('Older disk edit')]), 'utf8')
    await store.load(); await store.close()
    expect(store.storageAvailable).toBe(true)
    expect(store.get(hostId, 'thread')?.draft).toEqual(latest.draft)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([latest])
  })
  it('keeps history-off edits in memory and clears primary and owned leftovers without importing disk text', async () => {
    let historyEnabled = false
    const path = join(directory, 'remote-drafts.json')
    await writeFile(path, JSON.stringify([edit('Old private disk text')]), 'utf8')
    await writeFile(path + '.corrupt-old', 'Old private disk text', 'utf8')
    await writeFile(path + '.tmp-old', 'Old private disk text', 'utf8')
    await writeFile(join(directory, 'unrelated.json'), 'keep', 'utf8')
    const store = new RetainedDraftStore({ directory, historyEnabled: () => historyEnabled })
    await store.load()
    expect(store.list(hostId)).toEqual([])
    const memory = edit('Memory-only edit')
    store.put(memory); await store.close()
    expect(store.get(hostId, 'thread')?.draft).toEqual(memory.draft)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
    expect((await readdir(directory)).sort()).toEqual(['remote-drafts.json', 'unrelated.json'])
    const replacement = new RetainedDraftStore({ directory, historyEnabled: () => historyEnabled })
    await replacement.load(); expect(replacement.list(hostId)).toEqual([])
    historyEnabled = true; await store.privacyChanged()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([memory])
    historyEnabled = false; await store.privacyChanged()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  })
  it('does not import history when privacy cleanup fails and can retry after access is restored', async () => {
    await writeFile(join(directory, 'remote-drafts.json'), JSON.stringify([edit('Old private disk text')]), 'utf8')
    const store = new RetainedDraftStore({ directory, historyEnabled: () => false })
    const disk = (store as unknown as { disk: AtomicJsonStore<RetainedDraft[]> }).disk
    const failure = vi.spyOn(disk, 'write').mockRejectedValue(new Error('Synthetic storage denial'))
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.storageAvailable).toBe(true)
    expect(store.requiresDurableWrites).toBe(false)
    expect(store.list(hostId)).toEqual([])
    failure.mockRestore()
    await store.privacyChanged()
    expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([])
  })
  it('forgets an owner despite a failed load and refuses late edits when storage is repaired', async () => {
    const path = join(directory, 'remote-drafts.json')
    await writeFile(path, 'invalid', 'utf8')
    const store = new RetainedDraftStore({ directory })
    await expect(store.forgetHost(hostId)).resolves.toBeUndefined()
    await writeFile(path, JSON.stringify([edit('Forgotten disk draft')]), 'utf8')
    await store.load(); await store.close()
    expect(store.list(hostId)).toEqual([])
    const latest = edit('Newer revision')
    store.put(latest)
    expect(store.list(hostId)).toEqual([])
    await store.close()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  })
  it('retires only an exact revision and permits a new edit after an explicit re-add', async () => {
    const store = new RetainedDraftStore({ directory }), latest = edit('Newer revision')
    await store.forgetHost(hostId); store.allowHost(hostId)
    store.put(latest); store.remove(hostId, 'thread', randomUUID())
    expect(store.get(hostId, 'thread')?.draft).toEqual(latest.draft)
    store.remove(hostId, 'thread', latest.draft.draftId)
    await store.close()
    expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([])
  })
  it('never imports an old forgotten disk epoch after re-add, even when its unread file is repaired later', async () => {
    const path = join(directory, 'remote-drafts.json'), store = new RetainedDraftStore({ directory })
    await writeFile(path, 'invalid', 'utf8'); store.setSavedHosts([])
    await store.load(); await store.forgetHost(hostId); store.allowHost(hostId)
    await writeFile(path, JSON.stringify([edit('Forgotten disk epoch')]), 'utf8')
    await store.load(); await store.flush()
    expect(store.list(hostId)).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  })
})

it('keeps dormant remote Watcher records whole across real Owl/stable saves and ordinary privacy cleanup', async () => {
  const owl = new RetainedDraftStore({ directory, watcherEnabled: true })
  const ordinary = edit('Ordinary remote draft')
  const watcher: RetainedDraft = { ...edit('Dormant Watcher draft'), threadKind: 'watcher', saved: true,
    draft: { ...edit().draft, threadId: 'watcher' } }
  const history: RetainedDraft = { ...watcher, threadKind: 'watcher-history', draft: { ...watcher.draft, threadId: 'history', draftId: randomUUID() } }
  owl.put(ordinary); owl.put(watcher); owl.put(history); await owl.close()
  let historyEnabled = true
  const stable = new RetainedDraftStore({ directory, watcherEnabled: false, historyEnabled: () => historyEnabled })
  await stable.load()
  expect(stable.list(hostId).map(item => item.draft.threadId)).toEqual(['thread'])
  stable.recover(hostId); await stable.close()
  expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8')).filter((item: RetainedDraft) => item.threadKind)).toEqual([watcher, history])
  historyEnabled = false; await stable.privacyChanged()
  expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([watcher, history])
  const coldStable = new RetainedDraftStore({ directory, watcherEnabled: false, historyEnabled: () => false })
  await coldStable.load(); await coldStable.privacyChanged()
  expect(coldStable.list(hostId)).toEqual([])
  expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([watcher, history])
  const reopened = new RetainedDraftStore({ directory, watcherEnabled: true }); await reopened.load()
  expect(reopened.get(hostId, 'watcher')).toEqual(watcher)
  expect(reopened.get(hostId, 'history')).toEqual(history)
})

it('keeps valid dormant drafts when an unrelated ordinary entry is malformed', async () => {
  const watcher: RetainedDraft = { ...edit(), threadKind: 'watcher', saved: true, draft: { ...edit().draft, threadId: 'watcher' } }
  const path = join(directory, 'remote-drafts.json')
  await writeFile(path, JSON.stringify([{ ...edit(), saved: 'invalid' }, watcher]), 'utf8')
  const stable = new RetainedDraftStore({ directory, watcherEnabled: false, historyEnabled: () => false })
  await stable.load(); await stable.close()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([watcher])
})

it('round trips 512 dormant and 512 ordinary drafts without reducing ordinary capacity', async () => {
  const path = join(directory, 'remote-drafts.json')
  const watchers = Array.from({ length: 512 }, (_, index): RetainedDraft => ({ ...edit(), threadKind: 'watcher-history', saved: true,
    draft: { ...edit().draft, threadId: 'history-' + index } }))
  await writeFile(path, JSON.stringify(watchers), 'utf8')
  const stable = new RetainedDraftStore({ directory, watcherEnabled: false }); await stable.load()
  const ordinary = Array.from({ length: 512 }, (_, index) => ({ ...edit(), saved: true, draft: { ...edit().draft, threadId: 'ordinary-' + index } }))
  for (const draft of ordinary) stable.put(draft)
  expect(() => stable.put({ ...edit(), draft: { ...edit().draft, threadId: 'overflow' } })).toThrow('too many unsent remote drafts')
  await stable.close()
  const owl = new RetainedDraftStore({ directory, watcherEnabled: true }); await owl.load()
  expect(owl.storageAvailable).toBe(true)
  expect(owl.list(hostId)).toEqual([...watchers, ...ordinary])
})

it('clears ordinary recovery copies while preserving Watcher recovery records and unreadable Watcher copies', async () => {
  const path = join(directory, 'remote-drafts.json')
  const watcher: RetainedDraft = { ...edit(), threadKind: 'watcher', draft: { ...edit().draft, threadId: 'watcher' } }
  const mixed = path + '.corrupt-mixed', broken = path + '.tmp-broken'
  const brokenText = '[{"threadKind":"watcher-history","unfinished":'
  await writeFile(path, JSON.stringify([watcher]), 'utf8')
  await writeFile(mixed, JSON.stringify([edit(), watcher]), 'utf8')
  await writeFile(broken, brokenText, 'utf8')
  const stable = new RetainedDraftStore({ directory, watcherEnabled: false, historyEnabled: () => false })
  await stable.load(); await stable.close()
  expect(JSON.parse(await readFile(mixed, 'utf8'))).toEqual([watcher])
  expect(await readFile(broken, 'utf8')).toBe(brokenText)
})

it('leaves unreadable Watcher primary bytes untouched with history off and retries after repair', async () => {
  const path = join(directory, 'remote-drafts.json'), onRecovery = vi.fn()
  const broken = '[{"threadKind":"watcher","draft":'
  await writeFile(path, broken, 'utf8')
  const stable = new RetainedDraftStore({ directory, watcherEnabled: false, historyEnabled: () => false, onRecovery })
  await stable.load(); expect(stable.storageAvailable).toBe(false)
  await expect(stable.privacyChanged()).rejects.toThrow('original file was preserved')
  expect(await readFile(path, 'utf8')).toBe(broken)
  expect(onRecovery).toHaveBeenCalled()
  const watcher: RetainedDraft = { ...edit(), threadKind: 'watcher', saved: true }
  await writeFile(path, JSON.stringify([watcher]), 'utf8')
  await stable.load(); await stable.privacyChanged()
  expect(stable.storageAvailable).toBe(true)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([watcher])
})

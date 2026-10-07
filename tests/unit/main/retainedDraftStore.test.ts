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
const edit = (text = 'Synthetic retained edit'): RetainedDraft => ({ hostId, draft: { threadId: 'thread', draftId: randomUUID(),
  text, attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: false })
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-retained-drafts-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('retained remote draft storage', () => {
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
    await expect(store.load()).rejects.toThrow('Saved remote drafts could not be read')
    const latest = edit('Newer memory edit')
    store.put(latest)
    await expect(store.flush()).rejects.toThrow('Saved remote drafts could not be read')
    expect(await readFile(path, 'utf8')).toBe('{"synthetic-unread-draft":')
    expect(await readdir(directory)).toEqual(['remote-drafts.json'])
    expect(onRecovery).toHaveBeenCalled()
    await writeFile(path, JSON.stringify([edit('Older disk edit')]), 'utf8')
    await store.load(); await store.close()
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
    await expect(store.load()).rejects.toThrow('Synthetic storage denial')
    expect(store.list(hostId)).toEqual([])
    failure.mockRestore()
    await store.privacyChanged()
    expect(JSON.parse(await readFile(join(directory, 'remote-drafts.json'), 'utf8'))).toEqual([])
  })
  it('forgets an owner before a failed load is repaired and retires only an exact revision', async () => {
    const path = join(directory, 'remote-drafts.json')
    await writeFile(path, 'invalid', 'utf8')
    const store = new RetainedDraftStore({ directory })
    await expect(store.forgetHost(hostId)).rejects.toThrow('Saved remote drafts could not be read')
    await writeFile(path, JSON.stringify([edit('Forgotten disk draft')]), 'utf8')
    await store.load(); await store.close()
    expect(store.list(hostId)).toEqual([])
    const latest = edit('Newer revision')
    store.put(latest); store.remove(hostId, 'thread', randomUUID())
    expect(store.get(hostId, 'thread')?.draft).toEqual(latest.draft)
    store.remove(hostId, 'thread', latest.draft.draftId)
    await store.close()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  })
})

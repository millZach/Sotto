// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RetainedDraftStore, type RetainedDraft } from '../../src/main/agents/retainedDraftStore'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'

const fixture = useDesktopHostFixture()

const { add, newManager, operations, retainedEdit, retainedStore, savedFile } = fixture

describe('Forget retained draft lifecycle', () => {
  it.each([true, false])('revokes and removes the host despite optional draft cleanup write failure (history %s)', async historyEnabled => {
    await fixture.manager.close()
    const store = new RetainedDraftStore({ directory: join(fixture.root, 'desktop'), historyEnabled: () => historyEnabled })
    fixture.manager = newManager(store); await fixture.manager.start()
    const remote = await add(), token = fixture.credentials.get('remote-host:' + remote.id)
    store.put(retainedEdit()); await store.flush()
    const disk = (store as unknown as { disk: AtomicJsonStore<RetainedDraft[]> }).disk
    const denial = vi.spyOn(disk, 'write').mockRejectedValue(new Error('Synthetic draft storage denial'))
    try {
      await expect(fixture.manager.command({ type: 'forget', id: remote.id })).resolves.toMatchObject({ hosts: [] })
      expect(operations).toEqual(['ssh revoke-client', 'ssh stop-host'])
      expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
      expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
      expect(await savedFile()).toEqual([])
      expect(store.list(fixture.reportedHostId)).toEqual([])
    } finally { denial.mockRestore() }
  })
  it('connects and revokes without overwriting unread retained draft bytes', async () => {
    await fixture.manager.close()
    const path = join(fixture.root, 'desktop', 'remote-drafts.json'), original = '{"unread-private-copy":'
    await mkdir(join(fixture.root, 'desktop'), { recursive: true })
    await writeFile(path, original, 'utf8')
    const onRecovery = vi.fn(), store = new RetainedDraftStore({ directory: join(fixture.root, 'desktop'), onRecovery })
    fixture.manager = newManager(store); await fixture.manager.start()
    try {
      const remote = await add(), token = fixture.credentials.get('remote-host:' + remote.id)
      expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
      await expect(fixture.manager.command({ type: 'forget', id: remote.id })).resolves.toMatchObject({ hosts: [] })
      expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
      expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
      expect(await readFile(path, 'utf8')).toBe(original)
      expect(onRecovery).toHaveBeenCalled()
    } finally { await writeFile(path, '[]', 'utf8') }
  })
  it('does not reload a forgotten host draft after failed cleanup and a process replacement', async () => {
    await fixture.manager.close()
    const store = new RetainedDraftStore({ directory: join(fixture.root, 'desktop') })
    fixture.manager = newManager(store); await fixture.manager.start()
    const remote = await add(), edit = retainedEdit(), token = fixture.credentials.get('remote-host:' + remote.id)
    store.put(edit); await store.flush()
    const disk = (store as unknown as { disk: AtomicJsonStore<RetainedDraft[]> }).disk
    const denial = vi.spyOn(disk, 'write').mockRejectedValue(new Error('Synthetic draft storage denial'))
    try {
      await fixture.manager.command({ type: 'forget', id: remote.id })
      store.put({ ...edit, draft: { ...edit.draft, text: 'Synthetic late callback' } })
      expect(store.list(fixture.reportedHostId)).toEqual([])
      expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
      expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
      expect(JSON.parse(await readFile(join(fixture.root, 'desktop', 'remote-drafts.json'), 'utf8'))).toEqual([edit])
      await fixture.manager.close().catch(() => undefined)
      const replacement = new RetainedDraftStore({ directory: join(fixture.root, 'desktop') })
      fixture.manager = newManager(replacement); await fixture.manager.start(); await replacement.load(); await replacement.flush()
      expect(fixture.manager.get().hosts).toEqual([])
      expect(replacement.list(fixture.reportedHostId)).toEqual([])
      expect(JSON.parse(await readFile(join(fixture.root, 'desktop', 'remote-drafts.json'), 'utf8'))).toEqual([])
    } finally { denial.mockRestore() }
  })
  it('preserves unsent text when the user keeps the host during Forget sign-in', async () => {
    const remote = await add(), store = retainedStore(), edit = retainedEdit()
    store.put(edit); await store.flush()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    fixture.askOnConnect = 'passphrase'
    const forgetting = fixture.manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ adminSignIn: true, prompt: { id: 'prompt-1' } }))
    await fixture.manager.command({ type: 'stop-admin-sign-in', id: remote.id }); await forgetting
    expect(store.get(fixture.reportedHostId, edit.draft.threadId)?.draft).toEqual(edit.draft)
    expect(operations).toEqual([])
    expect(fixture.host.pairing.verifyToken(token)).toBeDefined()
  })
  it('does not revive pre-Forget disk text after re-adding the same authenticated host before storage repair', async () => {
    await fixture.manager.close()
    const store = new RetainedDraftStore({ directory: join(fixture.root, 'desktop') })
    fixture.manager = newManager(store); await fixture.manager.start()
    const original = await add(), edit = retainedEdit(), token = fixture.credentials.get('remote-host:' + original.id)
    store.put(edit); await store.flush()
    const disk = (store as unknown as { disk: AtomicJsonStore<RetainedDraft[]> }).disk
    const denial = vi.spyOn(disk, 'write').mockRejectedValue(new Error('Synthetic draft storage denial'))
    try {
      await fixture.manager.command({ type: 'forget', id: original.id })
      const readded = await add()
      expect(readded.id).not.toBe(original.id)
      expect(fixture.manager.get().hosts[0]!.hostId).toBe(fixture.reportedHostId)
      expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
      expect(fixture.host.pairing.verifyToken(fixture.credentials.get('remote-host:' + readded.id))).toBeDefined()
      await fixture.manager.command({ type: 'set-enabled', id: readded.id, enabled: false })
      await fixture.manager.close().catch(() => undefined)
      denial.mockRestore()
      const replacement = new RetainedDraftStore({ directory: join(fixture.root, 'desktop') })
      fixture.manager = newManager(replacement); await fixture.manager.start(); await replacement.load(); await replacement.flush()
      expect(fixture.manager.get().hosts[0]!.id).toBe(readded.id)
      expect(replacement.list(fixture.reportedHostId)).toEqual([])
    } finally { denial.mockRestore() }
  })
  it('preserves unsent text when Forget cannot stop the owned host', async () => {
    const remote = await add(), store = retainedStore(), edit = retainedEdit()
    store.put(edit); await store.flush(); fixture.stopResult = false
    await expect(fixture.manager.command({ type: 'forget', id: remote.id })).rejects.toThrow('may still be running')
    expect(fixture.manager.get().hosts).toHaveLength(1)
    expect(store.get(fixture.reportedHostId, edit.draft.threadId)?.draft).toEqual(edit.draft)
  })
})

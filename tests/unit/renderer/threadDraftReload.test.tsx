import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import type { AgentBridge, AgentState } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { agentBridgeFor } from '../../fixtures/agentBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const image = { id: 'retained-image', name: 'pixel.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-reload-drafts-'))
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host: new E2EAgentHost(), credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  await credentials.load(); await control.start(); await control.command({ type: 'connect' })
  const bridge: AgentBridge = agentBridgeFor(control)
  return { control, bridge, disk: async () => JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')),
    async close() {
      cleanup(); control.dispose(); await control.privacyChanged()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-reload-drafts-')) throw new Error('Unexpected fixture directory')
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('fresh renderer draft durability with a live main controller', () => {
  it.each([
    ['pending', 'retry'], ['failed', 'retry'], ['failed', 'unrelated write'], ['pending', 'original success'],
  ] as const)('does not certify a %s disk write on initial get, then confirms %s', async (stage, recovery) => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let writing = false
    const original = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
      if ((value as AgentState).threadDrafts?.some(item => item.text === 'Keep this unsaved draft')) {
        writing = true; await gate
        if (recovery !== 'original success') throw new Error('Injected disk failure')
      }
      return original.call(this, value)
    })
    try {
      const first = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(first.result.current.state).not.toBeNull())
      const oldStore = first.result.current.threadDrafts
      act(() => { oldStore.edit('workshop', { text: 'Keep this unsaved draft', attachments: [image] }); oldStore.flush('workshop') })
      await waitFor(() => expect(writing).toBe(true))
      expect((await f.disk()).threadDrafts).toEqual([])
      if (stage === 'failed') {
        release()
        await waitFor(() => expect(oldStore.snapshot('workshop').save).toBe('unsaved'))
      }
      first.unmount()
      const fresh = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(fresh.result.current.state).not.toBeNull())
      const store = fresh.result.current.threadDrafts
      expect(store).not.toBe(oldStore)
      expect(store.draft('workshop')).toMatchObject({ text: 'Keep this unsaved draft', attachments: [image] })
      expect(store.snapshot('workshop').save).toBe(stage === 'pending' ? 'saving' : 'unsaved')
      release()
      if (recovery !== 'original success') {
        await waitFor(() => expect(store.snapshot('workshop').save).toBe('unsaved'))
        // A non-writing unrelated state echo cannot prove durability.
        await act(async () => { await fresh.result.current.command({ type: 'voice-state', status: 'off', error: null }) })
        expect(store.snapshot('workshop').save).toBe('unsaved')
        expect((await f.disk()).threadDrafts).toEqual([])
        spy.mockRestore()
        if (recovery === 'retry') act(() => store.flush('workshop', true))
        else {
          await act(async () => { await f.control.privacyChanged() })
          // The draft failure string is still present. Successful full-state
          // persistence, not that unrelated global field, confirms this revision.
          expect(f.control.get().error).toContain('Could not save this thread draft')
        }
      }
      await waitFor(() => expect(store.snapshot('workshop').save).toBe('saved'))
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: store.draft('workshop').draftId, text: 'Keep this unsaved draft', attachments: [image] }))
      expect(await f.disk()).not.toHaveProperty('threadDraftPersistence')
    } finally { release(); spy.mockRestore(); await f.close() }
  })

  it('keeps a newer revision dirty when an older real write completes after reload', async () => {
    const f = await fixture()
    let releaseOld!: () => void, releaseNew!: () => void
    const oldGate = new Promise<void>(done => { releaseOld = done })
    const newGate = new Promise<void>(done => { releaseNew = done })
    let started = 0
    const original = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
      const text = (value as AgentState).threadDrafts?.find(item => item.threadId === 'workshop')?.text
      if (text === 'Older revision') { ++started; await oldGate }
      if (text === 'Newer revision') { ++started; await newGate; throw new Error('New write failed') }
      return original.call(this, value)
    })
    try {
      const first = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(first.result.current.state).not.toBeNull())
      const oldStore = first.result.current.threadDrafts
      act(() => { oldStore.edit('workshop', { text: 'Older revision' }); oldStore.flush('workshop') })
      await waitFor(() => expect(started).toBe(1))
      act(() => { oldStore.edit('workshop', { text: 'Newer revision', attachments: [image] }); oldStore.flush('workshop') })
      await waitFor(() => expect(started).toBe(2))
      first.unmount()
      const fresh = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(fresh.result.current.state).not.toBeNull())
      const store = fresh.result.current.threadDrafts
      releaseOld()
      await waitFor(async () => expect((await f.disk()).threadDrafts[0].text).toBe('Older revision'))
      expect(store.snapshot('workshop')).toMatchObject({ draft: { text: 'Newer revision', attachments: [image] }, save: 'saving' })
      releaseNew()
      await waitFor(() => expect(store.snapshot('workshop').save).toBe('unsaved'))
      expect((await f.disk()).threadDrafts[0].text).toBe('Older revision')
      spy.mockRestore()
      act(() => store.flush('workshop', true))
      await waitFor(() => expect(store.snapshot('workshop').save).toBe('saved'))
      expect((await f.disk()).threadDrafts[0]).toMatchObject({ text: 'Newer revision', attachments: [image] })
    } finally { releaseOld(); releaseNew(); spy.mockRestore(); await f.close() }
  })

  it('does not certify a failed clear while disk still has the old text and image', async () => {
    const f = await fixture()
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      const first = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(first.result.current.state).not.toBeNull())
      const oldStore = first.result.current.threadDrafts
      act(() => { oldStore.edit('workshop', { text: 'Remove this draft', attachments: [image] }); oldStore.flush('workshop') })
      await waitFor(() => expect(oldStore.snapshot('workshop').save).toBe('saved'))
      spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValue(new Error('Clear failed'))
      act(() => { oldStore.edit('workshop', { text: '', attachments: [] }); oldStore.flush('workshop') })
      await waitFor(() => expect(oldStore.snapshot('workshop').save).toBe('unsaved'))
      first.unmount()
      const fresh = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(fresh.result.current.state).not.toBeNull())
      const store = fresh.result.current.threadDrafts
      expect(store.snapshot('workshop')).toMatchObject({ draft: { text: '', attachments: [], draftId: oldStore.draft('workshop').draftId }, save: 'unsaved' })
      expect((await f.disk()).threadDrafts[0]).toMatchObject({ text: 'Remove this draft', attachments: [image] })
      spy.mockRestore()
      act(() => store.flush('workshop', true))
      await waitFor(() => expect(store.snapshot('workshop').save).toBe('saved'))
      expect((await f.disk()).threadDrafts).toEqual([])
    } finally { spy?.mockRestore(); await f.close() }
  })
})

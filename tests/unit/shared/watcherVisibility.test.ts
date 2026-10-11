// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { visibleWatcherState } from '../../../src/shared/watcherVisibility'

it.each(['watcher', 'watcher-history'] as const)('projects every %s collection without changing saved state', kind => {
  const state = emptyDesktopState(randomUUID()), at = '2026-10-10T17:00:00Z'
  state.host.threads = ['hidden', 'ordinary'].map(id => ({ id, kind: id === 'hidden' ? kind : 'project',
    projectId: 'project', title: id, modelId: 'model', status: 'idle', messages: [], requests: [] }))
  state.activeThreadId = 'hidden'; state.activeProjectId = 'project'
  state.draftThreadId = 'hidden'; state.draftRequestId = 'request'; state.draft = 'Synthetic draft'; state.composing = true
  const receipts = ['hidden', 'ordinary'].map(threadId => ({ threadId, draftId: randomUUID() }))
  state.deliveredDrafts = receipts; state.obsoleteDrafts = receipts; state.followupReceipts = receipts
  state.threadDrafts = receipts.map(receipt => ({ ...receipt, text: 'Synthetic', attachments: [], requestId: null, updatedAt: at }))
  state.deliveries = receipts.map(receipt => ({ ...receipt, status: 'queued', createdAt: at, updatedAt: at }))
  state.followups = receipts.map(receipt => ({ ...receipt, id: randomUUID(), text: 'Synthetic', attachments: [], status: 'queued', createdAt: at, updatedAt: at }))
  state.threadDraftPersistence = receipts.map(receipt => ({ ...receipt, status: 'saved' }))
  state.unconfirmedSettings = receipts.map(receipt => ({ threadId: receipt.threadId, reasoningEffort: 'high' }))
  const before = structuredClone(state)
  const visible = visibleWatcherState(state, false)
  expect(visible.host.threads.map(thread => thread.id)).toEqual(['ordinary'])
  expect(visible).toMatchObject({ activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null,
    draftRequestId: null, draftAttachments: [], composing: false })
  for (const key of ['threadDrafts', 'deliveries', 'deliveredDrafts', 'obsoleteDrafts', 'followups', 'followupReceipts', 'threadDraftPersistence', 'unconfirmedSettings'] as const) {
    expect(visible[key]).toEqual(state[key]!.filter(record => record.threadId === 'ordinary'))
  }
  expect(state).toEqual(before)
  expect(visibleWatcherState(state, true)).toBe(state)
  expect(visibleWatcherState(visible, false)).toBe(visible)
  expect(visibleWatcherState(null, false)).toBeNull()
})

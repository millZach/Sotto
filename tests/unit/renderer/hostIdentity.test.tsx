import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { clientAgentState, hostEntityKey, parseHostEntityKey } from '../../../src/shared/clientIdentity'
import { attentionItemKey } from '../../../src/shared/agentAttention'
import { threadsStateFixture } from './liveAgentState'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { openBeside, SINGLE_VIEW, qualifyLegacyLayout } from '../../../src/renderer/src/agents/splitLayout'
import { ThreadCompaction } from '../../../src/renderer/src/agents/ThreadCompaction'
import { cacheableShell } from '../../../src/renderer/src/agents/shellCache'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
afterEach(cleanup)
function state(hostId: string) {
  const raw = threadsStateFixture()
  raw.hostId = hostId
  raw.host.hostId = hostId
  raw.host.threads = [{ id: 'same:thread', hostId, projectId: 'same:project', title: hostId === A ? 'Laptop task' : 'Forge task', modelId: '', status: 'idle', messages: [], requests: [] }]
  raw.host.projects = [{ id: 'same:project', hostId, title: hostId === A ? 'Laptop project' : 'Forge project', path: '/work' }]
  raw.activeThreadId = 'same:thread'; raw.activeProjectId = 'same:project'; raw.assignments = []
  raw.queue = [{ id: 'same:queue', threadId: 'same:thread', kind: 'ready', text: 'Ready', createdAt: new Date().toISOString(), deferred: false }]
  raw.threadDrafts = [{ threadId: 'same:thread', draftId: '33333333-3333-4333-8333-333333333333', text: hostId === A ? 'Laptop draft' : 'Forge draft', requestId: null, attachments: [], updatedAt: new Date().toISOString() }]
  return clientAgentState(raw)
}
it('keeps both hosts in one sidebar, pane arrangement, draft store and attention queue', () => {
  const first = state(A), second = state(B)
  const combined = { ...first, host: { ...first.host, threads: [...first.host.threads, ...second.host.threads], projects: [...first.host.projects, ...second.host.projects] }, queue: [...first.queue, ...second.queue], threadDrafts: [...first.threadDrafts!, ...second.threadDrafts!] }
  const rows = describeThreads(combined, Date.now())
  const organization = organizeWorkspace(combined, rows, '')
  const onOpen = vi.fn()
  render(<ThreadSidebar state={combined} organization={organization} command={vi.fn(async () => combined)} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()} currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
  fireEvent.click(screen.getByText('Laptop task')); fireEvent.click(screen.getByText('Forge task'))
  expect(onOpen.mock.calls.map(call => call[0])).toEqual([hostEntityKey(A, 'same:thread'), hostEntityKey(B, 'same:thread')])
  expect(openBeside(SINGLE_VIEW, first.activeThreadId!, second.activeThreadId!).panes).toEqual([first.activeThreadId, second.activeThreadId])
  const drafts = new ThreadDraftStore(vi.fn(async () => combined)); drafts.receive(combined)
  expect(drafts.draft(first.activeThreadId!).text).toBe('Laptop draft')
  expect(drafts.draft(second.activeThreadId!).text).toBe('Forge draft')
  expect(new Set(combined.queue.map(attentionItemKey)).size).toBe(2)
})
it('scopes compaction dismissals to one host', () => {
  const usage = { contextUsed: 100_000, contextUpdatedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', rateVersions: [], partial: false }
  const thread = { ...state(A).host.threads[0]!, providerId: 'claude' as const, usage, messages: [{ id: 'user', role: 'user' as const, text: 'Work on the project', createdAt: '2020-01-01T00:00:00Z' }] }
  const view = render(<ThreadCompaction thread={thread} supported connected command={vi.fn()} />)
  fireEvent.click(screen.getByText('Keep full history'))
  expect(screen.queryByText('Keep full history')).toBeNull()
  view.rerender(<ThreadCompaction thread={{ ...thread, id: hostEntityKey(B, 'same:thread'), hostId: B }} supported connected command={vi.fn()} />)
  expect(screen.getByText('Keep full history')).toBeInTheDocument()
})
it('retains legacy identities until a host is known and migrates saved panes once', () => {
  const legacy = threadsStateFixture()
  expect(clientAgentState(legacy)).toBe(legacy)
  const old = openBeside(SINGLE_VIEW, 'a', 'b')
  const migrated = qualifyLegacyLayout(old, A)
  expect(migrated.panes).toEqual([hostEntityKey(A, 'a'), hostEntityKey(A, 'b')])
  expect(qualifyLegacyLayout(migrated, B)).toBe(migrated)
  const cached = cacheableShell(state(A))
  expect(cached.host.threads[0]!.id).toBe(state(A).host.threads[0]!.id)
  expect(cached.threadDrafts).toEqual([])
})
it('round-trips IDs containing separators and even the reserved client prefix', () => {
  for (const id of ['x:y|z', 'line\nnext', hostEntityKey(B, 'nested')]) expect(parseHostEntityKey(hostEntityKey(A, id))).toEqual({ hostId: A, id })
})

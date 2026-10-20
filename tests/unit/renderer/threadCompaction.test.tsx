import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { compactionBusy, compactionOffered, holdCompactionRecommendation, ThreadCompaction } from '../../../src/renderer/src/agents/ThreadCompaction'
import type { AgentThread } from '../../../src/shared/agents'

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })
const thread: AgentThread = { id: 'thread', providerId: 'claude', projectId: 'project', title: 'Work', modelId: 'claude', status: 'idle', messages: [{ id: 'user', role: 'user', text: 'Work on this project.', createdAt: '2026-09-13T09:00:00Z' }], requests: [],
  usage: { contextUsed: 100_000, contextUpdatedAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T10:00:00Z', rateVersions: [], partial: false } }
it('offers Claude compaction only at the inclusive 100k token and 70 minute boundary and dismisses one snapshot', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T11:09:59.999Z'))
  const command = vi.fn()
  const { rerender } = render(<ThreadCompaction thread={thread} supported connected command={command} />)
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(1) })
  expect(screen.getByText('Keep full history')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Keep full history'))
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
  rerender(<ThreadCompaction thread={{ ...thread, usage: { ...thread.usage!, contextUpdatedAt: '2026-09-13T09:59:00Z' } }} supported connected command={command} />)
  expect(screen.getByText('Keep full history')).toBeInTheDocument()
})
it('preserves dismissal across remount, ignores bookkeeping timestamps, suppresses pending work and excludes providers that cannot compact', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T11:10:00Z'))
  const command = vi.fn()
  const owner = { ...thread, id: 'remount' }
  const mount = (value: AgentThread, supported = true) => <ThreadCompaction thread={value} supported={supported} connected command={command} />
  const view = render(mount(owner))
  fireEvent.click(screen.getByText('Keep full history'))
  view.unmount()
  const next = render(mount({ ...owner, usage: { ...owner.usage!, updatedAt: '2026-09-13T11:09:00Z' } }))
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
  for (const value of [
    { ...thread, id: 'running', status: 'running' as const },
    { ...thread, id: 'request', requests: [{ id: 'q', kind: 'question' as const, text: 'Continue?', options: [] }] },
    { ...thread, id: 'pending', compaction: { commandId: 'compact', status: 'running' as const } },
    { ...thread, id: 'small', usage: { ...thread.usage!, contextUsed: 99_999 } },
    { ...thread, id: 'unknown', usage: { ...thread.usage!, contextUpdatedAt: undefined } },
    { ...thread, id: 'never', resumeCompactionDismissed: true },
    { ...thread, id: 'grok', providerId: 'grok' as const },
  ]) {
    next.rerender(mount(value, value.providerId !== 'grok'))
    expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
  }
  expect(screen.queryByRole('button', { name: 'Compact context' })).not.toBeInTheDocument()
})
it('retains every dismissed snapshot for this renderer session and ignores dismissals from earlier sessions', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T11:10:00Z'))
  const owner = { ...thread, id: 'session-history' }
  localStorage.setItem(`sotto:context-compaction:${owner.id}`, JSON.stringify([owner.id, owner.usage!.contextUpdatedAt]))
  const command = vi.fn()
  const view = render(<ThreadCompaction thread={owner} supported connected command={command} />)
  expect(screen.getByText('Keep full history')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Keep full history'))
  view.rerender(<ThreadCompaction thread={{ ...owner, usage: { ...owner.usage!, contextUpdatedAt: '2026-09-13T09:59:00Z' } }} supported connected command={command} />)
  fireEvent.click(screen.getByText('Keep full history'))
  view.rerender(<ThreadCompaction thread={owner} supported connected command={command} />)
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
  view.unmount()
  render(<ThreadCompaction thread={owner} supported connected command={command} />)
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
})
it('keeps compaction feedback truthful, and leaves running one to the pane menu', () => {
  const command = vi.fn()
  const view = render(<ThreadCompaction thread={{ ...thread, providerId: 'codex' }} supported connected command={command} />)
  // Compact context itself is an item in the pane header's More menu; nothing here offers it a second time.
  expect(screen.queryByRole('button', { name: 'Compact context' })).not.toBeInTheDocument()
  view.rerender(<ThreadCompaction thread={{ ...thread, compaction: { commandId: 'c', status: 'uncertain' } }} supported connected command={command} />)
  expect(screen.getByRole('status')).toHaveTextContent(/unconfirmed/i)
  view.rerender(<ThreadCompaction thread={{ ...thread, compaction: { commandId: 'c', status: 'completed' } }} supported connected command={command} />)
  expect(screen.getByRole('status')).toHaveTextContent('Context compacted')
})
it('holds compaction while the thread has work of its own, or nothing but /compact to fold', () => {
  expect(compactionBusy(thread)).toBe(false)
  expect(compactionBusy(thread, true)).toBe(true)
  expect(compactionBusy({ ...thread, status: 'running' })).toBe(true)
  expect(compactionBusy({ ...thread, requests: [{ id: 'q', kind: 'question', text: 'Continue?', options: [] }] })).toBe(true)
  expect(compactionBusy({ ...thread, compaction: { commandId: 'c', status: 'running' } })).toBe(true)
  expect(compactionBusy({ ...thread, messages: [{ ...thread.messages[0]!, text: '/compact' }] })).toBe(true)
})
it('offers compaction before Claude has reported support, but not once it reports none or before a native session exists', () => {
  const compact = { compact: true }
  expect(compactionOffered(compact, { ...thread, manualCompactionSupported: undefined })).toBe(true)
  expect(compactionOffered(compact, { ...thread, manualCompactionSupported: true })).toBe(true)
  expect(compactionOffered(compact, { ...thread, manualCompactionSupported: false })).toBe(false)
  expect(compactionOffered(compact, { ...thread, nativeSessionStarted: false })).toBe(false)
  expect(compactionOffered({ compact: false }, thread)).toBe(false)
})
it('offers Codex and Muse compaction at the same 100k token and 70 minute boundary as Claude, once they report context', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T11:09:59.999Z'))
  const command = vi.fn()
  for (const providerId of ['codex', 'muse'] as const) {
    const owner = { ...thread, id: `${providerId}-offer`, providerId }
    const view = render(<ThreadCompaction thread={owner} supported connected command={command} />)
    expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByText('Keep full history')).toBeInTheDocument()
    view.rerender(<ThreadCompaction thread={{ ...owner, usage: { ...owner.usage!, contextUsed: 99_999 } }} supported connected command={command} />)
    expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
    // A thread whose provider has not said how full its context is gets no recommendation.
    view.rerender(<ThreadCompaction thread={{ ...owner, usage: { ...owner.usage!, contextUsed: undefined } }} supported connected command={command} />)
    expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
    view.rerender(<ThreadCompaction thread={{ ...owner, modelId: 'other', usage: { ...owner.usage!, modelId: 'earlier' } }} supported connected command={command} />)
    expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
    view.unmount()
    vi.setSystemTime(new Date('2026-09-13T11:09:59.999Z'))
  }
})
it('never offers compaction for Grok Build, Devin, OpenCode or a thread that names no provider, whatever their usage says', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T12:00:00Z'))
  const command = vi.fn()
  for (const providerId of ['grok', 'devin', 'opencode', undefined] as const) {
    const view = render(<ThreadCompaction thread={{ ...thread, id: `${providerId ?? 'none'}-never`, providerId }} supported connected command={command} />)
    expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
    view.unmount()
  }
})
it('does not recommend again a context whose compaction started, until the provider reports usage again', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T12:00:00Z'))
  const command = vi.fn(async () => undefined)
  // Codex names a compaction without its new size, so the old figure and its time outlive the compaction.
  const owner = { ...thread, id: 'codex-compacted', providerId: 'codex' as const }
  const view = render(<ThreadCompaction thread={owner} supported connected command={command} />)
  await act(async () => { fireEvent.click(screen.getByText('Compact')) })
  expect(command).toHaveBeenCalledWith({ type: 'compact-thread', threadId: owner.id })
  view.rerender(<ThreadCompaction thread={{ ...owner, compaction: { commandId: 'c', status: 'completed' } }} supported connected command={command} />)
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
  // Usage reported after it is a new context, judged by the usual rules.
  view.rerender(<ThreadCompaction thread={{ ...owner, usage: { ...owner.usage!, contextUpdatedAt: '2026-09-13T10:30:00Z' } }} supported connected command={command} />)
  expect(screen.getByText('Keep full history')).toBeInTheDocument()
  view.unmount()
  // The pane menu's Compact context holds it the same way.
  const menu = { ...thread, id: 'muse-compacted', providerId: 'muse' as const }
  holdCompactionRecommendation(menu)
  render(<ThreadCompaction thread={menu} supported connected command={command} />)
  expect(screen.queryByText('Keep full history')).not.toBeInTheDocument()
})
it('keeps recommending a context whose compaction could not start', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T12:00:00Z'))
  const command = vi.fn(async () => { throw new Error('Codex is not connected.') })
  render(<ThreadCompaction thread={{ ...thread, id: 'codex-refused', providerId: 'codex' }} supported connected command={command} />)
  await act(async () => { fireEvent.click(screen.getByText('Compact')) })
  expect(screen.getByRole('alert')).toHaveTextContent('Codex is not connected.')
  expect(screen.getByText('Keep full history')).toBeInTheDocument()
})

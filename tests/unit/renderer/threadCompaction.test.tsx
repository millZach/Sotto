import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadCompaction } from '../../../src/renderer/src/agents/ThreadCompaction'
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
it('preserves dismissal across remount, ignores bookkeeping timestamps, suppresses pending work and excludes other providers', () => {
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
    { ...thread, id: 'codex', providerId: 'codex' as const },
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
it('keeps compaction feedback truthful and routes one explicit manual request', () => {
  const command = vi.fn()
  const view = render(<ThreadCompaction thread={{ ...thread, providerId: 'codex' }} supported connected command={command} />)
  fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
  expect(command).toHaveBeenCalledWith({ type: 'compact-thread', threadId: 'thread' })
  view.rerender(<ThreadCompaction thread={{ ...thread, compaction: { commandId: 'c', status: 'uncertain' } }} supported connected command={command} />)
  expect(screen.getByRole('status')).toHaveTextContent(/unconfirmed/i)
  expect(screen.getByRole('button', { name: 'Compact context' })).toBeDisabled()
  view.rerender(<ThreadCompaction thread={{ ...thread, compaction: { commandId: 'c', status: 'completed' } }} supported connected command={command} />)
  expect(screen.getByRole('status')).toHaveTextContent('Context compacted')
})

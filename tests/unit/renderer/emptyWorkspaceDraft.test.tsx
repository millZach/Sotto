import { promptText } from './helpers/promptEditor'
import { threadsStateFixture } from '../../fixtures/agentState'
import React, { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AgentAttachmentHandle, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { draftThreads } from '../../../src/renderer/src/agents/draftThreads'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { openSidebarFolders } from '../../fixtures/renderer/liveAgentState'
import { agentContextFixture } from '../../fixtures/agentContext'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const LEFTOVER = 'Change every link in docs/release to the new releases repository, then run the link check and list what it could not reach.'
const SHOT: AgentAttachmentHandle = { id: 'release-page', name: 'release-page.png', mimeType: 'image/png', sizeBytes: 8, digest: 'e'.repeat(64) }

/** The design fixture with no pane open, and the coordinator holding a draft written for `draftThreadId`. */
function withDraft(draftThreadId: string | null, connection: AgentState['connection'] = 'connected'): AgentState {
  return threadsStateFixture({ host: { connected: connection === 'connected' },
    topLevel: { connection, activeThreadId: null, activeProjectId: 'workshop', draft: LEFTOVER, draftThreadId } })
}

type Command = (request: AgentCommand) => Promise<AgentState | null>
type Respond = (request: AgentCommand, current: AgentState) => AgentState | null | undefined
/**
 * Renders Threads over a published state that a command's reply replaces, as main's does. `respond` returns the
 * state main publishes for a request, null for a lost reply, or undefined to answer with the current state unchanged.
 */
function renderEmpty(initial: AgentState, respond?: Respond) {
  let current = initial
  const listeners = new Set<() => void>()
  const command = vi.fn<Command>(async request => {
    const next = respond?.(request, current)
    if (next === undefined) return current
    if (next === null) return null
    current = next
    threadDrafts.receive(next)
    listeners.forEach(listener => listener())
    return next
  })
  const threadDrafts = new ThreadDraftStore(command, 0)
  threadDrafts.receive(initial); openSidebarFolders(initial)
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  vi.mocked(useAgents).mockImplementation(() => {
    const state = useSyncExternalStore(subscribe, () => current)
    return { ...agentContextFixture(state, command), threadDrafts }
  })
  render(<ThreadsView now={NOW} layoutStore={new SplitLayoutStore()} />)
  return command
}
const sent = <T extends AgentCommand['type']>(command: { mock: { calls: [AgentCommand][] } }, type: T): Extract<AgentCommand, { type: T }>[] =>
  command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)
/** Main saves a thread's composer and says so. */
const savedComposer: Respond = (request, current) => request.type === 'save-thread-draft'
  ? { ...current, threadDraftPersistence: [{ threadId: request.threadId, draftId: request.draftId, status: 'saved' }] }
  : undefined
const selected: Respond = (request, current) => request.type === 'select-thread' ? { ...current, activeThreadId: request.threadId } : undefined
const cleared = (current: AgentState): AgentState => ({ ...current, draft: '', draftAttachments: [], draftThreadId: null, draftRequestId: null })

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); draftThreads.reset() })

describe('a saved draft on the empty Threads page (issue #736)', () => {
  it('asks to reconnect only while disconnected, and keeps the draft in sight', () => {
    renderEmpty(withDraft('gone-thread', 'disconnected'))
    expect(screen.getByRole('heading', { name: 'Your draft is saved.' })).toBeVisible()
    expect(screen.getByText('Reconnect to continue your saved draft.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Saved draft' })).toHaveValue(LEFTOVER)
    expect(screen.getByRole('button', { name: 'Connect providers' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument()
  })

  it('never asks to reconnect while connected when the draft’s thread is gone', () => {
    renderEmpty(withDraft('gone-thread'))
    expect(screen.getByRole('heading', { name: 'A draft from an earlier thread is saved.' })).toBeVisible()
    expect(screen.queryByText(/Reconnect/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect providers' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Saved draft' })).toHaveValue(LEFTOVER)
    expect(screen.getByRole('button', { name: 'New thread with this draft' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeEnabled()
  })

  it('offers the saved draft without Open Agents', () => {
    renderEmpty(withDraft('gone-thread'))
    expect(screen.getByRole('heading', { name: 'A draft from an earlier thread is saved.' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New thread with this draft' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Open Agents' })).not.toBeInTheDocument()
  })

  it('says when the leftover draft answered a question in its old thread', () => {
    renderEmpty({ ...withDraft('gone-thread'), draftRequestId: 'gone-question' })
    expect(screen.getByRole('heading', { name: 'An answer from an earlier thread is saved.' })).toBeVisible()
    expect(screen.getByText('Its thread and the question it answered are no longer here. Start a new thread with it, or discard it.')).toBeVisible()
  })

  it('starts a new thread with the leftover draft in its composer, and lets the old copy go once that is saved', async () => {
    const command = renderEmpty(withDraft('gone-thread'), savedComposer)
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe(LEFTOVER))
    const [created] = sent(command, 'create-thread')
    expect(created).toMatchObject({ projectId: 'workshop' })
    await waitFor(() => expect(sent(command, 'cancel-draft')).toHaveLength(1))
    // The new thread's composer was saved with the draft before the coordinator's copy was let go.
    expect(sent(command, 'save-thread-draft').at(-1)).toMatchObject({ threadId: created!.threadId, text: LEFTOVER })
    const order = command.mock.calls.map(([request]) => request.type)
    expect(order.indexOf('save-thread-draft')).toBeLessThan(order.indexOf('cancel-draft'))
    expect(sent(command, 'create-thread')).toHaveLength(1)
  })

  it('moves the draft’s images with it and names them on the page', async () => {
    const command = renderEmpty({ ...withDraft('gone-thread'), draftAttachments: [SHOT] }, savedComposer)
    expect(screen.getByText('Image: release-page.png')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(sent(command, 'cancel-draft')).toHaveLength(1))
    expect(sent(command, 'save-thread-draft').at(-1)).toMatchObject({ text: LEFTOVER, attachments: [SHOT] })
    const order = command.mock.calls.map(([request]) => request.type)
    expect(order.indexOf('save-thread-draft')).toBeLessThan(order.indexOf('cancel-draft'))
  })

  it('keeps the leftover draft when the new thread’s composer could not be saved', async () => {
    const command = renderEmpty(withDraft('gone-thread'), request => request.type === 'save-thread-draft' ? null : undefined)
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe(LEFTOVER))
    await waitFor(() => expect(sent(command, 'save-thread-draft').length).toBeGreaterThan(0))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(sent(command, 'cancel-draft')).toHaveLength(0)
  })

  it('does not add the draft twice when the same unused thread is reused after the old copy stayed', async () => {
    // The composer was saved with the draft, but main's answer to cancel-draft was lost, so the leftover stays.
    const first = renderEmpty(withDraft('gone-thread'), (request, current) => request.type === 'cancel-draft' ? null : savedComposer(request, current))
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(sent(first, 'cancel-draft')).toHaveLength(1))
    const [created] = sent(first, 'create-thread')
    cleanup(); draftThreads.reset()
    // Main now lists that thread, still unused, with its saved composer, and no pane is open.
    const base = withDraft('gone-thread')
    const unused: AgentState['host']['threads'][number] = { id: created!.threadId!, projectId: 'workshop', title: 'New thread', titleSource: 'default',
      modelId: created!.modelId!, ...(created!.reasoningEffort ? { reasoningEffort: created!.reasoningEffort } : {}), status: 'idle', messages: [], requests: [] }
    const again = renderEmpty({ ...base, host: { ...base.host, threads: [...base.host.threads, unused] },
      threadDrafts: [{ threadId: unused.id, draftId: sent(first, 'save-thread-draft').at(-1)!.draftId, text: LEFTOVER, attachments: [], requestId: null, updatedAt: new Date(NOW).toISOString() }] },
    (request, current) => savedComposer(request, current) ?? selected(request, current))
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe(LEFTOVER))
    expect(sent(again, 'create-thread')).toHaveLength(0)
    await waitFor(() => expect(sent(again, 'cancel-draft')).toHaveLength(1))
    for (const save of sent(again, 'save-thread-draft')) expect(save.text).toBe(LEFTOVER)
  })

  it('does not add the draft twice when a refused new thread is tried again', async () => {
    let refusals = 1
    const command = renderEmpty(withDraft('gone-thread'), (request, current) => request.type === 'create-thread'
      ? { ...current, error: refusals-- > 0 ? 'The provider refused this thread.' : null }
      : savedComposer(request, current))
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    // The refusal closes the pane and keeps its composer, which already holds the draft, for the next try.
    await waitFor(() => expect(screen.getByRole('button', { name: 'New thread with this draft' })).toBeEnabled())
    expect(sent(command, 'cancel-draft')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(sent(command, 'create-thread')).toHaveLength(2))
    await waitFor(() => expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe(LEFTOVER))
    await waitFor(() => expect(sent(command, 'cancel-draft')).toHaveLength(1))
    expect(sent(command, 'save-thread-draft').at(-1)).toMatchObject({ threadId: sent(command, 'create-thread')[1]!.threadId, text: LEFTOVER })
  })

  it('opens the thread a saved draft belongs to while that thread is still here, with the cursor in its composer', async () => {
    const command = renderEmpty(withDraft('footer-links'), selected)
    expect(screen.getByRole('heading', { name: 'Your draft for Footer links is saved.' })).toBeVisible()
    expect(screen.queryByText(/Reconnect/u)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
  })

  it('discards the draft only after asking, Escape keeps it, and focus lands on the page heading after', async () => {
    const command = renderEmpty(withDraft('gone-thread'), (request, current) => request.type === 'cancel-draft' ? cleared(current) : undefined)
    const discard = screen.getByRole('button', { name: 'Discard draft' })
    discard.focus()
    fireEvent.click(discard)
    const dialog = screen.getByRole('dialog', { name: 'Discard this draft?' })
    expect(within(dialog).getByRole('button', { name: 'Keep draft' })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sent(command, 'cancel-draft')).toHaveLength(0)
    await waitFor(() => expect(discard).toHaveFocus())
    fireEvent.click(discard)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Discard this draft?' })).getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(sent(command, 'cancel-draft')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Choose a thread.' })).toHaveFocus())
  })

  it('leaves a recovered draft after a provider upgrade to its own notice', () => {
    renderEmpty({ ...withDraft(null), providerUpgrade: { migratedAt: NOW, recoveryPath: 'C:/recovery' } })
    expect(screen.getByRole('heading', { name: 'Choose a thread.' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Recovered work' })).toBeVisible()
  })
})

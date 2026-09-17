import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { AgentComposer } from '../../../src/renderer/src/agents/AgentView'

afterEach(cleanup)

function pausedState(): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { connected: true, name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [{ id: 'model', name: 'Model', provider: 'codex', ready: true, supportsImages: true }],
      projects: [{ id: 'project', title: 'Workshop', path: 'D:\\Workshop' }],
      threads: [{ id: 'thread', projectId: 'project', title: 'Build game', modelId: 'model', status: 'idle', messages: [], requests: [] }],
    },
    assignments: [], queue: [], activeThreadId: 'thread', activeProjectId: 'project',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    threadDrafts: [{ threadId: 'thread', draftId: 'efc0d780-9ffd-4a0a-9497-09cdc9f3bdc8', text: 'Keep the existing colors.',
      attachments: [{ id: 'reference', name: 'Reference.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
      requestId: null, updatedAt: '2026-09-14T16:00:00.000Z' }],
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'listening', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

describe('paused saved draft in the home composer', () => {
  it.each([true, false])('shows saved text and images without permitting an empty editor to overwrite them (managed: %s)', managed => {
    const state = pausedState()
    if (managed) state.assignments = [{ threadId: 'thread', mode: 'managed', instruction: '', followups: 0, paused: false,
      seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: 0,
      startedAt: '', origin: 'unknown', stopReason: 'none', stoppedAt: '' }]
    const command = vi.fn(async () => state)
    render(<AgentComposer state={state} command={command} enterToSend />)
    const editor = screen.getByRole('textbox', { name: 'Prompt' })
    expect(editor).toHaveValue('Keep the existing colors.')
    expect(editor).toHaveAttribute('readonly')
    expect(editor).not.toBeDisabled()
    expect(screen.getByRole('img', { name: 'Reference.png' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Reference.png' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Attach screenshots' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
    fireEvent.change(editor, { target: { value: 'x' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Resume draft' }))
    expect(command).toHaveBeenCalledWith({ type: 'resume-draft', threadId: 'thread' })
  })

  it('keeps the saved answer identity and waits for explicit resume before showing an editable draft', () => {
    const state = pausedState()
    state.threadDrafts![0]!.requestId = 'saved-question'
    state.threadDrafts![0]!.attachments = []
    const command = vi.fn(async () => state)
    const view = render(<AgentComposer state={state} command={command} />)
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Keep the existing colors.')
    const resumed = { ...state, draft: 'Keep the existing colors.', draftThreadId: 'thread', draftRequestId: 'saved-question', composing: true }
    view.rerender(<AgentComposer state={resumed} command={command} />)
    expect(screen.getByRole('textbox', { name: 'Your answer' })).not.toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps the active legacy draft visible ahead of a paused draft for the selected thread', () => {
    const state = pausedState()
    state.draft = 'The active prompt.'
    state.draftThreadId = 'thread'
    state.composing = true
    render(<AgentComposer state={state} command={vi.fn(async () => state)} />)
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('The active prompt.')
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument()
  })
})

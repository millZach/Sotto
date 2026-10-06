import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudIphoneBridge, CloudSession } from '../../../../src/shared/cloudIphone'
import type { ToolsResult } from '../../../../src/shared/tools'
import { CloudIphoneRequest } from '../../../../src/renderer/src/agents/requests/CloudIphoneRequest'
import { CloudIphoneStore } from '../../../../src/renderer/src/tools/cloudIphoneStore'

const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

const session = (patch: Partial<CloudSession> = {}): CloudSession => ({
  id: '11111111-1111-4111-8111-111111111111', threadId: 'workshop', workspaceId: 'workspace',
  status: 'asking', description: 'To check the Needs you list on a native build.', buildPath: 'apps/ios/build/Sotto.app.zip', buildBytes: 41_000_000,
  device: null, expiresAt: Date.now() + 300_000, startedAt: null, endedAt: null, endReason: null, minutes: 0,
  problem: null, steps: [], summary: null, unchecked: [], ...patch,
})

function fakeBridge(initial: CloudSession[]) {
  const bridge: CloudIphoneBridge = {
    status: vi.fn(async () => ok({ keySaved: true, month: '2026-10', monthMinutes: 38, capMinutes: 750, recent: [] })),
    setKey: vi.fn(async () => ok({ saved: true, problem: null })),
    sessions: vi.fn(async () => ok(initial)),
    answer: vi.fn(async ({ sessionId, allow }) => ok(session({ id: sessionId, status: allow ? 'starting' : 'denied' }))),
    end: vi.fn(async ({ sessionId }) => ok(session({ id: sessionId, status: 'ended' }))),
    mount: vi.fn(async () => ok(undefined)),
    onEvent: vi.fn(() => () => undefined),
  }
  return bridge
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the cloud iPhone request card', () => {
  it('renders nothing when the thread has no session', () => {
    const store = new CloudIphoneStore()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={fakeBridge([])} onAnswer={vi.fn()} store={store} />)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('asks with the build, the price and this month’s minutes, and Start answers true', async () => {
    const bridge = fakeBridge([session()])
    const store = new CloudIphoneStore()
    const onAnswer = vi.fn()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={bridge} onAnswer={onAnswer} store={store} />)
    await screen.findByText('Workshop wants to start a cloud iPhone.')
    expect(screen.getByText(/39 MB/)).toBeInTheDocument()
    expect(screen.getByText(/\$0\.02 a minute/)).toBeInTheDocument()
    expect(screen.getByText(/38 of 750 minutes used this month/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start cloud iPhone' }))
    await waitFor(() => expect(bridge.answer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session().id, allow: true })))
    await waitFor(() => expect(onAnswer).toHaveBeenCalled())
    // The session moved to starting: its own card replaces the request.
    await screen.findByText('Starting the cloud iPhone…')
  })

  it('denies without moving focus incorrectly, and the card then disappears', async () => {
    const bridge = fakeBridge([session()])
    const store = new CloudIphoneStore()
    const onAnswer = vi.fn()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={bridge} onAnswer={onAnswer} store={store} />)
    await screen.findByText('Workshop wants to start a cloud iPhone.')
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(bridge.answer).toHaveBeenCalledWith(expect.objectContaining({ allow: false })))
    await waitFor(() => expect(screen.queryByText('Workshop wants to start a cloud iPhone.')).not.toBeInTheDocument())
  })

  it('shows the starting card as a status region', async () => {
    const bridge = fakeBridge([session({ status: 'starting' })])
    const store = new CloudIphoneStore()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={bridge} onAnswer={vi.fn()} store={store} />)
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Uploading apps\/ios\/build\/Sotto\.app\.zip to run\.cloud/)
  })

  it('shows a failed session’s problem and an Open Settings button when it names Settings', async () => {
    const bridge = fakeBridge([session({ status: 'failed', problem: 'No run.cloud key is saved. Add one in Settings.' })])
    const store = new CloudIphoneStore()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={bridge} onAnswer={vi.fn()} store={store} />)
    await screen.findByText('No run.cloud key is saved. Add one in Settings.')
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument()
  })

  it('shows a refused session’s problem with no Open Settings button when it does not name Settings', async () => {
    const bridge = fakeBridge([session({ status: 'refused', problem: 'You have used all 750 minutes for October.' })])
    const store = new CloudIphoneStore()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={bridge} onAnswer={vi.fn()} store={store} />)
    await screen.findByText('You have used all 750 minutes for October.')
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
  })

  it('shows no card for an active session', async () => {
    const bridge = fakeBridge([session({ status: 'active', startedAt: Date.now(), device: 'iPhone 16 · iOS 18' })])
    const store = new CloudIphoneStore()
    render(<CloudIphoneRequest threadId="workshop" threadTitle="Workshop" bridge={bridge} onAnswer={vi.fn()} store={store} />)
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toBe('')
  })
})

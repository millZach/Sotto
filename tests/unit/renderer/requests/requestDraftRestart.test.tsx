import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentRequestCard } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import { RequestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('restores structured selections into a fresh renderer store without sending', async () => {
  let saved: unknown = null
  const bridge = { get: vi.fn(async () => saved), save: vi.fn(async (draft: unknown) => { saved = structuredClone(draft); return saved }), check: vi.fn() }
  vi.stubGlobal('sotto', { requestDrafts: bridge })
  Object.defineProperty(window, 'sotto', { configurable: true, value: { requestDrafts: bridge } })
  const request = { id: 'request', kind: 'question' as const, text: 'Choose', options: [], questions: [
    { id: 'q', question: 'Destination', multiSelect: false, allowFreeText: false, options: [{ id: 'coast', label: 'Coast' }] },
  ] }
  const send = vi.fn(async () => ({ error: null }))
  const card = () => <AgentRequestCard ownerId="owner" ownerTitle="Owner" draftOwner={{ kind: 'thread', providerId: 'codex', ownerId: 'owner' }} request={request} blocked={null} onSubmit={send} store={new RequestAnswerStore()} />
  const first = render(card())
  await userEvent.setup().click(screen.getByRole('radio', { name: 'Coast' }))
  // A real restart recreates the renderer store; only the bridge's saved data survives.
  await waitFor(() => expect(bridge.save).toHaveBeenCalled())
  first.unmount()
  render(card())
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Coast' })).toBeChecked())
  expect(send).not.toHaveBeenCalled()
})

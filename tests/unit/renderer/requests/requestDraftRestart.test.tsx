import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentRequestCard } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import { requestDraftKey, type RequestDraft, type RequestDraftBridge, type RequestDraftOwner } from '../../../../src/shared/requestDrafts'
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


it.each(['thread', 'personal'] as const)('restores a legacy choice for a %s owner and sends only its original option ID', async kind => {
  const saved = new Map<string, RequestDraft>()
  const bridge: RequestDraftBridge = {
    list: vi.fn(async () => [...saved.values()]), discard: vi.fn(async () => false), check: vi.fn(async () => null),
    get: vi.fn(async target => saved.get(requestDraftKey(target)) ?? null),
    save: vi.fn(async draft => { saved.set(requestDraftKey(draft.target), structuredClone(draft)); return draft }),
  }
  const request = { id: 'legacy', kind: 'question' as const, text: 'Choose the route', options: [{ id: 'native-coast', label: 'Coast (Recommended)' }] }
  const owner: RequestDraftOwner = { kind, providerId: 'codex', ownerId: 'owner' }
  const send = vi.fn(async () => ({ error: null }))
  const card = () => <AgentRequestCard ownerId="owner" ownerTitle="Owner" draftOwner={owner} request={request} blocked={null} onSubmit={send} store={new RequestAnswerStore(() => bridge)} />
  const first = render(card())
  await userEvent.setup().click(screen.getByRole('radio', { name: /Coast/u }))
  await screen.findByText('Answer draft saved.')
  first.unmount()
  render(card())
  await waitFor(() => expect(screen.getByRole('radio', { name: /Coast/u })).toBeChecked())
  expect(send).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Send answer' }))
  await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith({ answer: 'native-coast' }))
  expect([...saved.values()][0]?.held).toBe(true)
})

it('keeps a failed legacy choice save visible and blocks sending until it is saved', async () => {
  const bridge: RequestDraftBridge = {
    list: vi.fn(async () => []), discard: vi.fn(async () => false), check: vi.fn(async () => null), get: vi.fn(async () => null),
    save: vi.fn().mockRejectedValueOnce(new Error('Disk unavailable')).mockImplementation(async draft => draft),
  }
  const request = { id: 'legacy', kind: 'question' as const, text: 'Choose', options: [{ id: 'coast', label: 'Coast' }] }
  const send = vi.fn(async () => ({ error: null }))
  render(<AgentRequestCard ownerId="owner" ownerTitle="Owner" draftOwner={{ kind: 'thread', providerId: 'codex', ownerId: 'owner' }} request={request} blocked={null} onSubmit={send} store={new RequestAnswerStore(() => bridge)} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('radio', { name: 'Coast' }))
  await screen.findByText('Disk unavailable')
  expect(screen.getByRole('radio', { name: 'Coast' })).toBeChecked()
  expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
  expect(send).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Save again' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled())
})

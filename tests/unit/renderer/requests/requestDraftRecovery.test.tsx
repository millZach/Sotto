import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import type { RequestDraft, RequestDraftBridge, RequestDraftOwner } from '../../../../src/shared/requestDrafts'
import { RequestDraftRecovery, savedAnswerClipboard, type RecoveryObservation } from '../../../../src/renderer/src/agents/requests/RequestDraftRecovery'
import { requestAnswerOwnerKey, RequestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'

afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'sotto') })

const owner: RequestDraftOwner = { kind: 'thread', ownerId: 'workshop', providerId: 'codex' }
const questions: NonNullable<AgentRequest['questions']> = [
  { id: 'place', question: 'Where should we go?', multiSelect: false, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
  { id: 'checks', question: 'Which checks?', multiSelect: true, allowFreeText: false, options: [{ id: 'unit', label: 'Unit checks' }, { id: 'types', label: 'Type checks' }] },
  { id: 'notes', question: 'Travel notes', multiSelect: false, allowFreeText: true, options: [] },
  { id: 'budget', question: 'Budget', multiSelect: false, allowFreeText: false, required: false, options: [{ id: 'low', label: 'Low' }] },
]
const draft = (patch: Partial<RequestDraft> = {}, target: Partial<RequestDraft['target']> = {}): RequestDraft => ({
  target: { ...owner, requestId: 'durable-form', questions, ...target }, revision: 4, held: false,
  selections: { place: { optionIds: [], other: true, text: 'A quiet shore' }, checks: { optionIds: ['unit', 'types'], other: false, text: '' },
    notes: { optionIds: [], other: false, text: 'Unsent notes survive restart' } },
  ...patch,
})
const live = (patch: Partial<AgentRequest> = {}): AgentRequest => ({ id: 'durable-form', kind: 'question', text: 'Native form', options: [], questions, ...patch })

function fakeBridge(initial: RequestDraft[]) {
  let saved = structuredClone(initial)
  const bridge = {
    get: vi.fn(), save: vi.fn(), check: vi.fn(),
    list: vi.fn(async (input: RequestDraftOwner) => structuredClone(saved.filter(item => item.target.ownerId === input.ownerId))),
    discard: vi.fn(async ({ target, revision }: { target: RequestDraft['target']; revision: number }) => {
      const found = saved.find(item => JSON.stringify(item.target) === JSON.stringify(target))
      if (!found) return false
      if (found.revision !== revision) throw new Error("Error invoking remote method 'request-draft:discard': Error: A newer answer draft may be saved. Reload retained answers before discarding.")
      saved = saved.filter(item => item !== found)
      return true
    }),
    replace: (next: RequestDraft[]) => { saved = structuredClone(next) },
  }
  return bridge
}

function view(bridge: ReturnType<typeof fakeBridge>, props: { live?: AgentRequest[]; observation?: RecoveryObservation; observed?: string; owner?: RequestDraftOwner } = {}) {
  const element = (next: typeof props = props) => <div role="log" tabIndex={0} aria-label="Transcript">
    <RequestDraftRecovery owner={next.owner ?? owner} live={next.live ?? []} observation={next.observation ?? 'ready'} observed={next.observed ?? ''}
      provider="Codex" bridge={bridge as unknown as RequestDraftBridge} />
  </div>
  const rendered = render(element())
  return { ...rendered, update: (next: typeof props) => rendered.rerender(element({ ...props, ...next })) }
}

const saved = () => screen.findByRole('region', { name: 'Saved answer' })

describe('saved answers without a live request', () => {
  it('shows the original question labels, chosen option labels and text with no way to send', async () => {
    const bridge = fakeBridge([draft()])
    view(bridge)
    const card = await saved()
    expect(within(card).getByText('Codex no longer shows this question. This answer was not sent.')).toBeTruthy()
    for (const [question, answer] of [['Where should we go?', 'Other: A quiet shore'], ['Which checks?', 'Unit checks, Type checks'], ['Travel notes', 'Unsent notes survive restart'], ['Budget', 'No answer']]) {
      expect(within(card).getByText(question!).nextElementSibling?.textContent).toBe(answer)
    }
    expect(within(card).queryByRole('button', { name: /send|check|retry/iu })).toBeNull()
    expect(within(card).queryByRole('radio')).toBeNull()
    expect(within(card).queryByRole('textbox')).toBeNull()
    expect(bridge.get).not.toHaveBeenCalled(); expect(bridge.save).not.toHaveBeenCalled(); expect(bridge.check).not.toHaveBeenCalled()
  })

  it('copies the labelled answer through the main-owned clipboard with visible feedback', async () => {
    const deliverOutput = vi.fn(async () => 'copied' as const)
    Object.defineProperty(window, 'sotto', { configurable: true, value: { deliverOutput } })
    view(fakeBridge([draft()]))
    await userEvent.setup().click(within(await saved()).getByRole('button', { name: 'Copy answer' }))
    expect(deliverOutput).toHaveBeenCalledWith({ text: 'Where should we go?\nOther: A quiet shore\n\nWhich checks?\nUnit checks, Type checks\n\nTravel notes\nUnsent notes survive restart\n\nBudget\nNo answer', autoPaste: false, pasteDelayMs: 50 })
    expect(await within(await saved()).findByRole('status')).toHaveProperty('textContent', 'Copied')
  })

  it('keeps the answer on screen and says how to copy it by hand when the clipboard fails', async () => {
    Object.defineProperty(window, 'sotto', { configurable: true, value: { deliverOutput: vi.fn(async () => 'failed') } })
    view(fakeBridge([draft()]))
    await userEvent.setup().click(within(await saved()).getByRole('button', { name: 'Copy answer' }))
    expect(await within(await saved()).findByRole('alert')).toHaveProperty('textContent', 'Could not copy. Select the answer above to copy it.')
    expect(screen.getByText('Unsent notes survive restart')).toBeTruthy()
  })

  it('leaves an exactly matching live request to its card, but keeps an answer whose request ID now has a different question', async () => {
    const bridge = fakeBridge([draft()])
    const { update } = view(bridge, { live: [live()] })
    await waitFor(() => expect(bridge.list).toHaveBeenCalled())
    await act(async () => undefined)
    expect(screen.queryByRole('region')).toBeNull()
    update({ live: [live({ questions: [{ ...questions[0]!, question: 'Where should we go instead?' }] })] })
    expect(within(await saved()).getByText('Codex changed this question. This answer was not sent.')).toBeTruthy()
  })

  it('never claims the question is gone while disconnected or loading', async () => {
    const { update } = view(fakeBridge([draft()]), { observation: 'disconnected' })
    expect(within(await saved()).getByText('This answer was not sent. Reconnect Codex to see whether its question is still open.')).toBeTruthy()
    update({ observation: 'loading' })
    expect(within(await saved()).getByText('This answer was not sent. Checking whether Codex still shows its question…')).toBeTruthy()
    expect(screen.queryByText(/no longer shows/u)).toBeNull()
  })

  it('omits a form that holds no answer but keeps every held attempt', async () => {
    view(fakeBridge([draft({ selections: {} }), draft({ held: true, selections: {} }, { requestId: 'held-form' })]))
    const card = await screen.findByRole('region', { name: 'Unconfirmed answer' })
    expect(within(card).getByText('Codex no longer shows this question. The answer may have arrived, so Sotto won’t send it again.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Saved answer' })).toBeNull()
  })

  it('ignores a list that answers for an owner the view has left', async () => {
    const bridge = fakeBridge([draft()])
    let late: (drafts: RequestDraft[]) => void = () => undefined
    bridge.list.mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
    const { update } = view(bridge)
    update({ owner: { ...owner, ownerId: 'other' } })
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))
    await act(async () => late([draft()]))
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('reads again when the owner snapshot changes, so an answer main retired disappears', async () => {
    const bridge = fakeBridge([draft()])
    const { update } = view(bridge, { observed: 'a' })
    await saved()
    bridge.replace([])
    update({ observed: 'b' })
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
  })

  it('reads again when an edit made before its request closed finishes saving, without a new provider snapshot', async () => {
    const bridge = fakeBridge([])
    let finish: () => void = () => undefined
    const answers = new RequestAnswerStore(() => bridge as unknown as RequestDraftBridge)
    bridge.get.mockResolvedValue(null)
    bridge.save.mockImplementation((next: RequestDraft) => new Promise(resolve => { finish = () => { bridge.replace([next]); resolve(next) } }))
    const request = live()
    const element = (requests: AgentRequest[]) => <RequestDraftRecovery owner={owner} live={requests} observation="ready" observed="same"
      provider="Codex" bridge={bridge as unknown as RequestDraftBridge} answers={answers} />
    const rendered = render(element([request]))
    const key = requestAnswerOwnerKey(owner.ownerId, request, owner)
    await act(async () => answers.connect(key, request.id, { ...owner, requestId: request.id, questions }))
    act(() => answers.select(key, request.id, 'notes', { optionIds: [], other: false, text: 'Typed as it closed' }))
    // The provider closes the request while that save is still in flight; the list read now finds nothing.
    rendered.rerender(element([]))
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region')).toBeNull()
    await act(async () => finish())
    expect(within(await saved()).getByText('Typed as it closed')).toBeTruthy()
    expect(bridge.check).not.toHaveBeenCalled()
  })

  it('reads again when an answer acknowledged after its request closed lets main drop the held form', async () => {
    const bridge = fakeBridge([])
    const answers = new RequestAnswerStore(() => bridge as unknown as RequestDraftBridge)
    bridge.get.mockResolvedValue(null)
    bridge.save.mockImplementation(async (next: RequestDraft) => { bridge.replace([next]); return next })
    const request = live()
    const key = requestAnswerOwnerKey(owner.ownerId, request, owner)
    const element = (requests: AgentRequest[]) => <RequestDraftRecovery owner={owner} live={requests} observation="ready" observed="unchanged"
      provider="Codex" bridge={bridge as unknown as RequestDraftBridge} answers={answers} />
    const rendered = render(element([request]))
    await act(async () => answers.connect(key, request.id, { ...owner, requestId: request.id, questions }))
    act(() => answers.select(key, request.id, 'notes', { optionIds: [], other: false, text: 'Answered as it closed' }))
    let acknowledge: () => void = () => undefined
    let submitted: Promise<void> = Promise.resolve()
    act(() => { submitted = answers.submit(key, request.id, null, () => new Promise(resolve => { acknowledge = () => { bridge.replace([]); resolve({ error: null }) } })) })
    await waitFor(() => expect(bridge.save).toHaveBeenCalledWith(expect.objectContaining({ held: true })))
    // The native question closes before the answer command is acknowledged: main still holds the attempt.
    rendered.rerender(element([]))
    expect(await screen.findByRole('region', { name: 'Unconfirmed answer' })).toBeTruthy()
    // Main records the accepted receipt and drops the form. No provider snapshot changes; the acknowledgement re-lists.
    await act(async () => { acknowledge(); await submitted })
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
    expect(bridge.check).not.toHaveBeenCalled(); expect(bridge.discard).not.toHaveBeenCalled()
  })

  it('reports an unreadable store readably, keeps what was shown, and can try again', async () => {
    const bridge = fakeBridge([draft()])
    const { update } = view(bridge, { observed: 'a' })
    await saved()
    bridge.list.mockRejectedValueOnce(new Error("Error invoking remote method 'request-draft:list': Error: Answer draft storage could not be read. The original request-drafts.json is unchanged. Repair it and restart before saving answers."))
    update({ observed: 'b' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Answer draft storage could not be read.')
    expect(alert.textContent).not.toContain('invoking remote method')
    expect(screen.getByText('Unsent notes survive restart')).toBeTruthy()
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('discarding a saved answer', () => {
  it('asks first, explains a held attempt, and Escape keeps it with focus back on Discard', async () => {
    const bridge = fakeBridge([draft({ held: true })])
    view(bridge)
    const user = userEvent.setup()
    const card = await screen.findByRole('region', { name: 'Unconfirmed answer' })
    await user.click(within(card).getByRole('button', { name: 'Discard' }))
    expect(within(card).getByText('Discard Sotto’s copy? This doesn’t cancel or resend the answer.')).toBeTruthy()
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Keep' }))
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Discard' }))
    expect(bridge.discard).not.toHaveBeenCalled()
  })

  it('removes only the exact revision by keyboard and moves focus to the next saved answer', async () => {
    const second = draft({ revision: 2 }, { requestId: 'separate-form' })
    const bridge = fakeBridge([draft(), second])
    view(bridge)
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Saved answer' })).toHaveLength(2))
    const [first] = screen.getAllByRole('region', { name: 'Saved answer' })
    within(first!).getByRole('button', { name: 'Discard' }).focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Tab}{Enter}')
    expect(bridge.discard).toHaveBeenCalledWith({ target: draft().target, revision: 4 })
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Saved answer' })).toHaveLength(1))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Copy answer'))
    expect(document.activeElement?.closest('section')?.textContent).toContain('Unsent notes survive restart')
  })

  it('keeps the answer and shows the reason when a newer revision refuses the discard', async () => {
    const bridge = fakeBridge([draft()])
    view(bridge)
    const user = userEvent.setup()
    const card = await saved()
    bridge.replace([draft({ revision: 5, selections: { notes: { optionIds: [], other: false, text: 'Newer notes' } } })])
    await user.click(within(card).getByRole('button', { name: 'Discard' }))
    await user.click(within(card).getByRole('button', { name: 'Discard answer' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'A newer answer draft may be saved. Reload retained answers before discarding.')
    expect(await screen.findByText('Newer notes')).toBeTruthy()
    expect(bridge.discard).toHaveBeenCalledTimes(1)
  })
})

it('formats a text-only and multi-select answer for the clipboard', () => {
  expect(savedAnswerClipboard(draft({ selections: { checks: { optionIds: ['types'], other: false, text: '' } } })))
    .toBe('Where should we go?\nNo answer\n\nWhich checks?\nType checks\n\nTravel notes\nNo answer\n\nBudget\nNo answer')
})

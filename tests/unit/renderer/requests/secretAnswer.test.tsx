// A secret answer (#2153, Zach's pick on November 4, 2026): a question its agent marks secret is answered in a masked
// field, its words go to the agent and nowhere else in Sotto, and a saved form shows them only as Hidden answer.
// Fake values only.
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import type { RequestDraft, RequestDraftBridge, RequestDraftOwner } from '../../../../src/shared/requestDrafts'
import { AgentRequestCard } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import { RequestAnswerStore, type RequestAnswer, type SubmitOutcome } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { RequestDraftRecovery, savedAnswerClipboard } from '../../../../src/renderer/src/agents/requests/RequestDraftRecovery'

afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'sotto') })

const FAKE = 'fake-secret-123'
const NOTE = 'Codex will see this and keep it in its own session file. Sotto does not save it.'
type Question = NonNullable<AgentRequest['questions']>[number]
const secretText: Question = { id: 'q', header: 'Test', question: 'Enter a fake test secret', options: [], multiSelect: false, allowFreeText: true, prose: true, secret: true }
const secretOther: Question = { id: 'q', header: 'Token', question: 'Paste the fake token', options: [{ id: 'Skip for now', label: 'Skip for now' }], multiSelect: false,
  allowFreeText: true, prose: true, secret: true }
const plain: Question = { id: 'name', question: 'What should it be called?', options: [], multiSelect: false, allowFreeText: true, prose: true }
const request = (questions: Question[]): AgentRequest => ({ id: 'rpc:1', kind: 'question', text: questions.map(question => question.question).join('\n'), options: [], questions, skippable: true })
const owner: RequestDraftOwner = { kind: 'thread', ownerId: 'thread-a', providerId: 'codex' }

function bridge(saved: RequestDraft[] = []) {
  return { list: vi.fn(async () => saved), discard: vi.fn(async () => false), check: vi.fn(async () => ({ status: 'editable' as const, draft: null })),
    get: vi.fn(async () => null), status: vi.fn(async () => ({ status: 'missing' as const })), save: vi.fn(async (draft: RequestDraft) => draft),
    onChanged: vi.fn(() => () => undefined) }
}

function card(asked: AgentRequest, options: { drafts?: ReturnType<typeof bridge> } = {}) {
  const store = new RequestAnswerStore(() => options.drafts as unknown as RequestDraftBridge | undefined)
  const onSubmit = vi.fn<(answer: RequestAnswer) => Promise<SubmitOutcome>>(async () => ({ error: null }))
  const element = <AgentRequestCard ownerId="thread-a" ownerTitle="Workshop" providerId="codex" request={asked} blocked={null} store={store}
    onSubmit={onSubmit} {...(options.drafts ? { draftOwner: owner } : {})} />
  return { store, onSubmit, element, view: render(element) }
}

describe('a question its agent marks secret', () => {
  it('is answered in a masked field with autocomplete and spelling off, in place of the text box', () => {
    card(request([secretText]))
    expect(document.querySelector('textarea')).toBeNull()
    const field = screen.getByLabelText('Test')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAttribute('spellcheck', 'false')
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    expect(field).toHaveAccessibleDescription(NOTE)
  })

  it('masks Write my own answer too, beside the agent’s choices', () => {
    card(request([secretOther]))
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.getByLabelText('Other answer to: Paste the fake token')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('radio', { name: 'Skip for now' })).toBeInTheDocument()
  })

  it('never says the typed words in the field’s accessible name', async () => {
    card(request([secretText]))
    const field = screen.getByLabelText('Test')
    await userEvent.setup().type(field, FAKE)
    expect(field).toHaveValue(FAKE)
    expect(field).toHaveAccessibleName('Test')
    expect(document.body.textContent).not.toContain(FAKE)
  })

  it('sends its words to the agent, and never to the request-draft bridge, while the other answers are saved', async () => {
    const drafts = bridge()
    const { onSubmit } = card(request([plain, secretText]), { drafts })
    await waitFor(() => expect(drafts.status).toHaveBeenCalled())
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('What should it be called?'), 'Kestrel')
    await user.type(screen.getByLabelText('Test'), FAKE)
    await waitFor(() => expect(JSON.stringify(drafts.save.mock.calls.at(-1))).toContain('Kestrel'))
    expect(JSON.stringify(drafts.save.mock.calls)).not.toContain(FAKE)
    await user.click(screen.getByRole('button', { name: 'Send answers' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ questionAnswers: { name: { optionIds: [], text: 'Kestrel' }, q: { optionIds: [], text: FAKE } } })))
    expect(JSON.stringify(drafts.save.mock.calls)).not.toContain(FAKE)
  })

  it('forgets the typed words when the last card showing them closes', async () => {
    const asked = request([secretText])
    const first = card(asked)
    const second = render(first.element)
    const user = userEvent.setup()
    await user.type(screen.getAllByLabelText('Test')[0]!, FAKE)
    second.unmount()
    expect(JSON.stringify(first.store.get('thread-a', asked.id))).toContain(FAKE)
    first.view.unmount()
    expect(JSON.stringify(first.store.get('thread-a', asked.id))).not.toContain(FAKE)
    render(first.element)
    expect(screen.getByLabelText('Test')).toHaveValue('')
  })
})

describe('a saved form with a secret question', () => {
  const saved = (selections: RequestDraft['selections'], held = false): RequestDraft => ({ target: { ...owner, requestId: 'gone', questions: [plain, secretText] },
    revision: 2, held, selections })

  it('shows Hidden answer for the secret question, and Copy answer leaves it out', async () => {
    const draft = saved({ name: { optionIds: [], other: false, text: 'Kestrel' }, q: { optionIds: [], other: false, text: FAKE } })
    render(<RequestDraftRecovery owner={owner} live={[]} observation="ready" observed="" provider="Codex" bridge={bridge([draft]) as unknown as RequestDraftBridge} />)
    const region = await screen.findByRole('region', { name: 'Saved answer' })
    expect(region).toHaveTextContent('Hidden answer')
    expect(region).toHaveTextContent('Kestrel')
    expect(document.body.textContent).not.toContain(FAKE)
    expect(savedAnswerClipboard(draft)).toBe('What should it be called?\nKestrel')
  })

  it('is not offered back when the secret question was all it held', async () => {
    const draft = saved({ q: { optionIds: [], other: false, text: '' } })
    const drafts = bridge([draft])
    render(<RequestDraftRecovery owner={owner} live={[]} observation="ready" observed="" provider="Codex" bridge={drafts as unknown as RequestDraftBridge} />)
    await waitFor(() => expect(drafts.list).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByRole('region', { name: 'Saved answer' })).toBeNull()
  })
})

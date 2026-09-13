import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import { AgentRequestCard } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import {
  answerProgress, buildQuestionAnswers, EMPTY_SELECTION, isAnswered, isRequired, permissionAnswer, permissionSummary, pickOption, pickOther,
  RequestAnswerStore, type RequestAnswer, type StructuredQuestion, type SubmitOutcome,
} from '../../../../src/renderer/src/agents/requests/requestAnswers'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const single: StructuredQuestion = { id: 'q-db', header: 'Database', question: 'Which database?', multiSelect: false, allowFreeText: true,
  options: [{ id: 'pg', label: 'Postgres', description: 'Relational' }, { id: 'lite', label: 'SQLite' }] }
const multi: StructuredQuestion = { id: 'q-feat', question: 'Which features?', multiSelect: true, allowFreeText: false,
  options: [{ id: 'auth', label: 'Auth' }, { id: 'search', label: 'Search' }, { id: 'billing', label: 'Billing' }] }
const textual: StructuredQuestion = { id: 'q-name', question: 'Name the service', multiSelect: false, allowFreeText: true, options: [] }

function structured(questions: StructuredQuestion[] = [single, multi, textual]): AgentRequest {
  return { id: 'req-1', kind: 'question', text: 'Setup questions', options: [], questions }
}

function setup(request: AgentRequest, options: { outcome?: SubmitOutcome | 'throw'; blocked?: string | null; check?: boolean } = {}) {
  const store = new RequestAnswerStore()
  const onSubmit = vi.fn(async () => {
    if (options.outcome === 'throw') throw new Error('bridge gone')
    return options.outcome === undefined ? { error: null } : options.outcome
  })
  const onCheck = vi.fn(async () => true)
  const view = render(<AgentRequestCard ownerId="thread-a" ownerTitle="Workshop" request={request} blocked={options.blocked ?? null}
    onSubmit={onSubmit} {...(options.check === false ? {} : { onCheck })} store={store} />)
  return { store, onSubmit, onCheck, view, user: userEvent.setup() }
}

describe('request answers', () => {
  it('keeps multiselect choices in native order and single choices exclusive with Other', () => {
    let selection = pickOption(multi, EMPTY_SELECTION, 'billing', true)
    selection = pickOption(multi, selection, 'auth', true)
    expect(selection.optionIds).toEqual(['auth', 'billing'])
    expect(pickOption(multi, selection, 'nope', true)).toBe(selection)
    let one = pickOption(single, EMPTY_SELECTION, 'pg', true)
    one = pickOther(single, one, true)
    expect(one).toMatchObject({ optionIds: [], other: true })
    expect(isAnswered(single, one)).toBe(false)
    expect(isAnswered(single, { ...one, text: 'Mongo' })).toBe(true)
    expect(pickOther(multi, EMPTY_SELECTION, true)).toBe(EMPTY_SELECTION)
  })

  it('builds answers keyed by question ID only once every question is answered', () => {
    const selections = { 'q-db': { optionIds: ['pg'], other: false, text: 'ignored' }, 'q-feat': { optionIds: ['search'], other: false, text: '' } }
    expect(buildQuestionAnswers([single, multi, textual], selections)).toBeNull()
    expect(buildQuestionAnswers([single, multi, textual], { ...selections, 'q-name': { optionIds: [], other: false, text: '  billing-api ' } })).toEqual({
      'q-db': { optionIds: ['pg'] }, 'q-feat': { optionIds: ['search'] }, 'q-name': { optionIds: [], text: 'billing-api' },
    })
  })

  it('maps a native permission choice to its exact ID and approval', () => {
    expect(permissionAnswer({ id: 'always-1', label: 'Always allow', kind: 'allow-always' })).toEqual({ answer: 'Always allow', approved: true, permissionChoice: 'always-1' })
    expect(permissionAnswer({ id: 'x', label: 'Cancel', kind: 'cancel' })).toMatchObject({ approved: false, permissionChoice: 'x' })
    expect(permissionSummary({ id: 'p', kind: 'permission', text: 'Run a command\nnpm test', options: [], context: { toolName: 'Bash', cwd: 'D:\\repo' } }))
      .toEqual({ title: 'Run a command', command: 'npm test', cwd: 'D:\\repo' })
  })
})

describe('AgentRequestCard', () => {
  it('renders every question with its real choices and sends one structured answer by keyboard', async () => {
    const { user, onSubmit } = setup(structured())
    expect(screen.getByRole('group', { name: /Which database\?/u })).toBeTruthy()
    expect(screen.getAllByRole('radio').map(input => (input as HTMLInputElement).value)).toEqual(['pg', 'lite', ''])
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    const send = screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    await user.click(screen.getByRole('radio', { name: 'Other' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Other answer to: Which database?' })))
    await user.keyboard('DuckDB')
    await user.click(screen.getByRole('checkbox', { name: 'Search' }))
    await user.click(screen.getByRole('checkbox', { name: 'Auth' }))
    await user.type(screen.getByRole('textbox', { name: 'Name the service' }), 'ledger')
    expect(send.disabled).toBe(false)
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ answer: '', questionAnswers: {
      'q-db': { optionIds: [], text: 'DuckDB' }, 'q-feat': { optionIds: ['auth', 'search'] }, 'q-name': { optionIds: [], text: 'ledger' },
    } })
    await screen.findByText('Answer sent.')
    expect(screen.getByRole('radio', { name: /SQLite/u }).matches(':disabled')).toBe(true)
  })

  it('keeps selections for the exact request across a remount, and not for another request', async () => {
    const { user, store, view } = setup(structured([single]))
    await user.click(screen.getByRole('radio', { name: /Postgres/u }))
    view.unmount()
    const again = render(<AgentRequestCard ownerId="thread-a" ownerTitle="Workshop" request={structured([single])} blocked={null} onSubmit={async () => ({ error: null })} store={store} />)
    expect((screen.getByRole('radio', { name: /Postgres/u }) as HTMLInputElement).checked).toBe(true)
    again.unmount()
    render(<AgentRequestCard ownerId="thread-b" ownerTitle="Other" request={structured([single])} blocked={null} onSubmit={async () => ({ error: null })} store={store} />)
    expect((screen.getByRole('radio', { name: /Postgres/u }) as HTMLInputElement).checked).toBe(false)
  })

  it('shows only the permission choices the provider offered, with context', async () => {
    const request: AgentRequest = { id: 'perm-1', kind: 'permission', text: 'Allow Bash?', options: [],
      context: { toolName: 'Bash', command: 'rm -rf dist', cwd: 'D:\\repo', details: 'Deletes build output' },
      permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'always', label: 'Always allow', kind: 'allow-always', description: 'For rm in this project' }, { id: 'no', label: 'Reject', kind: 'deny' }] }
    const { user, onSubmit } = setup(request)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Allow once', 'Always allow', 'Reject'])
    expect(screen.queryByRole('button', { name: /session/u })).toBeNull()
    expect(screen.getByText('rm -rf dist')).toBeTruthy()
    expect(screen.getByText('For rm in this project')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onSubmit).toHaveBeenCalledWith({ answer: 'Reject', approved: false, permissionChoice: 'no' })
  })

  it('keeps a refused answer answerable and holds an unconfirmed one until checked', async () => {
    const refused = setup({ id: 'perm-2', kind: 'permission', text: 'Allow?', options: [] }, { outcome: { error: 'The request is no longer pending.' } })
    await refused.user.click(screen.getByRole('button', { name: 'Allow' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The request is no longer pending.')
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(false)
    cleanup()

    const lost = setup({ id: 'perm-3', kind: 'permission', text: 'Allow?', options: [] }, { outcome: 'throw' })
    await lost.user.click(screen.getByRole('button', { name: 'Deny' }))
    await screen.findByText(/won’t be sent again until you check/u)
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true)
    await lost.user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(lost.onCheck).toHaveBeenCalledTimes(1)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false))
    expect(lost.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('never re-enables a request main marks as uncertain', async () => {
    const { onCheck, user } = setup({ id: 'perm-4', kind: 'permission', text: 'Allow?', options: [], delivery: 'uncertain' })
    expect(screen.getByText(/Sotto won’t send it again/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(onCheck).toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('states why choices are unavailable and leaves plain questions to the composer', () => {
    setup({ id: 'perm-5', kind: 'permission', text: 'Allow?', options: [] }, { blocked: 'Reconnect Claude to answer.' })
    expect(screen.getByText('Reconnect Claude to answer.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const onWriteAnswer = vi.fn()
    render(<AgentRequestCard ownerId="t" ownerTitle="T" request={{ id: 'q', kind: 'question', text: 'Which port?', options: [] }} blocked={null}
      onSubmit={async () => ({ error: null })} onWriteAnswer={onWriteAnswer} store={new RequestAnswerStore()} />)
    screen.getByRole('button', { name: 'Write an answer' }).click()
    expect(onWriteAnswer).toHaveBeenCalled()
  })
})

const optionalMode: StructuredQuestion = { id: 'mode', header: 'Mode', question: 'How thorough?', multiSelect: false, allowFreeText: false, required: false,
  options: [{ id: 'quick', label: 'Quick check' }, { id: 'full', label: 'Full check' }] }
const optionalNote: StructuredQuestion = { id: 'note', question: 'Anything else?', multiSelect: false, allowFreeText: true, options: [], required: false }
const requiredName: StructuredQuestion = { id: 'name', question: 'Project name', multiSelect: false, allowFreeText: true, options: [], required: true }
const nativeOnly = 'This field needs the native Codex client; Sotto cannot submit this field type or its validation rules.'
const optionalCount: StructuredQuestion = { id: 'count', question: 'How many workers?', multiSelect: false, allowFreeText: false, options: [], required: false, unavailableReason: nativeOnly }
const requiredCode: StructuredQuestion = { id: 'code', header: 'Code', question: 'Uppercase code', multiSelect: false, allowFreeText: false, options: [], unavailableReason: nativeOnly }

describe('optional and unavailable native fields', () => {
  it('omits unanswered optional fields, keeps exact option IDs, and treats absent required as required', () => {
    const name = { optionIds: [], other: false, text: 'Sotto' }
    expect(buildQuestionAnswers([requiredName, optionalMode, optionalNote], { name })).toEqual({ name: { optionIds: [], text: 'Sotto' } })
    expect(buildQuestionAnswers([requiredName, optionalMode], { name, mode: { optionIds: ['full'], other: false, text: '' } }))
      .toEqual({ name: { optionIds: [], text: 'Sotto' }, mode: { optionIds: ['full'] } })
    // Whitespace alone is not an answer to an optional text field.
    expect(buildQuestionAnswers([optionalNote], { note: { optionIds: [], other: false, text: '   ' } })).toEqual({})
    const absent: StructuredQuestion = { id: 'name', question: 'Project name', multiSelect: false, allowFreeText: true, options: [] }
    expect(buildQuestionAnswers([absent], {})).toBeNull()
    expect(isRequired(absent)).toBe(true)
    expect(isRequired(optionalMode)).toBe(false)
  })

  it('blocks a started-but-empty Other on an optional question until it is finished or cleared', () => {
    const optionalOther: StructuredQuestion = { ...single, required: false }
    const started = pickOther(optionalOther, EMPTY_SELECTION, true)
    expect(answerProgress(optionalOther, started)).toBe('partial')
    expect(buildQuestionAnswers([optionalOther], { [optionalOther.id]: started })).toBeNull()
    expect(buildQuestionAnswers([optionalOther], { [optionalOther.id]: EMPTY_SELECTION })).toEqual({})
  })

  it('never serializes an unavailable field and never lets a required one be sent', () => {
    expect(pickOption({ ...optionalCount, options: [{ id: 'x', label: 'X' }] }, EMPTY_SELECTION, 'x', true)).toBe(EMPTY_SELECTION)
    const typed = { optionIds: [], other: false, text: '3' }
    expect(buildQuestionAnswers([requiredName, optionalCount], { name: { ...typed, text: 'Sotto' }, count: typed })).toEqual({ name: { optionIds: [], text: 'Sotto' } })
    expect(buildQuestionAnswers([requiredCode], { code: { ...typed, text: 'ABC' } })).toBeNull()
  })

  it('labels optional fields, sends without them, and clears an optional single choice by keyboard', async () => {
    const { user, onSubmit } = setup(structured([requiredName, optionalMode, optionalNote]))
    expect(screen.getByRole('group', { name: /How thorough\?.*Optional/u })).toBeTruthy()
    expect(screen.getByRole('group', { name: /Anything else\?.*Optional/u })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Project name' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Clear/u })).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Full check' }))
    const clear = screen.getByRole('button', { name: 'Clear choice for How thorough?' })
    clear.focus()
    await user.keyboard('{Enter}')
    expect(screen.getAllByRole('radio').some(radio => (radio as HTMLInputElement).checked)).toBe(false)
    expect(screen.queryByRole('button', { name: /Clear choice/u })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Quick check' })))

    const send = screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Sotto')
    expect(send.disabled).toBe(false)
    await user.click(send)
    expect(onSubmit).toHaveBeenCalledWith({ answer: '', questionAnswers: { name: { optionIds: [], text: 'Sotto' } } })
  })

  it('explains unavailable fields in place of an input and holds a required one for the native client', async () => {
    const { user, onSubmit, view } = setup(structured([requiredName, optionalCount]))
    const count = screen.getByRole('group', { name: /How many workers\?.*Optional/u })
    expect(count.textContent).toContain(nativeOnly)
    expect(count.querySelectorAll('input, textarea')).toHaveLength(0)
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Sotto')
    await user.click(screen.getByRole('button', { name: 'Send answers' }))
    expect(onSubmit).toHaveBeenCalledWith({ answer: '', questionAnswers: { name: { optionIds: [], text: 'Sotto' } } })
    view.unmount()

    const blocked = setup({ ...structured([requiredCode, optionalNote]), id: 'req-code' })
    const code = screen.getByRole('group', { name: /Uppercase code/u })
    expect(code.textContent).toContain(nativeOnly)
    expect(code.querySelectorAll('input, textarea')).toHaveLength(0)
    expect(screen.queryByText('This question has no choices Sotto can show.')).toBeNull()
    expect(screen.getByText('Finish this form in the provider’s app.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement).disabled).toBe(true)
    await blocked.user.type(screen.getByRole('textbox', { name: /Anything else\?/u }), 'hi{Enter}')
    expect(blocked.onSubmit).not.toHaveBeenCalled()
  })
})

describe('native permission choices', () => {
  const base: AgentRequest = { id: 'perm-empty', kind: 'permission', text: 'Grant network access', options: [],
    context: { toolName: 'item/permissions/requestApproval', details: '{"permissions":{"network":true}}' } }

  it('offers no invented Allow when the provider supplied an explicit empty list, and says where to answer', () => {
    setup({ ...base, permissionChoices: [] })
    expect(screen.queryByRole('button', { name: /Allow|Deny/u })).toBeNull()
    expect(screen.getByText('Sotto has no choice it can send for this request. Answer it in the provider’s app.')).toBeTruthy()
    expect(screen.getByText('{"permissions":{"network":true}}')).toBeTruthy()
  })

  it('does not show the voice hint for a request with no sendable choice', () => {
    render(<AgentRequestCard ownerId="t" ownerTitle="T" request={{ ...base, permissionChoices: [] }} blocked={null} hint="Say “allow” or “deny”, or choose here."
      onSubmit={async () => ({ error: null })} store={new RequestAnswerStore()} />)
    expect(screen.queryByText(/Say “allow”/u)).toBeNull()
  })

  it('keeps legacy Allow and Deny only when choices are absent', () => {
    setup(base)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Deny', 'Allow'])
  })

  it('sends exact session scopes and offers always only when the provider does', async () => {
    const { user, onSubmit } = setup({ ...base, id: 'perm-scopes', permissionChoices: [
      { id: 'allow-turn', label: 'Allow requested permissions for this turn', kind: 'allow-once' },
      { id: 'allow-session', label: 'Allow requested permissions for this session', kind: 'allow-session' },
      { id: 'decline', label: 'Deny', kind: 'deny' },
    ] })
    expect(screen.queryByRole('button', { name: /always/iu })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow requested permissions for this session' }))
    expect(onSubmit).toHaveBeenCalledWith({ answer: 'Allow requested permissions for this session', approved: true, permissionChoice: 'allow-session' })
  })
})

describe('simultaneous requests', () => {
  const docsQuestion: AgentRequest = { id: 'req-docs', kind: 'question', text: 'Docs', options: [], questions: [multi] }
  const workshopQuestion: AgentRequest = { id: 'req-work', kind: 'question', text: 'Workshop', options: [], questions: [single] }

  function card(store: RequestAnswerStore, owner: string, request: AgentRequest, onSubmit: (answer: RequestAnswer) => Promise<SubmitOutcome>) {
    return <AgentRequestCard ownerId={owner} ownerTitle={owner} request={request} blocked={null} onSubmit={onSubmit} store={store} />
  }

  it('keeps each thread’s selections while a pane switches, and a refusal keeps the original request and choice', async () => {
    const store = new RequestAnswerStore()
    const user = userEvent.setup()
    const refuse = vi.fn(async () => ({ error: 'Provider refused the answer.' }))
    const accept = vi.fn(async () => ({ error: null }))
    const view = render(card(store, 'workshop', workshopQuestion, refuse))
    await user.click(screen.getByRole('radio', { name: /SQLite/u }))
    view.rerender(card(store, 'docs', docsQuestion, accept))
    await user.click(screen.getByRole('checkbox', { name: 'Billing' }))
    view.rerender(card(store, 'workshop', workshopQuestion, refuse))
    expect((screen.getByRole('radio', { name: /SQLite/u }) as HTMLInputElement).checked).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Send answer' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Provider refused the answer.')
    expect(refuse).toHaveBeenCalledWith({ answer: '', questionAnswers: { 'q-db': { optionIds: ['lite'] } } })
    expect((screen.getByRole('radio', { name: /SQLite/u }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false)

    view.rerender(card(store, 'docs', docsQuestion, accept))
    expect((screen.getByRole('checkbox', { name: 'Billing' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(accept).not.toHaveBeenCalled()
  })

  it('sends one answer while delivery is pending or unknown, ignores edits, and keys owners apart', async () => {
    const store = new RequestAnswerStore()
    let release!: (outcome: SubmitOutcome) => void
    const send = vi.fn(() => new Promise<SubmitOutcome>(resolve => { release = resolve }))
    const first = store.submit('thread-a', 'req', 'allow', send)
    await store.submit('thread-a', 'req', 'allow', send)
    store.select('thread-a', 'req', 'q', { optionIds: ['x'], other: false, text: '' })
    expect(store.get('thread-a', 'req')).toMatchObject({ phase: 'sending', selections: {} })
    expect(store.get('thread-ab', 'req').phase).toBe('idle')
    release(null)
    await first
    expect(store.get('thread-a', 'req').phase).toBe('unconfirmed')
    await store.submit('thread-a', 'req', 'allow', send)
    expect(send).toHaveBeenCalledTimes(1)

    store.select('thread-ab', 'req', 'q', { optionIds: ['y'], other: false, text: '' })
    store.prune('thread-a', [])
    expect(store.get('thread-a', 'req').phase).toBe('idle')
    expect(store.get('thread-ab', 'req').selections.q?.optionIds).toEqual(['y'])
    expect(RequestAnswerStore.key('thread-a', 'req')).toBe(['thread-a', 'req'].join(String.fromCharCode(0)))
  })
})

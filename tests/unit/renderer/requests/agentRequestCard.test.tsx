import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import { AgentRequestCard } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import {
  buildQuestionAnswers, EMPTY_SELECTION, isAnswered, permissionAnswer, permissionSummary, pickOption, pickOther,
  RequestAnswerStore, type StructuredQuestion, type SubmitOutcome,
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

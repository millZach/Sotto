// A secret request (ADR-0219): the agent asks for values it never sees. The card takes them from the keyboard, sends
// them once on its own channel and keeps them nowhere else; it can always be declined. Fake values only.
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import type { SecretRequestAnswer, SecretRequestAnswerResult, SecretRequestCard as Card } from '../../../../src/shared/secretRequests'
import { AgentRequestCard } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import { RequestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'

const gate = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'secret-requests' && gate.on,
}))

afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'sotto'); gate.on = true })

const FAKE = 'fake-canary-key-4411'
function secretRequest(card: Partial<Card> = {}): AgentRequest {
  return { id: 'sotto:secret:1', kind: 'permission', text: 'Stripe test key: To run checkout tests.\nThe agent asks for a value it will not see.', options: [],
    permissionChoices: [{ id: 'decline', label: 'Decline', kind: 'deny' }], context: { toolName: 'Sotto', action: 'Stripe test key' },
    secretRequest: { label: 'Stripe test key', reason: 'To run checkout tests.', fields: [{ name: 'value', label: 'Stripe test key', placeholder: 'sk_test_…', secret: true }],
      delivery: 'secretRef', expiresAt: Date.now() + 600_000, ...card } }
}
function bridge(result: SecretRequestAnswerResult = { ok: true }) {
  const answer = vi.fn<(request: SecretRequestAnswer) => Promise<SecretRequestAnswerResult>>(async () => result)
  const openExternalLink = vi.fn(async () => undefined)
  Object.defineProperty(window, 'sotto', { configurable: true, value: { secretRequests: { answer }, openExternalLink } })
  return { answer, openExternalLink }
}
function card(request = secretRequest(), blocked: string | null = null) {
  const onSubmit = vi.fn(async () => ({ error: null }))
  render(<AgentRequestCard ownerId="host:h:thread-a" ownerTitle="Workshop" request={request} blocked={blocked} onSubmit={onSubmit} store={new RequestAnswerStore()} />)
  return { onSubmit, user: userEvent.setup() }
}

describe('a secret request card', () => {
  it('takes the value from the keyboard and sends it once, on its own channel, never as the request\'s answer', async () => {
    const { answer } = bridge()
    const { onSubmit, user } = card()
    const field = screen.getByLabelText('Value')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByText('Private')).toBeInTheDocument()
    await user.click(field)
    await user.keyboard(`${FAKE}{Enter}`)
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1))
    expect(answer).toHaveBeenCalledWith({ answer: 'save', threadId: 'host:h:thread-a', requestId: 'sotto:secret:1', values: { value: FAKE } })
    expect(onSubmit).not.toHaveBeenCalled()
    // Once saved, the field is empty again: the card keeps nothing.
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('names each field of a card with several, shows the ones marked so, and asks for the missing one', async () => {
    const { answer } = bridge()
    const { user } = card(secretRequest({ fields: [{ name: 'user', label: 'User name', secret: false }, { name: 'password', label: 'Password', secret: true }] }))
    expect(screen.getByLabelText('User name')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    await user.type(screen.getByLabelText('User name'), 'rez')
    await user.click(screen.getByRole('button', { name: 'Save securely' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter Password, or decline the card.')
    expect(screen.getByLabelText('Password')).toHaveFocus()
    expect(answer).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Password'), FAKE)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(answer).toHaveBeenCalledWith(expect.objectContaining({ values: { user: 'rez', password: FAKE } })))
  })

  it('declines from the keyboard', async () => {
    const { answer } = bridge()
    const { user } = card()
    await user.tab()
    expect(screen.getByLabelText('Value')).toHaveFocus()
    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ answer: 'decline', threadId: 'host:h:thread-a', requestId: 'sotto:secret:1' }))
  })

  it('takes fields named like members every object has as plain fields, and sends each as its own value', async () => {
    const { answer } = bridge()
    const names = ['toString', 'constructor', '__proto__']
    const { user } = card(secretRequest({ fields: names.map(name => ({ name, label: `The ${name}`, secret: true })) }))
    for (const name of names) expect(screen.getByLabelText(`The ${name}`)).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Save securely' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter The toString, or decline the card.')
    expect(answer).not.toHaveBeenCalled()
    for (const name of names) await user.type(screen.getByLabelText(`The ${name}`), `${FAKE}-${name}`)
    await user.click(screen.getByRole('button', { name: 'Save securely' }))
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1))
    const sent = answer.mock.calls[0]![0] as Extract<SecretRequestAnswer, { answer: 'save' }>
    expect(Object.entries(sent.values)).toEqual(names.map(name => [name, `${FAKE}-${name}`]))
    expect(Object.getPrototypeOf(sent.values)).toBe(Object.prototype)
  })

  it('says truly where a value can go: the sign-in page\'s site, a page the user says yes to, or a file the agent\'s commands read', () => {
    bridge()
    card(secretRequest({ url: 'https://dashboard.stripe.com/test/apikeys' }))
    expect(screen.getByText(/types it only on dashboard\.stripe\.com\. The agent and its provider never see it\./u)).toBeInTheDocument()
    cleanup()
    // A site that is not https is named with its scheme, as Sotto binds the value to it.
    card(secretRequest({ url: 'http://127.0.0.1:5173/login' }))
    expect(screen.getByText(/types it only on http:\/\/127\.0\.0\.1:5173\./u)).toBeInTheDocument()
    cleanup()
    card()
    expect(screen.getByText(/asks you before typing it on any page\. The agent and its provider never see it\./u)).toBeInTheDocument()
    cleanup()
    // A file is read by the agent's own commands, so the card cannot say the agent never sees it.
    card(secretRequest({ delivery: 'file' }))
    const privacy = screen.getByText(/file only you can read/u)
    expect(privacy).not.toHaveTextContent('never see')
    expect(privacy).toHaveTextContent('anything those commands print reaches the agent and its provider')
    cleanup()
    card(secretRequest({ delivery: 'file', fields: [{ name: 'user', label: 'User name', secret: false }, { name: 'password', label: 'Password', secret: true }] }))
    expect(screen.getByText(/to a file only you can read/u)).not.toHaveTextContent('never see')
  })

  it('opens the sign-in page in the user\'s browser', async () => {
    const { openExternalLink } = bridge()
    const { user } = card(secretRequest({ url: 'https://dashboard.stripe.com/test/apikeys' }))
    await user.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://dashboard.stripe.com/test/apikeys')
  })

  it('shows main\'s refusal in words and keeps the value in the field to try again', async () => {
    bridge({ ok: false, message: 'This request is no longer waiting. The agent may have stopped; nothing was saved.' })
    const { user } = card()
    await user.type(screen.getByLabelText('Value'), `${FAKE}{Enter}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer waiting')
    expect(screen.getByLabelText('Value')).toHaveValue(FAKE)
  })

  it('cannot be used while the thread is blocked, and says why', () => {
    bridge()
    card(secretRequest(), 'Reconnecting to the host…')
    expect(screen.getByLabelText('Value')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled()
    expect(screen.getByText('Reconnecting to the host…')).toBeInTheDocument()
  })

  it('shows the request\'s words and Decline alone where the card has no channel or the Owl feature is off', async () => {
    const { onSubmit, user } = card()
    expect(screen.queryByLabelText('Value')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    cleanup()
    bridge()
    gate.on = false
    card()
    expect(screen.queryByLabelText('Value')).toBeNull()
  })

  it('shows the request\'s words and Decline alone in Watcher\'s room, though the main window has the card\'s channel', async () => {
    const { answer } = bridge()
    const onSubmit = vi.fn(async () => ({ error: null }))
    render(<AgentRequestCard ownerId="thread-a" ownerTitle="Workshop" request={secretRequest()} blocked={null} onSubmit={onSubmit} store={new RequestAnswerStore()} secretWordsOnly />)
    expect(screen.queryByLabelText('Value')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save securely' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(answer).not.toHaveBeenCalled()
  })
})

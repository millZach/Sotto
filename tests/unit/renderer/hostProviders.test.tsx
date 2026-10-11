import { deferred } from '../../fixtures/deferred'
import { hostStatus, hostsBridgeFixture } from '../../fixtures/renderer/hostBridges'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostProviders, connectedProvidersLabel, hostProviderTile } from '../../../src/renderer/src/features/settings/HostProviders'
import type { AgentProviderStatus, ProviderId } from '../../../src/shared/agents'
import type { HostsBridge, HostStatus } from '../../../src/shared/hosts'
import type { HostSignInRequest, ProviderSignInView } from '../../../src/shared/hostProviders'

afterEach(cleanup)
const HOST = '22222222-2222-4222-8222-222222222222'
const SIGN_IN = '33333333-3333-4333-8333-333333333333'
const forge: HostStatus = hostStatus({ id: HOST, hostId: HOST, name: 'forge', target: 'forge' })
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const status = (id: ProviderId, patch: Partial<AgentProviderStatus>): AgentProviderStatus => ({ id, name: id, version: '', connection: 'disconnected', capabilities, ...patch })
/** forge on September 28: Claude Code installed and signed out, Codex connected with ChatGPT, Grok Build signed out, Devin not installed. */
const FORGE = [
  status('claude', { connection: 'error', problem: 'signed-out', version: '2.1.281 (Claude Code)', error: 'Sign in to Claude Code…' }),
  status('codex', { connection: 'connected', account: 'ChatGPT', version: 'codex-cli 0.155.1' }),
  status('grok', { connection: 'error', problem: 'signed-out', version: '1.0.41', error: 'Sign in to Grok Build…' }),
  status('devin', { connection: 'error', problem: 'not-installed', error: 'Install Devin CLI…' }),
]
function bridge(signIn: (request: HostSignInRequest) => Promise<ProviderSignInView | null> = async () => null) {
  const providerAction = vi.fn<HostsBridge['providerAction']>(async () => ({}))
  const signInMock = vi.fn<HostsBridge['signIn']>(signIn)
  const value = hostsBridgeFixture({ commands: { providerAction, signIn: signInMock } }).bridge
  return { bridge: value, providerAction, signIn: signInMock }
}

it('says what each tile shows, from the status the host publishes', () => {
  expect(hostProviderTile(FORGE[1], 'forge')).toEqual({ kind: 'connected', state: 'Connected', detail: 'ChatGPT · 0.155.1' })
  expect(hostProviderTile(FORGE[0], 'forge')).toEqual({ kind: 'signed-out', state: 'Not signed in', detail: '2.1.281' })
  expect(hostProviderTile(FORGE[3], 'forge')).toEqual({ kind: 'not-installed', state: 'Not installed', detail: 'Not on forge yet.' })
  // Too old names the floor where the adapter's is a version (Grok Build's, Devin's), and says so without one (Claude Code's flags).
  expect(hostProviderTile(status('grok', { connection: 'error', problem: 'too-old', version: '0.9.12', requiredVersion: '1.0.5' }), 'forge').detail).toBe('0.9.12 on forge. Sotto needs 1.0.5 or later.')
  expect(hostProviderTile(status('claude', { connection: 'error', problem: 'too-old', version: '1.0.3 (Claude Code)' }), 'forge').detail).toBe('1.0.3 on forge. Sotto needs a newer version.')
  expect(hostProviderTile(status('codex', { connection: 'error', problem: 'cannot-start' }), 'forge').detail).toBe("Installed, but forge's host could not find or start it.")
  // An error the adapter could not name reads as not startable, never as a sign-in to offer.
  expect(hostProviderTile(status('codex', { connection: 'error', error: 'Codex did not start.' }), 'forge')).toMatchObject({ kind: 'cannot-start', state: "Can't be started" })
  // A provider the user disconnected is turned off: "switched off" is a saved host's word.
  expect(hostProviderTile(status('codex', { version: '0.155.1' }), 'forge')).toMatchObject({ kind: 'off', state: 'Turned off' })
  expect(connectedProvidersLabel(FORGE)).toBe('1 provider')
  expect(connectedProvidersLabel([])).toBe('0 providers')
})

it('opens the tiles under the host and acts on that host alone', async () => {
  const user = userEvent.setup()
  const { bridge: hosts, providerAction } = bridge()
  render(<div className="hosts-settings"><HostProviders host={forge} providers={FORGE} bridge={hosts} /></div>)
  const toggle = screen.getByRole('button', { name: 'Show providers on forge' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('list', { name: 'Providers on forge' })).toBeNull()
  await user.click(toggle)
  expect(screen.getByRole('button', { name: 'Hide providers on forge' })).toHaveAttribute('aria-expanded', 'true')
  const tiles = within(screen.getByRole('list', { name: 'Providers on forge' })).getAllByRole('listitem')
  expect(tiles.map(tile => within(tile).getByRole('heading').textContent)).toEqual(['Claude Code', 'Codex', 'Grok Build', 'Devin'])
  expect(screen.getByText('forge connects each provider that is signed in when its host starts. A provider you disconnect stays off.')).toBeInTheDocument()
  expect(within(tiles[1]!).getByText('ChatGPT · 0.155.1')).toBeInTheDocument()
  expect(within(tiles[0]!).getByRole('button', { name: 'Sign in to Claude Code on forge from this computer' })).toHaveTextContent('Sign in')

  await user.click(within(tiles[1]!).getByRole('button', { name: 'Disconnect Codex on forge' }))
  expect(providerAction).toHaveBeenCalledWith({ id: HOST, provider: 'codex', action: 'disconnect' })
  // Check again that finds nothing new says so in the tile.
  await user.click(within(tiles[3]!).getByRole('button', { name: 'Check forge for Devin again' }))
  expect(providerAction).toHaveBeenLastCalledWith({ id: HOST, provider: 'devin', action: 'refresh' })
  expect(await within(tiles[3]!).findByText('Checked again. Nothing changed on forge.')).toBeInTheDocument()

  // Hide providers closes them again.
  await user.click(screen.getByRole('button', { name: 'Hide providers on forge' }))
  expect(screen.queryByRole('list', { name: 'Providers on forge' })).toBeNull()
})

it('shows the command for Devin, which signs in from a terminal on the host', async () => {
  const user = userEvent.setup()
  const { bridge: hosts } = bridge()
  render(<div className="hosts-settings"><HostProviders host={forge} bridge={hosts}
    providers={[status('devin', { connection: 'error', problem: 'signed-out', version: '3000.10.31 / ACP 1' })]} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  const devin = screen.getAllByRole('listitem').at(-1)!
  expect(within(devin).getByText('devin auth login --force-manual-token-flow')).toBeInTheDocument()
  expect(within(devin).queryByRole('button', { name: /^Sign in/u })).toBeNull()
  expect(within(devin).getByRole('button', { name: 'Copy the Devin sign-in command' })).toBeInTheDocument()
})

it('signs Codex in with a device code: the code, Copy code, Open sign-in page, and Escape stops it on the host', async () => {
  const user = userEvent.setup()
  const waiting: ProviderSignInView = { id: SIGN_IN, provider: 'codex', shape: 'device-code', stage: 'waiting', code: 'WDJB-MJHT', page: 'auth.openai.com', expiresInMinutes: 15 }
  const { bridge: hosts, signIn } = bridge(async request => request.type === 'cancel' ? null : waiting)
  render(<div className="hosts-settings"><HostProviders host={forge} bridge={hosts}
    providers={[status('codex', { connection: 'error', problem: 'signed-out', version: '0.155.1' })]} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(screen.getByRole('button', { name: 'Sign in to Codex on forge from this computer' }))
  const dialog = screen.getByRole('dialog', { name: 'Sign in to Codex on forge' })
  expect(signIn).toHaveBeenCalledWith({ type: 'start', id: HOST, provider: 'codex' })
  // The code is read out one character at a time; the code as shown is hidden from a screen reader, which would say it as a word.
  expect(await within(dialog).findByText('WDJB-MJHT')).toHaveAttribute('aria-hidden', 'true')
  expect(within(dialog).getByText('Code W D J B dash M J H T')).toHaveClass('tt-visually-hidden')
  expect(within(dialog).getByText('Waiting for you on auth.openai.com. The code lasts 15 minutes.')).toBeInTheDocument()
  // Focus goes to the step's own control once the code is there.
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Open sign-in page' })).toHaveFocus())
  expect(within(dialog).getByRole('button', { name: 'Copy the code' })).toBeInTheDocument()
  await user.keyboard('{Enter}')
  expect(signIn).toHaveBeenCalledWith({ type: 'open', id: HOST, signInId: SIGN_IN })
  expect(await within(dialog).findByRole('button', { name: 'Open sign-in page again' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(signIn).toHaveBeenCalledWith({ type: 'cancel', id: HOST, signInId: SIGN_IN }))
})

it('signs Claude Code in with a pasted code, says so when the code is refused, and tries again', async () => {
  const user = userEvent.setup()
  const waiting: ProviderSignInView = { id: SIGN_IN, provider: 'claude', shape: 'paste-code', stage: 'waiting', page: 'claude.com' }
  let starts = 0
  const { bridge: hosts, signIn } = bridge(async request => {
    if (request.type === 'start') { starts++; return waiting }
    if (request.type === 'code') return { ...waiting, stage: 'refused' }
    return request.type === 'cancel' ? null : waiting
  })
  render(<div className="hosts-settings"><HostProviders host={forge} bridge={hosts}
    providers={[status('claude', { connection: 'error', problem: 'signed-out', version: '2.1.281' })]} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(screen.getByRole('button', { name: 'Sign in to Claude Code on forge from this computer' }))
  const dialog = screen.getByRole('dialog', { name: 'Sign in to Claude Code on forge' })
  await user.click(await within(dialog).findByRole('button', { name: 'Open sign-in page' }))
  const field = await within(dialog).findByRole('textbox', { name: 'Code from the page' })
  await waitFor(() => expect(field).toHaveFocus())
  expect(within(dialog).getByText('Opened claude.com in your browser.')).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'Finish sign-in' })).toBeDisabled()
  await user.type(field, 'abc#def')
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    fireEvent.keyDown(field, { key: 'Enter', ...composition })
    expect(signIn).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'code' }))
  }
  await user.keyboard('{Enter}')
  expect(signIn).toHaveBeenCalledWith({ type: 'code', id: HOST, signInId: SIGN_IN, code: 'abc#def' })
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Claude Code did not accept that code, so forge is still not signed in. Open the sign-in page again for a new code.')
  const again = within(dialog).getByRole('button', { name: 'Try again' })
  await waitFor(() => expect(again).toHaveFocus())
  await user.click(again)
  await waitFor(() => expect(starts).toBe(2))
  expect(await within(dialog).findByRole('button', { name: 'Open sign-in page' })).toBeInTheDocument()
})

it('says the provider is connected when the sign-in ends well, and Done closes the dialog', async () => {
  const user = userEvent.setup()
  const { bridge: hosts } = bridge(async request => request.type === 'cancel' ? null
    : { id: SIGN_IN, provider: 'grok', shape: 'device-code', stage: 'connected' })
  render(<div className="hosts-settings"><HostProviders host={forge} bridge={hosts}
    providers={[status('grok', { connection: 'error', problem: 'signed-out', version: '1.0.41' })]} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(screen.getByRole('button', { name: 'Sign in to Grok Build on forge from this computer' }))
  const dialog = screen.getByRole('dialog', { name: 'Sign in to Grok Build on forge' })
  expect(await within(dialog).findByText('Grok Build is signed in and connected on forge.')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('stops the sign-in on the host when the dialog closes before the host has answered the start', async () => {
  const user = userEvent.setup()
  let answer: (view: ProviderSignInView) => void = () => undefined
  const { bridge: hosts, signIn } = bridge(request => request.type === 'start'
    ? (() => { const pending = deferred<ProviderSignInView>(); answer = pending.resolve; return pending.promise })() : Promise.resolve(null))
  render(<div className="hosts-settings"><HostProviders host={forge} bridge={hosts}
    providers={[status('codex', { connection: 'error', problem: 'signed-out', version: '0.155.1' })]} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(screen.getByRole('button', { name: 'Sign in to Codex on forge from this computer' }))
  const dialog = screen.getByRole('dialog', { name: 'Sign in to Codex on forge' })
  expect(within(dialog).getByText('Starting Codex\'s sign-in on forge…')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  answer({ id: SIGN_IN, provider: 'codex', shape: 'device-code', stage: 'waiting', code: 'WDJB-MJHT', page: 'auth.openai.com' })
  await waitFor(() => expect(signIn).toHaveBeenCalledWith({ type: 'cancel', id: HOST, signInId: SIGN_IN }))
})

it('says the host stopped answering when it fails to answer twice in a row, and offers Try again', async () => {
  const user = userEvent.setup()
  const waiting: ProviderSignInView = { id: SIGN_IN, provider: 'grok', shape: 'device-code', stage: 'waiting', code: 'K7PX-2QRM', page: 'accounts.x.ai' }
  const { bridge: hosts } = bridge(async request => {
    if (request.type === 'read') throw new Error('forge is not connected.')
    return request.type === 'cancel' ? null : waiting
  })
  render(<div className="hosts-settings"><HostProviders host={forge} bridge={hosts}
    providers={[status('grok', { connection: 'error', problem: 'signed-out', version: '1.0.41' })]} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(screen.getByRole('button', { name: 'Sign in to Grok Build on forge from this computer' }))
  const dialog = screen.getByRole('dialog', { name: 'Sign in to Grok Build on forge' })
  expect(await within(dialog).findByRole('alert', {}, { timeout: 10_000 }))
    .toHaveTextContent('forge stopped answering while Grok Build was signing in. If its tile still says Not signed in, try again.')
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Try again' })).toHaveFocus())
})

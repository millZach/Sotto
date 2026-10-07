import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { hostPhonesFailure, hostPhonesLabel } from '../../../src/renderer/src/features/settings/HostPhonesDialog'
import { TAILSCALE_OPERATOR_COMMAND } from '../../../src/renderer/src/features/settings/hostTailnetWords'
import type { HostPhonesView, HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { PhonesState } from '../../../src/shared/phones'

afterEach(cleanup)

const REMOTE = '22222222-2222-4222-8222-222222222222'
const PHONE = { clientId: 'phone-1', name: 'Zach’s iPhone', pairedAt: '2026-10-03T09:00:00.000Z', connected: true, canAnswer: false }
function phones(patch: Partial<PhonesState> = {}): PhonesState {
  return { enabled: true, localHostRunning: true, phase: 'on', tailscale: { status: 'ok', hostName: 'forge', dnsName: 'forge.tail5728ca.ts.net' }, serve: { status: 'ok' },
    address: 'https://forge.tail5728ca.ts.net:8443', computerName: 'forge', defaultName: 'forge', code: null, phones: [PHONE], answersAvailable: true, ...patch }
}
function host(patch: Partial<HostStatus> = {}): HostStatus {
  return { id: REMOTE, hostId: REMOTE, name: 'forge', target: 'zach@forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true, ...patch }
}
/** A bridge whose state the test moves on, the way main's broadcasts do. */
function fixture(view: Omit<HostPhonesView, 'id'> | undefined, status: HostStatus = host()) {
  let state: HostsState = { localHostEnabled: true, localHostRunning: true, hosts: [status], ...(view ? { phones: [{ id: REMOTE, ...view }] } : {}) }
  const listeners = new Set<(value: HostsState) => void>()
  const command = vi.fn<HostsBridge['command']>(async () => state)
  const bridge = { get: async () => state, command, onChanged: (listener: (value: HostsState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    devices: vi.fn(async () => ({ tailscale: { state: 'missing' as const }, devices: [] })), tailscale: vi.fn(async () => ({ state: 'missing' as const })),
    connectTailscale: vi.fn(), openTailscaleDownload: vi.fn(), providerAction: vi.fn(async () => ({})), updateClients: vi.fn(async () => ({})), signIn: vi.fn(async () => null) } as unknown as HostsBridge
  const push = (next: Omit<HostPhonesView, 'id'>): void => { state = { ...state, phones: [{ id: REMOTE, ...next }] }; act(() => { for (const listener of listeners) listener(state) }) }
  const sent = (): HostsCommand[] => command.mock.calls.map(call => call[0])
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
  return { command, push, sent }
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Open phone access for forge' }))
  return screen.getByRole('dialog', { name: 'Phones on forge' })
}

it('says on the row whether phones reach the host, and opens its Phones dialog, read while it is open', async () => {
  const user = userEvent.setup()
  const { sent } = fixture({ state: phones() })
  expect(await screen.findByText(/Phones on, 1 paired/u)).toBeInTheDocument()
  const dialog = await open(user)
  expect(within(dialog).getByRole('switch', { name: 'Let phones reach forge' })).toHaveAttribute('aria-checked', 'true')
  expect(within(dialog).getByText('https://forge.tail5728ca.ts.net:8443')).toBeInTheDocument()
  expect(within(dialog).getByRole('region', { name: 'Phones paired with forge' })).toHaveTextContent('Zach’s iPhone')
  expect(sent()).toContainEqual({ type: 'watch-host-phones', id: REMOTE, watching: true })
  await user.click(within(dialog).getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(sent()).toContainEqual({ type: 'watch-host-phones', id: REMOTE, watching: false })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open phone access for forge' })).toHaveFocus())
})

it('sends the switch and each press on to the host', async () => {
  const user = userEvent.setup()
  const { sent } = fixture({ state: phones({ enabled: false, phase: 'off', tailscale: { status: 'waiting' }, serve: { status: 'waiting' }, address: null, phones: [] }) })
  const dialog = await open(user)
  await user.click(within(dialog).getByRole('switch', { name: 'Let phones reach forge' }))
  expect(sent()).toContainEqual({ type: 'host-phones', id: REMOTE, command: { type: 'set-enabled', enabled: true } })
})

it('shows the host’s failed step with what to do there, and the command a Linux host needs', async () => {
  const user = userEvent.setup()
  fixture({ state: phones({ phase: 'failed', serve: { status: 'failed', reason: 'denied' }, address: null, phones: [] }) })
  const dialog = await open(user)
  expect(within(dialog).getByText(/won’t let the account Sotto signs in with change Tailscale Serve/u)).toBeInTheDocument()
  expect(within(dialog).getByText(TAILSCALE_OPERATOR_COMMAND)).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'Copy the command to run on forge' })).toBeEnabled()
  expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeEnabled()
  expect(within(dialog).queryByRole('button', { name: 'Pair a phone' })).toBeNull()
})

it('withdraws a pairing code on Escape without closing the dialog, and announces a phone that redeemed it', async () => {
  const user = userEvent.setup()
  const { sent, push } = fixture({ state: phones({ phones: [], code: { code: 'R4TN8WKE', expiresAt: new Date(Date.now() + 290_000).toISOString() } }) })
  const dialog = await open(user)
  const code = within(dialog).getByRole('group', { name: 'Pairing code from forge' })
  await waitFor(() => expect(code).toHaveFocus())
  expect(code).toHaveTextContent('Pairing code R 4 T N 8 W K E')
  await user.keyboard('{Escape}')
  expect(sent()).toContainEqual({ type: 'host-phones', id: REMOTE, command: { type: 'cancel-code' } })
  expect(screen.getByRole('dialog', { name: 'Phones on forge' })).toBeInTheDocument()
  push({ state: phones() })
  expect(await within(dialog).findByText('Zach’s iPhone is paired with forge.')).toBeInTheDocument()
})

it('asks before removing a phone, in place, and keeps it on Keep phone', async () => {
  const user = userEvent.setup()
  const { sent } = fixture({ state: phones() })
  const dialog = await open(user)
  await user.click(within(dialog).getByRole('button', { name: 'Remove Zach’s iPhone' }))
  const ask = within(dialog).getByRole('group', { name: 'Remove Zach’s iPhone?' })
  await waitFor(() => expect(within(ask).getByRole('button', { name: 'Keep phone' })).toHaveFocus())
  await user.click(within(ask).getByRole('button', { name: 'Keep phone' }))
  expect(within(dialog).queryByRole('group', { name: 'Remove Zach’s iPhone?' })).toBeNull()
  await user.click(within(dialog).getByRole('button', { name: 'Remove Zach’s iPhone' }))
  await user.click(within(dialog).getByRole('button', { name: 'Remove phone' }))
  expect(sent()).toContainEqual({ type: 'host-phones', id: REMOTE, command: { type: 'remove', clientId: 'phone-1' } })
})

it('shows what a disconnected host last said, and changes nothing until it connects', async () => {
  const user = userEvent.setup()
  fixture({ state: phones(), readAt: '2026-10-03T09:12:00.000Z' }, host({ phase: 'disconnected' }))
  const dialog = await open(user)
  expect(within(dialog).getByText(/Connect to forge to change phone access or pair a phone/u)).toBeInTheDocument()
  expect(within(dialog).getByRole('switch', { name: 'Let phones reach forge' })).toBeDisabled()
  expect(within(dialog).getByRole('heading', { name: /Paired phones, as of/u })).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'Remove Zach’s iPhone' })).toBeDisabled()
})

it('words the row and every failure for the host it is on', () => {
  expect(hostPhonesLabel(undefined)).toBeNull()
  expect(hostPhonesLabel({ id: REMOTE, state: phones({ enabled: false, phase: 'off' }) })).toBe('Phones off')
  expect(hostPhonesLabel({ id: REMOTE, state: phones({ phase: 'failed' }) })).toBe('Phones need you')
  expect(hostPhonesLabel({ id: REMOTE, state: phones({ phones: [] }) })).toBe('Phones on')
  expect(hostPhonesFailure(phones({ phase: 'failed', tailscale: { status: 'failed', reason: 'missing' } }), 'forge')).toBe('Tailscale isn’t installed on forge. Nothing was changed, and Sotto won’t install it. Install Tailscale on forge and sign in there, then press Try again.')
  for (const reason of ['port-taken', 'not-enabled', 'denied', 'listener', 'record', 'failed'] as const) {
    expect(hostPhonesFailure(phones({ phase: 'failed', serve: { status: 'failed', reason } }), 'forge')).toMatch(/[Nn]othing was changed|wasn’t started/u)
  }
})

it('shows an admin connection’s Tailscale approval at the top of the dialog while it waits, and opens the page on a press (ADR-0053)', async () => {
  const user = userEvent.setup()
  const { sent } = fixture(undefined, host({ prefer: 'tailnet', via: 'tailnet', adminSignIn: true, tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1fixture2b3c' } }))
  const dialog = await open(user)
  expect(within(dialog).getByText('Waiting for your approval in Tailscale. forge uses Tailscale SSH, which asks you to approve this connection in your browser. The dialog fills in once you approve. Sotto waits up to 5 minutes.')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Open the Tailscale approval page for forge' }))
  expect(sent()).toContainEqual({ type: 'open-approval', id: REMOTE })
  expect(within(dialog).getByRole('button', { name: 'Why Tailscale asks' })).toBeTruthy()
})

it('keeps what it last read on show, with nothing to press, while Tailscale waits to approve a new admin connection (ADR-0053)', async () => {
  const user = userEvent.setup()
  fixture({ state: phones() }, host({ prefer: 'tailnet', via: 'tailnet', adminSignIn: true, tailscale: { waiting: true } }))
  const dialog = await open(user)
  expect(within(dialog).getByText(/^Waiting for your approval in Tailscale\./u)).toBeTruthy()
  expect(within(dialog).getByRole('switch', { name: 'Let phones reach forge' })).toBeDisabled()
})

it('asks SSH’s question for its admin connection in the dialog, and stops signing in on a press (ADR-0053)', async () => {
  const user = userEvent.setup()
  const { sent } = fixture({ state: phones() }, host({ prefer: 'tailnet', via: 'tailnet', adminSignIn: true, prompt: { id: 'prompt-3', kind: 'password', text: 'Password:' } }))
  const dialog = await open(user)
  expect(within(dialog).getByRole('switch', { name: 'Let phones reach forge' })).toBeDisabled()
  await user.type(within(dialog).getByLabelText('SSH password'), 'secret{Enter}')
  expect(sent()).toContainEqual({ type: 'ssh-answer', id: REMOTE, promptId: 'prompt-3', answer: 'secret' })
  await user.click(within(dialog).getByRole('button', { name: 'Stop signing in' }))
  expect(sent()).toContainEqual({ type: 'stop-admin-sign-in', id: REMOTE })
})

it('shows phone access as not read yet until the host is read, with no switch to mislead (ADR-0053)', async () => {
  const user = userEvent.setup()
  const { push } = fixture(undefined, host({ prefer: 'tailnet', via: 'tailnet', adminSignIn: true, tailscale: { waiting: true } }))
  const dialog = await open(user)
  // Nothing is known yet: no switch reading off, and each check waits for the first.
  expect(within(dialog).queryByRole('switch')).toBeNull()
  const checks = within(dialog).getByRole('list', { name: 'Phone access on forge' })
  expect(within(checks).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'Let phones reach forgeNot read yet. The switch shows once Sotto reaches forge over SSH.',
    'Tailscale on forgeWaits for the step above.',
    'Tailscale Serve on port 8443Waits for the step above.',
    'Paired phonesWaits for the step above.',
  ])
  expect(within(checks).getAllByRole('img', { name: 'Not yet' })).toHaveLength(4)
  // Read: the switch shows as the host has it.
  push({ state: phones() })
  expect(within(dialog).getByRole('switch', { name: 'Let phones reach forge' })).toHaveAttribute('aria-checked', 'true')
  expect(within(dialog).queryByText('Waits for the step above.')).toBeNull()
})

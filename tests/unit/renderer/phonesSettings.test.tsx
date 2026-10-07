import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PhonesSettings } from '../../../src/renderer/src/features/settings/PhonesSettings'
import type { PairedPhone, PhonesBridge, PhonesCommand, PhonesState } from '../../../src/shared/phones'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const DNS = 'laptop-russh2j5.tail5728ca.ts.net'
const OFF: PhonesState = {
  enabled: false, localHostRunning: true, phase: 'off', tailscale: { status: 'waiting' }, serve: { status: 'waiting' }, address: null,
  computerName: 'LAPTOP-RUSSH2J5', defaultName: 'LAPTOP-RUSSH2J5', code: null, phones: [], answersAvailable: true,
}
const READY: PhonesState = { ...OFF, enabled: true, phase: 'on', tailscale: { status: 'ok', hostName: 'laptop-russh2j5', dnsName: DNS }, serve: { status: 'ok' }, address: `https://${DNS}:8443`, defaultName: 'laptop-russh2j5', computerName: 'laptop-russh2j5' }
const PHONE: PairedPhone = { clientId: 'phone-1', name: 'Zach’s iPhone', pairedAt: '2026-09-26T10:00:00.000Z', connected: true, canAnswer: false }

function fixture(initial: PhonesState, answer?: (command: PhonesCommand, state: PhonesState) => PhonesState) {
  let state = initial
  const listeners = new Set<(value: PhonesState) => void>()
  const push = (next: Partial<PhonesState>): void => { state = { ...state, ...next }; act(() => { for (const listener of listeners) listener(state) }) }
  const command = vi.fn<PhonesBridge['command']>(async input => { if (answer) state = answer(input, state); return state })
  const bridge: PhonesBridge = { get: async () => state, command, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  return { bridge, command, push }
}
function show(state: PhonesState, options: { answer?: (command: PhonesCommand, state: PhonesState) => PhonesState; name?: string } = {}) {
  const { bridge, command, push } = fixture(state, options.answer)
  const update = vi.fn(async () => true), openHosts = vi.fn()
  render(<PhonesSettings phoneAccess={state.enabled} phoneAccessName={options.name ?? ''} onUpdateSettings={update} onOpenHosts={openHosts} bridge={bridge} />)
  return { command, push, update, openHosts }
}
const step = (name: string) => screen.getByText(name, { selector: 'b' }).closest('li')!

it('shows failed setting saves beside each control and clears them after a successful retry', async () => {
  const { bridge } = fixture(OFF)
  const update = vi.fn(async () => false)
  const user = userEvent.setup()
  const { container } = render(<PhonesSettings phoneAccess={false} phoneAccessName="" onUpdateSettings={update} onOpenHosts={vi.fn()} bridge={bridge} />)
  const toggle = screen.getByRole('switch', { name: 'Let phones connect' })
  await user.click(toggle)
  expect(await within(container.querySelector('.phones-switch')!).findByRole('alert')).toHaveTextContent('Phone access could not be saved. Nothing was changed. Try again.')
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  const input = await screen.findByRole('textbox', { name: 'Name on phones' })
  await user.type(input, 'My computer{Enter}')
  expect(await within(container.querySelector('.phones-name')!).findByText('The name could not be saved. Phones still use the previous name. Try again.')).toBeInTheDocument()
  expect(input).toHaveAccessibleDescription(/The name could not be saved\. Phones still use the previous name\. Try again\./)
  expect(within(container.querySelector('.phones-name')!).queryByRole('alert')).toBeNull()
  expect(input).toHaveValue('My computer')
  update.mockResolvedValue(true)
  await user.keyboard('{Enter}')
  await waitFor(() => expect(within(container.querySelector('.phones-name')!).queryByText('The name could not be saved. Phones still use the previous name. Try again.')).toBeNull())
  await user.click(toggle)
  await waitFor(() => expect(within(container.querySelector('.phones-switch')!).queryByRole('alert')).toBeNull())
})

it('copies the phone address through main when browser clipboard access is denied', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Permission denied'))
  const deliverOutput = vi.fn(async () => 'copied')
  vi.stubGlobal('sotto', { deliverOutput })
  show(READY)
  await user.click(await screen.findByRole('button', { name: 'Copy address' }))
  expect(deliverOutput).toHaveBeenCalledWith({ text: READY.address, autoPaste: false, pasteDelayMs: 50 })
  expect(writeText).not.toHaveBeenCalled()
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
})

it('off: every step waits, and no code can be shown yet', async () => {
  const { update } = show(OFF)
  const toggle = await screen.findByRole('switch', { name: 'Let phones connect' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  for (const name of ['Tailscale is running', 'Tailscale Serve on port 8443', 'Address phones use']) {
    expect(within(step(name)).getByRole('img', { name: 'Not yet' })).toBeTruthy()
    expect(within(step(name)).getByText('Checked when you turn this on.')).toBeTruthy()
  }
  expect(screen.getByText('Turn on Let phones connect first.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Show a pairing code' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('heading', { name: 'Paired phones' })).toBeNull()
  await userEvent.setup().click(toggle)
  expect(update).toHaveBeenCalledWith({ phoneAccess: true })
})

it('ready: each step says it worked, with the machine name, the address and Copy address', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  show(READY)
  await screen.findByText(`https://${DNS}:8443`)
  expect(within(step('Tailscale is running')).getByRole('img', { name: 'Done' })).toBeTruthy()
  expect(step('Tailscale is running').textContent).toContain('Signed in. This computer is laptop-russh2j5 on your tailnet.')
  expect(step('Tailscale Serve on port 8443').textContent).toContain('Sotto added it. Port 443 stays free for other apps.')
  expect(screen.getAllByText('laptop-russh2j5').length).toBeGreaterThan(1)
  await user.click(screen.getByRole('button', { name: 'Copy address' }))
  expect(writeText).toHaveBeenCalledWith(`https://${DNS}:8443`)
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  expect(screen.getByText('A code works once, for five minutes.')).toBeTruthy()
})

it('code: shows eight characters with a countdown, spelled out for a screen reader, and Escape cancels it', async () => {
  const code = { code: 'K7MX3QPD', expiresAt: new Date(Date.now() + 292_000).toISOString() }
  const { command } = show(READY, { answer: (input, state) => input.type === 'show-code' ? { ...state, code } : input.type === 'cancel-code' ? { ...state, code: null } : state })
  const user = userEvent.setup()
  await screen.findByText('A code works once, for five minutes.')
  await user.click(screen.getByRole('button', { name: 'Show a pairing code' }))
  const box = await screen.findByRole('group', { name: 'Pairing code' })
  expect(box).toBe(document.activeElement)
  expect(within(box).getByText('Pairing code K 7 M X 3 Q P D')).toHaveClass('tt-visually-hidden')
  expect(within(box).getByText('K7MX3QPD')).toHaveAttribute('aria-hidden', 'true')
  expect(within(box).queryByRole('img')).not.toBeInTheDocument()
  expect(within(box).queryByRole('status')).not.toBeInTheDocument()
  expect(box.textContent).toMatch(/Works once\. Expires in 4:5\d/u)
  expect(within(box).getByRole('button', { name: 'Make a new code' })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(command).toHaveBeenLastCalledWith({ type: 'cancel-code' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show a pairing code' })).toBe(document.activeElement))
})

it('closes the code when a phone redeems it, and says the phone is paired', async () => {
  const code = { code: 'K7MX3QPD', expiresAt: new Date(Date.now() + 292_000).toISOString() }
  const { push } = show({ ...READY, code })
  await screen.findByRole('group', { name: 'Pairing code' })
  push({ code: null, phones: [PHONE] })
  expect(screen.queryByRole('group', { name: 'Pairing code' })).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('Zach’s iPhone is paired.')
  expect(screen.getByRole('region', { name: 'Zach’s iPhone' })).toBeTruthy()
})

it('paired: a phone row with its date, whether it is connected, Can answer off at first, and Remove that asks first', async () => {
  const { command } = show({ ...READY, phones: [PHONE] }, { answer: (input, state) => input.type === 'remove' ? { ...state, phones: [] } : input.type === 'set-can-answer' ? { ...state, phones: [{ ...PHONE, canAnswer: input.allowed }] } : state })
  const row = await screen.findByRole('region', { name: 'Zach’s iPhone' })
  expect(within(row).getByText(/^Paired /u).textContent).toBe('Paired Sep 26 · Connected')
  expect(within(row).getByText('Reads and replies. Can’t answer questions or permissions.')).toBeTruthy()
  const answer = within(row).getByRole('switch', { name: 'Can answer: let Zach’s iPhone answer questions and permissions' })
  expect(answer.getAttribute('aria-checked')).toBe('false')
  const user = userEvent.setup()
  await user.click(answer)
  expect(command).toHaveBeenLastCalledWith({ type: 'set-can-answer', clientId: 'phone-1', allowed: true })
  expect(await within(row).findByText('Reads and replies. Can answer questions and permissions.')).toBeTruthy()
  await user.click(within(row).getByRole('button', { name: 'Remove Zach’s iPhone' }))
  const dialog = screen.getByRole('dialog', { name: 'Remove Zach’s iPhone?' })
  expect(command).not.toHaveBeenCalledWith({ type: 'remove', clientId: 'phone-1' })
  await user.click(within(dialog).getByRole('button', { name: 'Remove phone' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'remove', clientId: 'phone-1' })
  expect(screen.queryByRole('region', { name: 'Zach’s iPhone' })).toBeNull()
})

it('Tailscale not running: the first step fails in plain words, the rest wait, and Try again retries', async () => {
  const { command } = show({ ...OFF, enabled: true, phase: 'failed', tailscale: { status: 'failed', reason: 'not-running' } })
  await screen.findByRole('img', { name: 'Failed' })
  expect(step('Tailscale is running').textContent).toContain('Tailscale isn’t running on this computer, or isn’t signed in. Phones can’t reach it yet, and nothing was changed.')
  expect(step('Tailscale Serve on port 8443').textContent).toContain('Waits for Tailscale.')
  expect(step('Address phones use').textContent).toContain('Waits for the steps above.')
  expect(screen.getByText('Finish the steps above first.')).toBeTruthy()
  await userEvent.setup().click(within(step('Tailscale is running')).getByRole('button', { name: 'Try again' }))
  expect(command).toHaveBeenCalledWith({ type: 'retry' })
})

it('port taken: says Sotto left the other app’s setting alone', async () => {
  show({ ...READY, phase: 'failed', serve: { status: 'failed', reason: 'port-taken' }, address: null })
  await screen.findByRole('img', { name: 'Failed' })
  expect(step('Tailscale Serve on port 8443').textContent).toContain('Another app already uses port 8443 in Tailscale Serve on this computer. Sotto left that setting alone, and nothing was changed.')
  expect(within(step('Tailscale Serve on port 8443')).queryByRole('button', { name: 'Turn on Serve in Tailscale' })).toBeNull()
})

it('Serve not turned on for the tailnet: offers the page that turns it on', async () => {
  const { command } = show({ ...READY, phase: 'failed', serve: { status: 'failed', reason: 'not-enabled', canOpenSetup: true }, address: null })
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Turn on Serve in Tailscale' }))
  expect(command).toHaveBeenCalledWith({ type: 'open-serve-setup' })
})

it('local host off: says phone access needs it, disables the switch and offers Hosts', async () => {
  const { openHosts } = show({ ...OFF, enabled: true, localHostRunning: false })
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Go to Hosts' }))
  expect(openHosts).toHaveBeenCalled()
  expect(screen.getByText(/Phone access needs the local host, which is off\./u)).toBeTruthy()
  // Still on from before, so it can be turned off; it cannot be turned on until the local host runs.
  expect((screen.getByRole('switch', { name: 'Let phones connect' }) as HTMLButtonElement).disabled).toBe(false)
  cleanup()
  show({ ...OFF, localHostRunning: false })
  expect((await screen.findByRole('switch', { name: 'Let phones connect' }) as HTMLButtonElement).disabled).toBe(true)
})

it('saves the name phones show on Enter, and Escape puts the saved one back', async () => {
  const { update } = show(READY, { name: 'Studio' })
  const field = await screen.findByRole('textbox', { name: 'Name on phones' })
  expect((field as HTMLInputElement).placeholder).toBe('laptop-russh2j5')
  const user = userEvent.setup()
  await user.clear(field)
  await user.type(field, 'Den{Escape}')
  expect((field as HTMLInputElement).value).toBe('Studio')
  await user.clear(field)
  await user.type(field, 'Den{Enter}')
  expect(update).toHaveBeenCalledWith({ phoneAccessName: 'Den' })
})

it.each([{ isComposing: true }, { keyCode: 229 }])('keeps the computer name while composing Enter (%j)', async composition => {
  const { update } = show(READY)
  const field = await screen.findByRole('textbox', { name: 'Name on phones' })
  const user = userEvent.setup()
  await user.type(field, 'Forge')
  expect(field).toHaveValue('Forge')
  fireEvent.keyDown(field, { key: 'Enter', ...composition })
  expect(update).not.toHaveBeenCalled()
  await user.keyboard('{Enter}')
  expect(update).toHaveBeenCalledWith({ phoneAccessName: 'Forge' })
})

it('shows unfinished cleanup and offers a retry while the setting is off', async () => {
  const { command } = show({ ...OFF, phase: 'cleanup-failed', serve: { status: 'failed', reason: 'cleanup' } })
  expect(await screen.findByText(/Phones can’t connect/)).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
  expect(command).toHaveBeenCalledWith({ type: 'retry' })
})


it('explains when phone access settings could not be saved', async () => {
  show({ ...OFF, enabled: true, phase: 'failed', serve: { status: 'failed', reason: 'record' } })
  expect(await screen.findByText(/Phone access wasn’t started/)).toBeTruthy()
})


it('explains cleanup when the saved record could not be read', async () => {
  show({ ...OFF, phase: 'cleanup-failed', serve: { status: 'failed', reason: 'cleanup-record' } })
  expect(await screen.findByText(/couldn’t read its saved cleanup record/)).toBeVisible()
  expect(screen.getByText(/Remove the setting on port 8443 in Tailscale, then press Try again/)).toBeVisible()
})


it('keeps pairing unavailable as soon as the setting turns off', async () => {
  show({ ...READY, enabled: false })
  expect(await screen.findByRole('button', { name: 'Show a pairing code' })).toBeDisabled()
})

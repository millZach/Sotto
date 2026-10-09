import { host, fixture, openAddHost, typeAHost, settings, addForge } from '../../../../fixtures/renderer/hostsSettingsHarness'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { HostsCommand, HostsState } from '../../../../../src/shared/hosts'

it('ends Add host with its tailnet step after Paired, and says the host is connected over the tailnet once it is (ADR-0053)', async () => {
  const user = userEvent.setup()
  const { dialog, forge, steps, push, finish } = await addForge(user)
  // Saved and paired, with the tailnet step under way: every step before it is done, and the add is not over yet.
  push({ hosts: [forge({ prefer: 'tailnet', via: 'ssh', addTailnet: { state: 'active' } })] })
  expect(steps()).toEqual(['Done: Reached forge', 'Done: Signed in', 'Done: Host installed', 'Done: Host started', 'Done: Paired', 'In progress: Reaching forge over your tailnet…'])
  expect(screen.getByRole('dialog', { name: 'Connecting to forge' })).toBe(dialog)
  expect(within(dialog).getAllByRole('status')[0]!.textContent).toBe('Reaching forge over your tailnet…')
  expect(within(dialog).getByText(/^forge is added\. Sotto turns on Tailscale Serve on forge, on your tailnet only, and tries the address forge reports\./u)).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: /^Change/u })).toBeNull()
  // forge is saved by now, so the footer offers Close, which keeps it, rather than Cancel, and nothing to add again.
  expect([...dialog.querySelectorAll('.tt-dialog__actions button')].map(button => button.textContent)).toEqual(['Close'])
  expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveAccessibleDescription('Closes this dialog. forge is already added and stays added.')
  // On the tailnet: the step is done with the address it reached, and the card says how the host is connected.
  push({ hosts: [forge({ prefer: 'tailnet', via: 'tailnet', tailnetAddress: 'https://forge.tail5728ca.ts.net:8443', addTailnet: { state: 'done' } })] })
  finish()
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'forge is connected' })).toBe(dialog))
  expect(steps().at(-1)).toBe('Done: Reached forge over your tailnet')
  expect(within(dialog).getByText('https://forge.tail5728ca.ts.net:8443')).toBeTruthy()
  expect(within(dialog).getByText(/^forge is added and connected over your tailnet\./u)).toBeTruthy()
  expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['Done'])
})

it('says why Add host kept a host on SSH, and Try the tailnet again chooses the tailnet again, which reaches it (ADR-0053)', async () => {
  const user = userEvent.setup()
  let release: (() => void) | undefined
  const { dialog, forge, steps, push, finish, command, state } = await addForge(user, (input, current) => input.type === 'set-connection'
    ? new Promise<HostsState>(resolve => { release = () => resolve({ ...current, hosts: [{ ...current.hosts[0]!, via: 'tailnet', tailnetNote: undefined }] }) }) : current)
  push({ hosts: [forge({ prefer: 'tailnet', via: 'ssh', tailnetNote: 'operator', addTailnet: { state: 'ssh', why: 'operator' } })] })
  finish()
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'forge is connected over SSH' })).toBe(dialog))
  expect(steps().at(-1)).toBe('Failed: Could not reach forge over your tailnet')
  expect(within(dialog).getByText(/^forge’s Tailscale Serve needs your SSH account to be Tailscale’s operator there, so forge is connected over SSH and nothing was lost\. Run this on forge, then press Try the tailnet again\.$/u)).toBeTruthy()
  expect(within(dialog).getByText('sudo tailscale set --operator=$USER')).toBeTruthy()
  expect(within(dialog).getByText(/^forge is added and connected over SSH\./u)).toBeTruthy()
  // Done stays where Enter lands; Try the tailnet again and Use SSH only sit beside it.
  const done = within(dialog).getByRole('button', { name: 'Done' })
  expect(document.activeElement).toBe(done)
  expect([...dialog.querySelectorAll('.tt-dialog__actions button')].map(button => button.textContent)).toEqual(['Use SSH only', 'Try the tailnet again', 'Done'])
  await user.click(within(dialog).getByRole('button', { name: 'Try the tailnet again' }))
  expect(command).toHaveBeenCalledWith({ type: 'set-connection', id: state().hosts[0]!.id, prefer: 'tailnet' })
  // While the step runs again, forge is still on SSH, and the title and card keep saying so.
  expect(steps().at(-1)).toBe('In progress: Reaching forge over your tailnet…')
  expect(screen.getByRole('dialog', { name: 'forge is connected over SSH' })).toBe(dialog)
  expect(within(dialog).getByText(/^forge is added and connected over SSH\./u)).toBeTruthy()
  await act(async () => { release!() })
  push({})
  await waitFor(() => expect(steps().at(-1)).toBe('Done: Reached forge over your tailnet'))
  expect(screen.getByRole('dialog', { name: 'forge is connected' })).toBe(dialog)
})

it('chooses SSH from Add host’s tailnet step with Use SSH only, and says what went wrong when Try the tailnet again could not change it', async () => {
  const user = userEvent.setup()
  const refusal = 'The host on forge refused the change. Nothing was changed. Check the host on forge, then try again.'
  let refuse = true
  const { dialog, forge, steps, push, finish, command, state } = await addForge(user, (input, current) => {
    // As a refusal reaches the window: Electron puts the channel in front of main's sentence, which the step leaves out.
    if (input.type === 'set-connection' && input.prefer === 'tailnet' && refuse) throw new Error(`Error invoking remote method 'hosts:command': Error: ${refusal}`)
    return current
  })
  push({ hosts: [forge({ prefer: 'tailnet', via: 'ssh', tailnetNote: 'unreachable', tailnetAddress: 'https://forge.tail5728ca.ts.net:8443', addTailnet: { state: 'ssh', why: 'unreachable' } })] })
  finish()
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'forge is connected over SSH' })).toBe(dialog))
  expect(within(dialog).getByText('forge didn’t answer at https://forge.tail5728ca.ts.net:8443, so forge is connected over SSH and nothing was lost. Sotto tries the tailnet again every 5 minutes.')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Try the tailnet again' }))
  await waitFor(() => expect(within(dialog).getByText(refusal)).toBeTruthy())
  expect(steps().at(-1)).toBe('Failed: Could not reach forge over your tailnet')
  refuse = false
  await user.click(within(dialog).getByRole('button', { name: 'Use SSH only' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'set-connection', id: state().hosts[0]!.id, prefer: 'ssh' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('follows the host once Add host has ended, so a 5-minute check that reaches the tailnet shows on the step', async () => {
  const user = userEvent.setup()
  const { dialog, forge, steps, push, finish } = await addForge(user)
  push({ hosts: [forge({ prefer: 'tailnet', via: 'ssh', tailnetNote: 'unreachable', addTailnet: { state: 'ssh', why: 'unreachable' } })] })
  finish()
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'forge is connected over SSH' })).toBe(dialog))
  // The check moves forge to the tailnet while the dialog is still open: main's step still says SSH, the host does not.
  push({ hosts: [forge({ prefer: 'tailnet', via: 'tailnet', tailnetNote: undefined, addTailnet: { state: 'ssh', why: 'unreachable' } })] })
  expect(steps().at(-1)).toBe('Done: Reached forge over your tailnet')
  expect(screen.getByRole('dialog', { name: 'forge is connected' })).toBe(dialog)
  expect(within(dialog).queryByRole('button', { name: 'Try the tailnet again' })).toBeNull()
})

it('turns Add host into the setup checklist once pressed, asks SSH questions on their step, and says when the host is connected', async () => {
  let resolveAdd: ((state: HostsState) => void) | undefined
  const { bridge, command, push, state } = fixture([], (input, current) => input.type === 'add' ? new Promise<HostsState>(resolve => { resolveAdd = resolve }) : current)
  const user = userEvent.setup()
  settings(bridge)
  const { dialog } = await openAddHost(user)
  await user.type(await typeAHost(user, dialog), 'forge')
  await user.type(within(dialog).getByRole('textbox', { name: 'Username (optional)' }), 'zach')
  await user.type(within(dialog).getByRole('textbox', { name: 'Port (optional)' }), '2222')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const sent = command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>
  expect(sent).toEqual({ type: 'add', host: { id: expect.any(String), name: 'forge', target: 'zach@forge', sshPort: 2222, installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', identityFile: '' } })
  // The form gives way to a line saying what is being added, and the steps.
  expect(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Connecting to forge')
  expect(within(dialog).queryByRole('combobox')).toBeNull()
  expect(within(dialog).getByText('forge').parentElement?.textContent).toBe('forge · as zach, port 2222')
  const adding = host({ id: sent.host.id, name: 'forge', target: 'zach@forge', phase: 'connecting', step: 'reach' })
  push({ adding })
  const steps = (): string[] => within(within(dialog).getByRole('list', { name: 'Connection steps' })).getAllByRole('listitem').map(item => `${item.querySelector('[role="img"]')?.getAttribute('aria-label')}: ${item.querySelector('.host-setup__title')?.textContent}`)
  expect(steps()).toEqual(['In progress: Reaching forge…', 'Not started: Sign in', 'Not started: Check the host installation', 'Not started: Start the host', 'Not started: Pair this computer', 'Not started: Reach forge over your tailnet'])
  // A screen reader hears the connect move on, step by step.
  const progress = () => within(dialog).getAllByRole('status')[0]!.textContent
  expect(progress()).toBe('Reaching forge…')
  expect(within(dialog).getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true)
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  // SSH's question is asked on the step that asked it, since there is no row for the host yet.
  push({ adding: { ...adding, step: 'sign-in', prompt: { id: 'prompt-1', kind: 'passphrase', text: 'Enter passphrase for key' } } })
  const signIn = within(dialog).getAllByRole('listitem')[1]!
  expect(signIn.getAttribute('aria-current')).toBe('step')
  const passphrase = within(signIn).getByLabelText('Key passphrase')
  expect(document.activeElement).toBe(passphrase)
  await user.type(passphrase, 'synthetic')
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    fireEvent.keyDown(passphrase, { key: 'Enter', ...composition })
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ssh-answer' }))
  }
  await user.keyboard('{Enter}')
  expect(command).toHaveBeenCalledWith({ type: 'ssh-answer', id: sent.host.id, promptId: 'prompt-1', answer: 'synthetic' })
  push({ adding: { ...adding, step: 'start' } })
  expect(steps().slice(0, 4)).toEqual(['Done: Reached forge', 'Done: Signed in', 'Done: Host installed', 'In progress: Starting the host…'])
  expect(progress()).toBe('Starting the host…')
  // Saved and connected: the dialog says so, and Done closes it.
  delete state().adding
  push({ hosts: [{ ...adding, phase: 'connected', step: 'pair' }] })
  resolveAdd!(state())
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'forge is connected' })).toBeTruthy())
  expect(steps()).toEqual(['Done: Reached forge', 'Done: Signed in', 'Done: Host installed', 'Done: Host started', 'Done: Paired'])
  expect(within(dialog).getAllByRole('status').map(item => item.textContent)).toEqual(['', expect.stringContaining('forge is added and connected.')])
  expect(within(dialog).queryByRole('button', { name: /^Change/ })).toBeNull()
  const done = within(dialog).getByRole('button', { name: 'Done' })
  expect(document.activeElement).toBe(done)
  await user.click(done)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('region', { name: 'forge' })).toBeTruthy()
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel-add' }))
})

it('shows Tailscale approval as its own step, opens the approval page only on a press, and goes on when approved', async () => {
  const { bridge, command, push } = fixture([])
  const openExternalLink = vi.fn(async () => ({ ok: true as const }))
  const previous = window.sotto
  Object.assign(window, { sotto: { ...previous, openExternalLink } })
  try {
    const user = userEvent.setup()
    settings(bridge)
    const { dialog: form } = await openAddHost(user)
    await user.click(within(form).getByRole('option', { name: /^forge/ }))
    await user.click(within(form).getByRole('button', { name: 'Add host' }))
    const dialog = screen.getByRole('dialog', { name: 'Connecting to forge' })
    const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
    const waiting = host({ id, name: 'forge', target: 'forge', phase: 'connecting', step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } })
    push({ adding: waiting })
    const step = within(dialog).getAllByRole('listitem')[1]!
    expect(step.getAttribute('aria-current')).toBe('step')
    expect(within(step).getByRole('img').getAttribute('aria-label')).toBe('Waiting for you')
    expect(within(step).getByText('Waiting for your approval in Tailscale')).toBeTruthy()
    expect(within(step).getByRole('status').textContent).toBe('forge uses Tailscale SSH, which asks you to approve new connections in your browser. Sotto waits up to 5 minutes and carries on when you approve.Open approval pageWhy Tailscale asks')
    // Focus moves to the one thing to do; nothing opens until it is pressed, and main opens the page.
    const open = within(step).getByRole('button', { name: 'Open approval page' })
    expect(document.activeElement).toBe(open)
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open-approval' }))
    await user.click(open)
    expect(command).toHaveBeenCalledWith({ type: 'open-approval', id })
    await user.click(within(step).getByRole('button', { name: 'Why Tailscale asks' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/millZach/Sotto/blob/main/docs/guide.md#hosts-over-tailscale-ssh')
    // Approved in the browser: the step is done and the checklist carries on without another press.
    push({ adding: { ...waiting, step: 'install', tailscale: { waiting: false } } })
    expect(within(dialog).getAllByRole('listitem').map(item => item.querySelector('.host-setup__title')?.textContent).slice(0, 4))
      .toEqual(['Reached forge', 'Approved in Tailscale', 'Signed in', 'Checking the host installation…'])
    expect(within(dialog).queryByRole('button', { name: 'Open approval page' })).toBeNull()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).toHaveBeenLastCalledWith({ type: 'cancel-add', id })
  } finally { Object.assign(window, { sotto: previous }) }
})

it('shows an approval Tailscale asks of the port forward on the Tailscale step, with the 30 seconds it has', async () => {
  const { bridge, command, push } = fixture([])
  const user = userEvent.setup()
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  await user.click(within(form).getByRole('option', { name: /^forge/ }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Connecting to forge' })
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  push({ adding: host({ id, name: 'forge', target: 'forge', phase: 'connecting', step: 'start', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } }) })
  const items = within(dialog).getAllByRole('listitem')
  expect(items.map(item => `${item.getAttribute('data-state')}: ${item.querySelector('.host-setup__title')?.textContent}`))
    .toEqual(['done: Reached forge', 'waiting: Waiting for your approval in Tailscale', 'done: Signed in', 'done: Host installed', 'active: Starting the host…', 'todo: Pair this computer', 'todo: Reach forge over your tailnet'])
  // Where the user is: the approval, not the step the connect is on.
  expect(items.map(item => item.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null, null, null])
  expect(within(items[1]!).getByRole('status').textContent).toContain('forge uses Tailscale SSH, which asks you to approve the port forward as well. Approve it in your browser within 30 seconds and Sotto carries on.')
  expect(document.activeElement).toBe(within(items[1]!).getByRole('button', { name: 'Open approval page' }))
})

it("keeps a failed Open approval page on the Tailscale card, and shows main's own failure on the failed step", async () => {
  const stale = 'Tailscale is no longer waiting for this approval. Nothing was opened.'
  const { bridge, command, push } = fixture([], (input, current) => { if (input.type === 'open-approval') throw new Error(stale); return current })
  const user = userEvent.setup()
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  await user.click(within(form).getByRole('option', { name: /^forge/ }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Connecting to forge' })
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  const waiting = host({ id, name: 'forge', target: 'forge', phase: 'connecting', step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } })
  push({ adding: waiting })
  await user.click(within(dialog).getByRole('button', { name: 'Open approval page' }))
  // Said on the card it belongs to; the connect itself has not failed.
  const card = within(within(dialog).getAllByRole('listitem')[1]!).getByRole('status')
  expect(within(card).getByRole('alert').textContent).toBe(stale)
  expect(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Connecting to forge')
  // Tailscale stops waiting: the sentence goes with it.
  push({ adding: { ...waiting, step: 'install', tailscale: { waiting: false } } })
  expect(within(dialog).queryByText(stale)).toBeNull()
  // A later failure shows main's sentence on its step.
  const message = 'The host was not ready in time. Nothing was saved. Check that it starts on the SSH host, then add the host again.'
  push({ adding: { ...waiting, phase: 'error', step: 'start', tailscale: { waiting: false }, error: message } })
  const failed = within(screen.getByRole('dialog', { name: 'forge could not be added' })).getAllByRole('listitem')[4]!
  expect(within(failed).getByRole('alert').textContent).toBe(message)
  expect(within(screen.getByRole('dialog')).queryByText(stale)).toBeNull()
})

it('shows a failure on its own step with its fix to copy, and Try again and Change start over', async () => {
  const { bridge, command, push } = fixture([])
  const user = userEvent.setup()
  // After setup, which puts its own clipboard in place.
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  // A form that cannot be sent says so in the form.
  await user.keyboard('{Escape}')
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  expect(within(form).getByRole('alert').textContent).toBe('Choose a device, or choose Another SSH host… to type one.')
  const typed = await typeAHost(user, form)
  await user.type(within(form).getByRole('textbox', { name: 'Port (optional)' }), '99999')
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  expect(within(form).getByRole('alert').textContent).toBe('Enter an SSH host or alias, such as forge or user@server.')
  await user.type(typed, 'forge')
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  expect(within(form).getByRole('alert').textContent).toBe('Enter a port between 1 and 65535, or leave Port empty to use your SSH configuration.')
  await user.clear(within(form).getByRole('textbox', { name: 'Port (optional)' }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  const message = 'The SSH host key changed. Nothing was saved. Verify the host identity and update your SSH known hosts before adding the host again.'
  push({ adding: host({ id, name: 'forge', target: 'forge', phase: 'error', step: 'sign-in', error: message,
    fix: { text: "Once you know the new key is the host's own, remove the old one from your known hosts on this computer:", command: 'ssh-keygen -R forge.example.net' } }) })
  const dialog = screen.getByRole('dialog', { name: 'forge could not be added' })
  const failed = within(dialog).getAllByRole('listitem')[1]!
  expect(within(failed).getByRole('img').getAttribute('aria-label')).toBe('Failed')
  expect(within(failed).getByText('Could not sign in')).toBeTruthy()
  const alert = within(failed).getByRole('alert')
  expect(alert.textContent).toContain(message)
  expect(within(alert).getByText('ssh-keygen -R forge.example.net').tagName).toBe('CODE')
  await user.click(within(alert).getByRole('button', { name: 'Copy the command' }))
  expect(writeText).toHaveBeenCalledWith('ssh-keygen -R forge.example.net')
  expect(within(alert).getByRole('button', { name: 'Copy the command' }).textContent).toBe('Copied')
  expect(within(alert).getByRole('status').textContent).toBe('Copied the command')
  // The steps after the failure never started.
  expect(within(dialog).getAllByRole('listitem').slice(2).map(item => item.getAttribute('data-state'))).toEqual(['todo', 'todo', 'todo', 'todo'])
  expect(screen.getByText('No remote hosts yet.')).toBeTruthy()
  // Try again adds it again as a new attempt.
  await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
  const retried = (command.mock.calls.at(-1)![0] as Extract<HostsCommand, { type: 'add' }>)
  expect(retried).toMatchObject({ type: 'add', host: { target: 'forge' } })
  expect(retried.host.id).not.toBe(id)
  push({ adding: host({ id: retried.host.id, name: 'forge', target: 'forge', phase: 'error', step: 'reach', error: 'SSH could not reach the host. Nothing was saved. Check the host name and your network, then add the host again.' }) })
  // Change drops the attempt and gives the form back with what was typed, focused.
  await user.click(within(dialog).getByRole('button', { name: /^Change/ }))
  expect(command).toHaveBeenLastCalledWith({ type: 'cancel-add', id: retried.host.id })
  const field = within(screen.getByRole('dialog', { name: 'Add host' })).getByRole('textbox', { name: 'SSH host' })
  expect(field).toHaveProperty('value', 'forge')
  await waitFor(() => expect(document.activeElement).toBe(field))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('goes back to the form when main refuses the add before connecting', async () => {
  const { bridge } = fixture([], input => { if (input.type === 'add') throw new Error('forge is already saved as Forge. Nothing was saved. Switch it on in the list instead.'); throw new Error('unexpected') })
  const user = userEvent.setup()
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  await user.click(within(form).getByRole('option', { name: /^forge/ }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add host' })
  expect(within(dialog).getByRole('alert').textContent).toBe('forge is already saved as Forge. Nothing was saved. Switch it on in the list instead.')
  expect(within(dialog).getByRole('combobox', { name: 'Device' }).textContent).toContain('forge')
})

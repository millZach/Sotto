import { LOCAL, REMOTE, host, fixture, openAddHost, typeAHost, neverPaired, settings } from '../../../../fixtures/renderer/hostsSettingsHarness'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { HostQuestionDialog } from '../../../../../src/renderer/src/features/settings/HostQuestionDialog'
import type { HostsCommand, HostsState } from '../../../../../src/shared/hosts'

it('chooses how Sotto connects in Edit connection, with the arrow keys, starting on the choice the host has, and saves it (ADR-0053)', async () => {
  const seen = new Date(2026, 9, 6, 9, 41).getTime()
  const { bridge, command } = fixture([host({ target: 'forge', name: 'forge', prefer: 'ssh', tailnetAddress: 'https://forge.tail5728ca.ts.net:8443', tailnetSeen: seen })])
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to forge' })
  const group = within(dialog).getByRole('group', { name: 'How Sotto connects' })
  const tailnet = within(group).getByRole('radio', { name: 'Over your tailnet, SSH when it can’t' })
  const ssh = within(group).getByRole('radio', { name: 'SSH only' })
  expect(ssh).toBeChecked()
  // The tailnet choice says, before it is chosen, that it turns on Tailscale Serve on the host.
  expect(tailnet).toHaveAccessibleDescription(/^At https:\/\/forge\.tail5728ca\.ts\.net:8443, last reached at .+\. Sotto turns on Tailscale Serve on forge for this, on your tailnet only\./u)
  expect(within(dialog).getByRole('group', { name: 'SSH (for setup, updates and phones)' })).toContainElement(within(dialog).getByRole('textbox', { name: 'SSH host' }))
  // Focus starts on the checked choice, not on the first radio.
  expect(document.activeElement).toBe(ssh)
  await user.keyboard('{ArrowUp}')
  expect(tailnet).toBeChecked()
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  // The choice goes with the SSH settings, which main checks before it writes either.
  expect(command.mock.calls.map(([input]) => input)).toEqual([{ type: 'save', host: { id: REMOTE, name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data' }, prefer: 'tailnet' }])
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('sends a changed choice with changed SSH settings, and has nothing to choose for a host never paired', async () => {
  const { bridge, command } = fixture([host({ target: 'forge', name: 'forge', prefer: 'tailnet' }), neverPaired(host({ id: LOCAL, target: 'spark', name: 'spark' }))])
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  let dialog = screen.getByRole('dialog', { name: 'Edit connection to forge' })
  expect(within(dialog).getByRole('radio', { name: 'Over your tailnet, SSH when it can’t' })).toHaveAccessibleDescription(/^forge says where your tailnet reaches it once Serve is on\./u)
  await user.click(within(dialog).getByRole('radio', { name: 'SSH only' }))
  await user.type(within(dialog).getByRole('textbox', { name: 'Port (optional)' }), '2222')
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  expect(command.mock.calls.map(([input]) => input)).toEqual([{ type: 'save', host: expect.objectContaining({ id: REMOTE, target: 'forge', sshPort: 2222 }), prefer: 'ssh' }])
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  await user.click(screen.getByRole('button', { name: 'More for spark' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  dialog = screen.getByRole('dialog', { name: 'Edit connection to spark' })
  for (const radio of within(dialog).getAllByRole('radio')) expect(radio).toBeDisabled()
  expect(within(dialog).getByText('Connect to spark once before choosing how Sotto connects.')).toBeTruthy()
})

it('asks SSH’s question and shows Tailscale’s approval inside Edit connection while a save signs in, and says why a save failed', async () => {
  let refuse: ((reason: Error) => void) | undefined
  const forge = host({ target: 'forge', name: 'forge', prefer: 'tailnet', via: 'tailnet' })
  const { bridge, command, push } = fixture([forge], (input, current) => input.type === 'save' ? new Promise<HostsState>((_, reject) => { refuse = reject }) : current)
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to forge' })
  await user.click(within(dialog).getByRole('radio', { name: 'SSH only' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  expect(within(dialog).getByText('Saving the connection.')).toBeTruthy()
  // The admin connection's sign-in is held by Tailscale: its approval shows here, where the save was pressed.
  push({ hosts: [{ ...forge, adminSignIn: true, tailscale: { waiting: true, url: 'https://login.tailscale.com/a/approve' } }] })
  expect(within(dialog).getByText(/^Waiting for your approval in Tailscale\. forge uses Tailscale SSH/u)).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Open the Tailscale approval page for forge' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'open-approval', id: REMOTE })
  // Then SSH asks for a password: the question is asked here too, rather than waiting behind the dialog.
  push({ hosts: [{ ...forge, adminSignIn: true, prompt: { id: 'prompt-5', kind: 'password', text: 'Password:' } }] })
  await user.type(within(dialog).getByLabelText('SSH password'), 'secret{Enter}')
  expect(command).toHaveBeenLastCalledWith({ type: 'ssh-answer', id: REMOTE, promptId: 'prompt-5', answer: 'secret' })
  push({ hosts: [forge] })
  await act(async () => { refuse!(new Error(`Error invoking remote method 'hosts:command': Error: How Sotto connects to forge could not be changed. Nothing was changed. Check that forge is reachable over SSH and its host is running, then try again.`)) })
  expect(within(dialog).getByRole('alert').textContent).toBe('How Sotto connects to forge could not be changed. Nothing was changed. Check that forge is reachable over SSH and its host is running, then try again.')
})

it('stops an Edit connection save’s admin sign-in when the dialog closes while Tailscale waits for approval', async () => {
  const forge = host({ target: 'forge', name: 'forge', prefer: 'tailnet', via: 'tailnet' })
  const { bridge, command, push } = fixture([forge], (input, current) => input.type === 'save' ? new Promise<HostsState>(() => undefined) : current)
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to forge' })
  await user.click(within(dialog).getByRole('radio', { name: 'SSH only' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  push({ hosts: [{ ...forge, adminSignIn: true, tailscale: { waiting: true, url: 'https://login.tailscale.com/a/approve' } }] })
  expect(within(dialog).getByText(/^Waiting for your approval in Tailscale\. forge uses Tailscale SSH/u)).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Edit connection to forge' })).toBeNull()
  expect(command).toHaveBeenLastCalledWith({ type: 'stop-admin-sign-in', id: REMOTE })
})

it('asks the SSH question of the connect an Edit connection save waits on, though it is not an admin connection', async () => {
  const forge = host({ target: 'forge', name: 'forge', prefer: 'tailnet', via: 'tailnet' })
  const { bridge, command, push } = fixture([forge], (input, current) => input.type === 'save' ? new Promise<HostsState>(() => undefined) : current)
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to forge' })
  await user.click(within(dialog).getByRole('radio', { name: 'SSH only' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  // SSH only reconnects over SSH inside the save, and that connect asks for a password.
  push({ hosts: [{ ...forge, phase: 'connecting', via: 'ssh', prompt: { id: 'prompt-7', kind: 'password', text: 'Password:' } }] })
  await user.type(within(dialog).getByLabelText('SSH password'), 'secret{Enter}')
  expect(command).toHaveBeenLastCalledWith({ type: 'ssh-answer', id: REMOTE, promptId: 'prompt-7', answer: 'secret' })
})

it('sends no choice from Edit connection when its radio was not moved, though main wrote one since it opened', async () => {
  const forge = host({ target: 'forge', name: 'forge', prefer: 'ssh', via: 'ssh' })
  const { bridge, command, push } = fixture([forge])
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to forge' })
  // Add host's tailnet step chose the tailnet for forge while the dialog was open.
  push({ hosts: [{ ...forge, prefer: 'tailnet' }] })
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  const save = command.mock.calls.map(call => call[0]).find(input => input.type === 'save')
  expect(save).toBeDefined()
  expect(save).not.toHaveProperty('prefer')
})

it('says Forget signs in to a host it is not connected to, to revoke this computer there', async () => {
  const { bridge } = fixture([host({ phase: 'disconnected', enabled: false })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  expect(within(screen.getByRole('dialog', { name: 'Forget Build box?' })).getByText("Sotto signs in to Build box over SSH to revoke this computer's access there, stops the host if Sotto started it, and removes the saved connection. "
    + "If its host starts at boot, Sotto removes that too, so it does not start again when Build box restarts. If Build box can't be reached, it is still removed here, and Sotto shows the command that revokes this computer there. Threads stay on the host.")).toBeTruthy()
})

it('shows Tailscale’s approval inside Forget while its sign-in waits for it, and opens the page on a press', async () => {
  const url = 'https://login.tailscale.com/a/l1a2b3c4'
  let release!: () => void
  const { bridge, command, push } = fixture([host({ phase: 'disconnected', enabled: false })], async (input, current) => {
    if (input.type === 'forget') await new Promise<void>(resolve => { release = resolve })
    return input.type === 'forget' ? { ...current, hosts: [] } : current
  })
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  const dialog = screen.getByRole('dialog', { name: 'Forget Build box?' })
  await user.click(within(dialog).getByRole('button', { name: 'Forget host' }))
  push({ hosts: [host({ phase: 'disconnected', enabled: false, adminSignIn: true, tailscale: { waiting: true, url } })] })
  expect(within(dialog).getByRole('status').textContent).toContain('Waiting for your approval in Tailscale.')
  await user.click(within(dialog).getByRole('button', { name: 'Open the Tailscale approval page for Build box' }))
  expect(command).toHaveBeenCalledWith({ type: 'open-approval', id: REMOTE })
  release()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('says a forgotten host still trusts this computer, offers the command that removes it there, and puts it away on Dismiss', async () => {
  const command = 'I="$HOME/.local/share/sotto-host"; E="$I/host/index.js"; node "$E" --data "$HOME/.sotto" --revoke-client "client"'
  const { bridge, command: sent, push } = fixture([], (input, current) => input.type === 'dismiss-forgotten' ? { ...current, forgotten: (current.forgotten ?? []).filter(item => item.id !== input.id) } : current)
  const user = userEvent.setup()
  // After setup, which puts its own clipboard in place.
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  settings(bridge)
  await screen.findByText('No remote hosts yet.')
  push({ forgotten: [{ id: REMOTE, name: 'forge', revoke: { cause: 'unreachable', command } }] })
  const notice = await screen.findByRole('status', { name: 'forge still trusts this computer' })
  expect(notice.textContent).toContain('SSH could not reach forge, so Sotto removed it from this computer without revoking this computer’s access there. forge still trusts this computer until it is removed there. To remove it, run this on forge while its host is running:')
  expect(within(notice).getByRole('region', { name: 'Command to run on forge' }).textContent).toBe(command)
  await user.click(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }))
  expect(clipboard).toHaveBeenCalledWith(command)
  expect(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }).textContent).toBe('Copied')
  // The label goes back, as every other copy button's does.
  await waitFor(() => expect(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }).textContent).toBe('Copy command'), { timeout: 5_000 })
  await user.click(within(notice).getByRole('button', { name: 'Dismiss what Sotto said about forge' }))
  expect(sent).toHaveBeenCalledWith({ type: 'dismiss-forgotten', id: REMOTE })
  await waitFor(() => expect(screen.queryByRole('status', { name: 'forge still trusts this computer' })).toBeNull())
  // Its button went with it, so focus goes to the control above the list rather than to the page.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add host' }))
})

it('says why each forgotten host was not revoked, one notice for each', async () => {
  const { bridge, push } = fixture([])
  settings(bridge)
  await screen.findByText('No remote hosts yet.')
  push({ forgotten: [
    { id: REMOTE, name: 'forge', revoke: { cause: 'refused', command: 'revoke forge' } },
    { id: LOCAL, name: 'spark', revoke: { cause: 'not-running', command: 'revoke spark' } },
  ] })
  expect(screen.getByRole('status', { name: 'forge still trusts this computer' }).textContent).toContain('The host on forge did not revoke this computer’s access, so Sotto removed forge from this computer and left its host running. forge still trusts this computer until it is removed there. To remove it, run this on forge:')
  expect(screen.getByRole('status', { name: 'spark still trusts this computer' }).textContent).toContain('The host on spark was not running, so Sotto removed spark from this computer without revoking this computer’s access there. spark still trusts this computer until it is removed there. To remove it, start the host on spark, then run this there:')
})

it('selects the command from the keyboard when it cannot be copied, so the copy shortcut takes it', async () => {
  const { bridge, push } = fixture([])
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
  settings(bridge)
  await screen.findByText('No remote hosts yet.')
  push({ forgotten: [{ id: REMOTE, name: 'forge', revoke: { cause: 'unreachable', command: 'revoke forge' } }] })
  const notice = screen.getByRole('status', { name: 'forge still trusts this computer' })
  await user.click(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }))
  expect(within(notice).getByRole('alert').textContent).toBe('The command could not be copied. It is selected above: copy it with your keyboard’s copy shortcut.')
  const code = within(notice).getByRole('region', { name: 'Command to run on forge' })
  expect(document.activeElement).toBe(code)
  expect(window.getSelection()?.toString()).toBe('revoke forge')
})

it('lets Keep host stop Forget’s sign-in while it waits, and says SSH’s question is waiting with Answer', async () => {
  const prompt = { id: 'prompt-9', kind: 'password' as const, text: 'Password:' }
  let release!: () => void
  const { bridge, command, push } = fixture([host({ phase: 'disconnected', enabled: false })], async (input, current) => {
    if (input.type === 'forget') await new Promise<void>(resolve => { release = resolve })
    if (input.type === 'stop-admin-sign-in') release()
    return current
  })
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  const dialog = screen.getByRole('dialog', { name: 'Forget Build box?' })
  await user.click(within(dialog).getByRole('button', { name: 'Forget host' }))
  // Before the sign-in says it is under way, Keep host waits.
  expect(within(dialog).getByRole('button', { name: 'Keep host' })).toBeDisabled()
  push({ hosts: [host({ phase: 'disconnected', enabled: false, adminSignIn: true, prompt })] })
  expect(within(dialog).getByRole('status').textContent).toContain('SSH is waiting for your answer.')
  expect(within(dialog).getByRole('button', { name: "Answer SSH's question for Build box" })).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Keep host' }))
  expect(command).toHaveBeenCalledWith({ type: 'stop-admin-sign-in', id: REMOTE })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('region', { name: 'Build box' })).toBeTruthy()
})

it('asks an admin connection’s SSH question for a change the user asked for, and Stop signing in leaves the switch alone', async () => {
  const forgetting = host({ name: 'forge', phase: 'disconnected', enabled: false, adminSignIn: true, prompt: { id: 'prompt-4', kind: 'password', text: 'Password:' } })
  const { bridge, command } = fixture([forgetting]), user = userEvent.setup()
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog', { name: 'Unlock the SSH connection to forge' })
  expect(dialog.textContent).toContain('Sotto is signing in to forge for a change you asked for there, and SSH needs your password to sign in.')
  await user.click(within(dialog).getByRole('button', { name: 'Stop signing in' }))
  expect(command).toHaveBeenCalledWith({ type: 'stop-admin-sign-in', id: REMOTE })
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-enabled' }))
})

it('renames a host from its menu', async () => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const field = screen.getByRole('textbox', { name: 'Host name' })
  expect(document.activeElement).toBe(field)
  await user.clear(field)
  await user.type(field, 'Forge{Enter}')
  expect(command).toHaveBeenCalledWith({ type: 'rename', id: REMOTE, name: 'Forge' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('edits a connection with its username, port and folders split out, and saves it whole', async () => {
  const { bridge, command } = fixture([host({ target: 'zach@forge', sshPort: 2222, clientId: 'client-1' })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to Build box' })
  expect(within(dialog).getByRole('textbox', { name: 'SSH host' })).toHaveProperty('value', 'forge')
  expect(within(dialog).queryByRole('combobox')).toBeNull()
  expect(within(dialog).getByRole('textbox', { name: 'Username (optional)' })).toHaveProperty('value', 'zach')
  expect(within(dialog).getByRole('textbox', { name: 'Port (optional)' })).toHaveProperty('value', '2222')
  expect(within(dialog).getByText('client-1')).toBeTruthy()
  await user.clear(within(dialog).getByRole('textbox', { name: 'Port (optional)' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  expect(command).toHaveBeenCalledWith({ type: 'save', host: { id: REMOTE, name: 'Build box', target: 'zach@forge', installPath: '/opt/sotto', dataDirectory: '/data', identityFile: '' } })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('names a host with a long name within the limit, and says in words when the host and username are too long', async () => {
  const { bridge, command } = fixture([]), user = userEvent.setup()
  settings(bridge)
  const { dialog } = await openAddHost(user)
  const long = `${'build-'.repeat(20)}box.example.net`
  await user.click(await typeAHost(user, dialog))
  await user.paste(long)
  await user.click(within(dialog).getByRole('textbox', { name: 'Username (optional)' }))
  await user.paste('z')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const sent = command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>
  expect(sent.host.target).toBe(`z@${long}`)
  expect(sent.host.name).toBe(long.slice(0, 80))
  cleanup()
  const second = fixture([])
  settings(second.bridge)
  const { dialog: again } = await openAddHost(user)
  await user.click(await typeAHost(user, again))
  await user.paste(`${'a'.repeat(250)}.net`)
  await user.click(within(again).getByRole('textbox', { name: 'Username (optional)' }))
  await user.paste('zach')
  await user.click(within(again).getByRole('button', { name: 'Add host' }))
  expect(second.command).not.toHaveBeenCalled()
  expect(within(again).getByRole('alert').textContent).toBe('This SSH host and username are too long together. Nothing was saved. Use a shorter alias from your SSH configuration.')
})

it.each([{ isComposing: true }, { keyCode: 229 }])('leaves a host rename for Enter after composition (%j)', async composition => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const field = screen.getByRole('textbox', { name: 'Host name' })
  fireEvent.change(field, { target: { value: 'Forge' } })
  fireEvent.keyDown(field, { key: 'Enter', ...composition })
  expect(command).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(command).toHaveBeenCalledWith({ type: 'rename', id: REMOTE, name: 'Forge' })
})

it.each([{ isComposing: true }, { keyCode: 229 }])('leaves a connection save for Enter after composition (%j)', async composition => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const field = screen.getByRole('textbox', { name: 'SSH host' })
  fireEvent.change(field, { target: { value: 'forge' } })
  fireEvent.keyDown(field, { key: 'Enter', ...composition })
  expect(command).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(command).toHaveBeenCalledWith({ type: 'save', host: expect.objectContaining({ target: 'forge' }) })
})

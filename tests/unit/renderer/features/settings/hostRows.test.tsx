import { REMOTE, host, fixture, openAddHost, rowMeta, settings } from '../../../../fixtures/renderer/hostsSettingsHarness'
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../../../src/renderer/src/features/settings/HostsSettings'
import { HostQuestionDialog } from '../../../../../src/renderer/src/features/settings/HostQuestionDialog'
import { ThreadWorkingCopy } from '../../../../../src/renderer/src/agents/ThreadWorkingCopy'
import type { HostStatus } from '../../../../../src/shared/hosts'
import { hostVersionMismatch } from '../../../../../src/shared/hostProtocol'

it('shows a failed local host save beside the switch and clears it on retry', async () => {
  const change = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const user = userEvent.setup()
  const { container } = render(<HostsSettings localHostEnabled onLocalHostChange={change} bridge={fixture().bridge} />)
  const toggle = screen.getByRole('switch', { name: 'Run the local host' })
  await user.click(toggle)
  expect(await within(container.querySelector('.hosts-local')!).findByRole('alert')).toHaveTextContent('The local host setting could not be saved. Nothing was changed. Try again.')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  await user.click(toggle)
  await waitFor(() => expect(within(container.querySelector('.hosts-local')!).queryByRole('alert')).toBeNull())
})

it('keeps the local host switch, and no longer offers Save, Connect, Disconnect or Use this host', async () => {
  const { bridge } = fixture(), change = vi.fn(async () => true), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={change} bridge={bridge} />)
  await screen.findByRole('region', { name: 'Build box' })
  for (const name of ['Use this host', 'Use this computer', 'Connect', 'Disconnect', 'Save host']) expect(screen.queryByRole('button', { name })).toBeNull()
  await user.click(screen.getByRole('switch', { name: 'Run the local host' }))
  expect(change).toHaveBeenCalledWith(false)
})

it('reads a row the way the prototype does and switches a host off and on', async () => {
  const { bridge, command, push } = fixture([host({ target: 'forge', name: 'forge' })]), user = userEvent.setup()
  settings(bridge)
  const row = await screen.findByRole('region', { name: 'forge' })
  expect(rowMeta(row)).toBe('SSH forge · Connected')
  const toggle = within(row).getByRole('switch', { name: 'Keep forge connected, now and when Sotto starts' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(within(row).getByText('On')).toBeTruthy()
  await user.click(toggle)
  expect(command).toHaveBeenCalledWith({ type: 'set-enabled', id: REMOTE, enabled: false })
  push({ hosts: [host({ target: 'forge', name: 'forge', phase: 'disconnected', enabled: false })] })
  expect(rowMeta(row)).toBe('SSH forge · Switched off')
  expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await user.click(within(row).getByRole('switch'))
  expect(command).toHaveBeenLastCalledWith({ type: 'set-enabled', id: REMOTE, enabled: true })
  push({ hosts: [host({ target: 'forge', name: 'forge', phase: 'connecting', reconnecting: true, sshPort: 2222 })] })
  expect(rowMeta(row)).toBe('SSH forge, port 2222 · Reconnecting…')
})

it('begins the row with how the host is connected, and says when the tailnet did not answer (ADR-0053)', async () => {
  const forge = (patch: Partial<HostStatus>) => host({ target: 'forge', name: 'forge', prefer: 'tailnet', ...patch })
  const { bridge, push } = fixture([forge({ via: 'tailnet', phoneAccess: { status: 'on', phones: 1 } })])
  settings(bridge)
  const row = await screen.findByRole('region', { name: 'forge' })
  const meta = () => row.querySelector('.hosts-row__meta')!.textContent
  // On a tailnet connection the phone words come from the host's hello until the Phones dialog reads them.
  expect(meta()).toBe('Tailnet · Connected · Phones on, 1 paired')
  push({ hosts: [forge({ via: 'ssh', tailnetNote: 'unreachable' })] })
  expect(meta()).toBe('SSH forge · Connected · Tailnet did not answer')
  expect(within(row).getByText('Sotto tries it again every 5 minutes.')).toBeTruthy()
  push({ hosts: [forge({ via: 'ssh', tailnetNote: 'operator' })] })
  // The tailnet answered nothing because forge has not set it up: the row does not say it did not answer.
  expect(meta()).toBe('SSH forge · Connected · Tailnet not ready')
  expect(row.querySelector('.hosts-row__note')!.textContent).toBe('forge’s Tailscale Serve needs sudo tailscale set --operator=$USER, run on forge. Sotto stays on SSH until it can, and tries again every 5 minutes.')
  push({ hosts: [forge({ phase: 'connecting', via: 'tailnet' })] })
  expect(meta()).toBe('Connecting over your tailnet…')
  push({ hosts: [forge({ phase: 'connecting', via: 'ssh' })] })
  expect(meta()).toBe('Connecting over SSH…')
  // A reconnect names the connection it is trying, and a host the owner keeps on SSH reads as it did.
  push({ hosts: [forge({ phase: 'connecting', via: 'tailnet', reconnecting: true })] })
  expect(meta()).toBe('Tailnet · Reconnecting…')
  push({ hosts: [forge({ phase: 'connecting', via: 'ssh', reconnecting: true })] })
  expect(meta()).toBe('SSH forge · Reconnecting…')
  push({ hosts: [forge({ prefer: 'ssh', via: 'ssh', tailnetNote: undefined })] })
  expect(meta()).toBe('SSH forge · Connected')
  expect(row.querySelector('.hosts-row__note')).toBeNull()
})

it('says before Add host is pressed that it turns on Tailscale Serve on the host, on the tailnet only', async () => {
  const { bridge } = fixture([]), user = userEvent.setup()
  settings(bridge)
  const { dialog } = await openAddHost(user)
  const sentence = within(dialog).getByText(/^Sotto turns on Tailscale Serve on the host, on your tailnet only/u)
  // A keyboard or screen reader user meets it on the press itself.
  expect(within(dialog).getByRole('button', { name: 'Add host' })).toHaveAccessibleDescription(sentence.textContent!)
})

it('sets the row’s connection apart from how the host is, and says so for a host on the tailnet', async () => {
  const { bridge } = fixture([host({ target: 'forge', name: 'forge', prefer: 'tailnet', via: 'tailnet' })])
  settings(bridge)
  const row = await screen.findByRole('region', { name: 'forge' })
  expect(row.querySelector('.hosts-row__via')?.getAttribute('data-via')).toBe('tailnet')
  expect(row.querySelector('.hosts-row__via')?.textContent).toBe('Tailnet')
})

it('says on Rename that how Sotto connects does not change', async () => {
  const { bridge } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  expect(screen.getByRole('textbox', { name: 'Host name' })).toHaveAccessibleDescription('Shown on this row and beside the host\'s projects and threads. How Sotto connects to it does not change.')
})

it('opens the row menu from the keyboard, moves with the arrows and gives focus back on Escape', async () => {
  const { bridge } = fixture([host({ owned: true })]), user = userEvent.setup()
  settings(bridge)
  const more = await screen.findByRole('button', { name: 'More for Build box' })
  more.focus()
  await user.keyboard('{Enter}')
  const menu = screen.getByRole('menu', { name: 'Build box actions' })
  expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Stop host', 'Rename', 'Edit connection', 'Forget Build box…'])
  expect(document.activeElement?.textContent).toBe('Stop host')
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement?.textContent).toBe('Rename')
  await user.keyboard('{ArrowUp}{ArrowUp}')
  expect(document.activeElement?.textContent).toBe('Forget Build box…')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(more)
})

it('offers Stop host only for a host Sotto started, confirms it, and says the host is switched off', async () => {
  const { bridge, command } = fixture([host({ owned: true })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Stop host' }))
  const dialog = screen.getByRole('dialog', { name: 'Stop the host on Build box?' })
  expect(within(dialog).getByText(/and switches it off/)).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Stop host' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-host', id: REMOTE }))
  cleanup()
  const discovered = fixture([host({ owned: false })])
  settings(discovered.bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  expect(screen.queryByRole('menuitem', { name: 'Stop host' })).toBeNull()
})

it('keeps Stop host beside the sentence that asks for it, and offers Connect again for a host that needs attention', async () => {
  const mismatch = hostVersionMismatch('0.1.16', '0.1.15', true)
  const { bridge, command } = fixture([host({ phase: 'error', owned: true, error: mismatch })]), user = userEvent.setup()
  settings(bridge)
  expect((await screen.findByRole('alert')).textContent).toBe(mismatch)
  expect(rowMeta(screen.getByRole('region', { name: 'Build box' }))).toBe('SSH build · Needs attention')
  await user.click(screen.getByRole('button', { name: 'Stop host' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop host' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-host', id: REMOTE }))
  // Forget still reaches that host, so it says it revokes and stops rather than leaving access behind.
  await user.click(screen.getByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  expect(within(screen.getByRole('dialog')).getByText("This revokes this computer's access on the host and removes the saved connection. It also stops the host Sotto started there. Threads stay on the host.")).toBeTruthy()
  cleanup()
  const failed = fixture([host({ phase: 'error', error: 'The SSH host refused your sign-in. Check the user name, password or identity file, then reconnect.' })])
  settings(failed.bridge)
  await user.click(await screen.findByRole('button', { name: 'Connect again' }))
  expect(failed.command).toHaveBeenCalledWith({ type: 'set-enabled', id: REMOTE, enabled: true })
  expect(screen.queryByRole('button', { name: 'Stop host' })).toBeNull()
})

it("says on a saved host's row that Tailscale is waiting for approval, and opens the page on a press", async () => {
  const { bridge, command } = fixture([host({ name: 'forge', target: 'forge', phase: 'connecting', reconnecting: true, step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } })])
  const user = userEvent.setup()
  settings(bridge)
  const row = await screen.findByRole('region', { name: 'forge' })
  expect(rowMeta(row)).toBe('SSH forge · Waiting for your approval in Tailscale')
  await user.click(within(row).getByRole('button', { name: 'Open the Tailscale approval page for forge' }))
  expect(command).toHaveBeenCalledWith({ type: 'open-approval', id: REMOTE })
})

it('keeps the remote Open folder control visible and explains where it acts', async () => {
  const command = vi.fn(), user = userEvent.setup()
  render(<ThreadWorkingCopy thread={{ id: 'remote', remoteHost: true, workingDirectory: '/repo' }} project={{ path: '/repo' }} command={command} />)
  await user.click(screen.getByRole('button', { name: 'Working copy: Project folder' }))
  expect(screen.getByText('This folder is on the host machine. Open it there.')).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Open folder' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  await user.click(button)
  expect(command).not.toHaveBeenCalled()
})

it('leaves focus and scrolling on the current page when Hosts is mounted but hidden', async () => {
  const { bridge } = fixture([host({ phase: 'connecting', prompt: { id: 'hidden-prompt', kind: 'password', text: 'Synthetic question' } })]), user = userEvent.setup()
  render(<><button>Current page</button><div hidden><HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} /></div><HostQuestionDialog bridge={bridge} /></>)
  const previous = screen.getByRole('button', { name: 'Current page' })
  previous.focus()
  await screen.findByRole('dialog')
  const row = screen.getByRole('region', { name: 'Build box', hidden: true })
  const scroll = vi.fn()
  row.scrollIntoView = scroll
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(previous))
  expect(scroll).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Answer Build box' })).toBeNull()
})

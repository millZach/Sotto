import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { ThreadWorkingCopy } from '../../../src/renderer/src/agents/ThreadWorkingCopy'
import type { HostsBridge, HostsState } from '../../../src/shared/hosts'
import { hostVersionMismatch } from '../../../src/shared/hostProtocol'

afterEach(cleanup)
const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
function fixture(phase: 'connected' | 'connecting' | 'disconnected' | 'error' = 'connected', reconnecting = false, owned?: boolean, error?: string) {
  const state: HostsState = { localHostEnabled: true, localHostRunning: true, localHostId: LOCAL, activeHostId: LOCAL,
    hosts: [{ id: REMOTE, hostId: REMOTE, name: 'Build box', target: 'build', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase, reconnecting, owned, error }] }
  const command = vi.fn<HostsBridge['command']>(async input => ({ ...state, ...(input.type === 'select' ? { activeHostId: input.hostId } : {}) }))
  const bridge: HostsBridge = { get: async () => state, command, onChanged: () => () => undefined }
  return { bridge, command, state }
}
it('chooses the host explicitly and keeps local hosting separate from host selection', async () => {
  const { bridge, command } = fixture(), change = vi.fn(async () => true), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={change} bridge={bridge} />)
  await user.click(await screen.findByRole('button', { name: 'Use this host' }))
  expect(command).toHaveBeenCalledWith({ type: 'select', hostId: REMOTE })
  expect(change).not.toHaveBeenCalled()
  await user.click(screen.getByRole('switch', { name: 'Run the local host' }))
  expect(change).toHaveBeenCalledWith(false)
})
it('says Reconnecting while a dropped connection retries and still offers Disconnect', async () => {
  const { bridge, command } = fixture('connecting', true), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
  expect(await screen.findByText(/Reconnecting/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Enter pairing code' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Disconnect' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'disconnect', id: REMOTE }))
})
it('offers Stop host only for a host Sotto started, and confirms before stopping it', async () => {
  const { bridge, command } = fixture('connected', false, true), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
  await user.click(await screen.findByRole('button', { name: 'Stop host' }))
  expect(screen.getByRole('dialog', { name: 'Stop the host on Build box?' })).toBeTruthy()
  expect(command).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Keep it running' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Stop host' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop host' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-host', id: REMOTE }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  cleanup()
  const discovered = fixture('connected', false, false)
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={discovered.bridge} />)
  expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop host' })).toBeNull()
})
it('offers Stop host beside the sentence that asks for it when the host Sotto started runs another version', async () => {
  const mismatch = hostVersionMismatch('0.1.16', '0.1.15', true)
  const { bridge, command } = fixture('error', false, true, mismatch), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
  expect((await screen.findByRole('alert')).textContent).toBe(mismatch)
  expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Stop host' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop host' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-host', id: REMOTE }))
  // Forget still reaches that host, so it says it revokes and stops rather than leaving access behind.
  await user.click(screen.getByRole('button', { name: 'Forget' }))
  expect(within(screen.getByRole('dialog')).getByText("This revokes this computer's access on the host and removes the saved connection. It also stops the host Sotto started there. Threads stay on the host.")).toBeTruthy()
  cleanup()
  const failed = fixture('error', false, undefined, 'The host could not start.')
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={failed.bridge} />)
  expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop host' })).toBeNull()
})
it('says what Forget does to a host it cannot reach, and starts a new host blank', async () => {
  const { bridge } = fixture('disconnected'), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
  await user.click(await screen.findByRole('button', { name: 'Forget' }))
  expect(screen.getByText(/access on Build box stays until you connect again or revoke it there/)).toBeTruthy()
  expect(screen.queryByText(/stops the host/)).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Keep host' }))
  await user.click(screen.getByRole('button', { name: 'Add host' }))
  expect(screen.getByRole('textbox', { name: 'Host name' })).toHaveProperty('value', '')
  expect(screen.getByRole('textbox', { name: 'SSH target' })).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: 'Save host' })).toHaveProperty('disabled', true)
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

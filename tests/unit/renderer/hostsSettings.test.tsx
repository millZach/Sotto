import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { ThreadWorkingCopy } from '../../../src/renderer/src/agents/ThreadWorkingCopy'
import type { HostsBridge, HostsState } from '../../../src/shared/hosts'

afterEach(cleanup)
const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
function fixture(phase: 'connected' | 'pairing' = 'connected') {
  const state: HostsState = { localHostEnabled: true, localHostRunning: true, localHostId: LOCAL, activeHostId: LOCAL,
    hosts: [{ id: REMOTE, hostId: REMOTE, name: 'Forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase }] }
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
it('uses pairing B and only submits the code after the user presses Pair', async () => {
  const { bridge, command } = fixture('pairing'), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
  await user.click(await screen.findByRole('button', { name: 'Enter pairing code' }))
  expect(screen.getByText('Read the pairing code on Forge and enter it here.')).toBeTruthy()
  await user.type(screen.getByRole('textbox', { name: 'Pairing code' }), 'ABCD-EFGH')
  expect(command).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Pair this laptop' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'pair', id: REMOTE, code: 'ABCD-EFGH' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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

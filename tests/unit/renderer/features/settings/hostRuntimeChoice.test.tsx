import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostStatus } from '../../../../../src/shared/hosts'

const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'rust-remote-host' && owl.on }))
const { HostRuntimeChoice } = await import('../../../../../src/renderer/src/features/settings/HostRuntimeChoice')

const forge = (patch: Partial<HostStatus> = {}): HostStatus => ({ id: '3f0b9d7e-8a42-4c55-9e1a-2d6c7b8a9e10', name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto',
  dataDirectory: '/data/sotto', enabled: true, phase: 'connected', owned: true, runtime: 'node', runningRuntime: 'node', ...patch })

afterEach(() => { cleanup(); owl.on = true })

it('offers Node and Rust on the row, and a press sends the choice for this host (ADR-0214)', async () => {
  const onCommand = vi.fn(async () => true), user = userEvent.setup()
  render(<HostRuntimeChoice host={forge()} onCommand={onCommand} />)
  const group = screen.getByRole('radiogroup', { name: 'Host program on forge' })
  expect(screen.getByRole('radio', { name: 'Node' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByText('Preview')).toBeNull()
  expect(group).toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: 'Rust' }))
  expect(onCommand).toHaveBeenCalledWith({ type: 'set-runtime', id: forge().id, runtime: 'rust' })
  // Pressing the program already chosen sends nothing.
  await user.click(screen.getByRole('radio', { name: 'Node' }))
  expect(onCommand).toHaveBeenCalledTimes(1)
})

it('marks Rust as a preview, says while it restarts, and says when the host runs the other program until its next start', () => {
  const { rerender } = render(<HostRuntimeChoice host={forge({ runtime: 'rust', switchingRuntime: true })} onCommand={async () => true} />)
  expect(screen.getByText('Preview')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Restarting on Rust (preview)…')
  expect(screen.getByRole('radio', { name: 'Rust' })).toBeDisabled()
  rerender(<HostRuntimeChoice host={forge({ runtime: 'rust', runningRuntime: 'node', owned: false })} onCommand={async () => true} />)
  expect(screen.getByRole('status')).toHaveTextContent('Runs Node now, and Rust (preview) from its next start.')
  rerender(<HostRuntimeChoice host={forge({ runtime: 'rust', runningRuntime: 'rust' })} onCommand={async () => true} />)
  expect(screen.queryByRole('status')).toBeNull()
})

it('offers Restart on Node for a host Sotto started that still runs Rust, as one Owl turned to Rust before the choice', async () => {
  const onCommand = vi.fn(async () => true), user = userEvent.setup()
  render(<HostRuntimeChoice host={forge({ runtime: 'node', runningRuntime: 'rust' })} onCommand={onCommand} />)
  expect(screen.getByRole('status')).toHaveTextContent('Runs Rust (preview) now.')
  await user.click(screen.getByRole('button', { name: 'Restart on Node' }))
  expect(onCommand).toHaveBeenCalledWith({ type: 'set-runtime', id: forge().id, runtime: 'node' })
})

it('shows nothing where the Owl feature is off or main offers no choice', () => {
  owl.on = false
  const { container, rerender } = render(<HostRuntimeChoice host={forge()} onCommand={async () => true} />)
  expect(container).toBeEmptyDOMElement()
  owl.on = true
  rerender(<HostRuntimeChoice host={forge({ runtime: undefined })} onCommand={async () => true} />)
  expect(container).toBeEmptyDOMElement()
})

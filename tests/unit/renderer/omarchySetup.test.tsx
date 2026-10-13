import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmarchySetupPanel } from '../../../src/renderer/src/features/omarchy/OmarchySetup'
import { Onboarding, type OnboardingProps } from '../../../src/renderer/src/features/onboarding/Onboarding'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { setupBridgeFixture, setupState } from '../../fixtures/renderer/omarchySetup'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('Omarchy setup rows', () => {
  it('shows exactly what is left and removes only owned pieces', async () => {
    const initial = setupState('done')
    initial.pieces.keys = { status: 'manual', owned: false, message: 'Set up by hand.' }
    initial.pieces.owl = { status: 'missing', owned: false, message: '' }
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    expect(await screen.findByRole('button', { name: 'Set up the owl' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Remove the keys' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Remove all' }))
    expect(f.calls).toEqual([{ type: 'remove', pieces: ['theme'] }])
  })
  it('keeps the default conflict answer selected and supports arrow keys to keep the keys', async () => {
    const initial = setupState()
    initial.pieces.keys.status = 'conflict'
    initial.keyConflicts = ['F9 runs “Toggle screen recording”.']
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    const give = await screen.findByRole('radio', { name: 'Give F9 to Sotto' })
    expect(give).toBeChecked()
    give.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Leave my keys alone' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Set up all three' }))
    expect(f.calls).toEqual([{ type: 'setup', pieces: ['keys', 'owl', 'theme'], keys: 'keep' }])
  })
  it('asks before updating an owl and Escape cancels without a command', async () => {
    const initial = setupState('done'); initial.pieces.owl.status = 'stale'
    initial.pieces.owl.message = 'Updating restarts the bar for a moment.'
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Update the owl' }))
    expect(screen.getByRole('dialog', { name: 'Update the owl?' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.calls).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Update the owl' }))
    await user.click(screen.getByRole('dialog').querySelector('button:last-child')!)
    expect(f.calls).toEqual([{ type: 'update-owl' }])
  })
  it('reports working and failed rows, offers a retry and gives focus somewhere to continue', async () => {
    const f = setupBridgeFixture(), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await screen.findByRole('button', { name: 'Set up all three' })
    const working = setupState(); working.busy = true; working.pieces.owl.status = 'working'
    act(() => f.change(working))
    expect(screen.getByRole('button', { name: 'Setting up' })).toBeDisabled()
    const partial = setupState('done'); partial.pieces.owl = { status: 'failed', owned: false, message: 'Shell down. Nothing was copied.' }
    act(() => f.change(partial))
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was copied')
    await user.click(screen.getByRole('button', { name: 'Try the owl again' }))
    expect(f.calls).toEqual([{ type: 'setup', pieces: ['owl'], keys: 'unconfirmed' }])
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  })
})

const props: OnboardingProps = { settings: DEFAULT_SETTINGS, speechModel: null, onDownloadSpeechModel: vi.fn(),
  microphoneState: 'ready', shortcut: 'Ctrl+Shift+Space', platform: 'linux', onUpdateSettings: vi.fn(async () => true),
  onRequestMicrophone: vi.fn(), onComplete: vi.fn() }
describe('Linux first-run step', () => {
  it('sits after Welcome, can be skipped, and changes Shortcut once the keys are ready', async () => {
    const f = setupBridgeFixture(), user = userEvent.setup()
    vi.stubGlobal('sotto', { omarchySetup: f.bridge })
    render(<Onboarding {...props} />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    expect(screen.getByRole('heading', { name: 'Set up Sotto in Omarchy' })).toHaveFocus()
    expect(screen.getByLabelText('Setup progress: step 2 of 10')).toBeVisible()
    await user.click(await screen.findByRole('button', { name: 'Set up all three' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toBeVisible()
    for (let n = 0; n < 3; n++) await user.click(screen.getByRole('button', { name: /^(Continue|Skip for now)$/ }))
    expect(screen.getByRole('heading', { name: 'Hold F9 to try it' })).toBeVisible()
  })
  it.each(['win32', 'darwin'] as const)('keeps the nine-step %s journey with Look after Welcome', async platform => {
    const get = vi.fn()
    vi.stubGlobal('sotto', { omarchySetup: { get } })
    const user = userEvent.setup()
    render(<Onboarding {...props} platform={platform} />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toBeVisible()
    expect(screen.getByLabelText('Setup progress: step 2 of 9')).toBeVisible()
    expect(get).not.toHaveBeenCalled()
  })
})

import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

// Pictures in threads are an Owl feature (ADR-0170): the stable side is in settingsCaptureOutput.test.tsx.
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'inline-media',
}))

describe('the switch for every picture and video an agent makes (ADR-0170, part 7)', () => {
  it('starts on, says what each position does, and saves through the ordinary patch', async () => {
    expect(DEFAULT_SETTINGS.showEveryAgentPicture).toBe(true)
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Threads')
    const toggle = screen.getByRole('switch', { name: 'Show every picture and video an agent makes' })
    expect(toggle).toBeChecked()
    expect(screen.getByText(/Off, you see only what you ask it to show you and images you ask it to make\./u)).toBeTruthy()
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ showEveryAgentPicture: false })
  })
})

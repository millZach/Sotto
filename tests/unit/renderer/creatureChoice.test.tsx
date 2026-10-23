import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSettings } from '../../../src/renderer/src/features/settings/AppearanceSettings'
import { CreatureChoice } from '../../../src/renderer/src/features/settings/themes/CreatureChoice'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '../../../src/shared/settings'
import { useCreatureShown } from '../../../src/renderer/src/state/creature'

// The real walk needs matchMedia and animation frames; the choice only cares which creature it shows.
vi.mock('../../../src/renderer/src/agents/CreatureWalk', () => ({
  CreatureWalk: ({ creature }: { creature: string }) => <span data-testid="walk" data-creature={creature} />,
}))

// The switch is an Owl feature (ADR-0072); each test says whether this build has it.
const gate = vi.hoisted(() => ({ owl: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'creature-toggle' && gate.owl,
}))
const app = vi.hoisted(() => ({ settings: undefined as Partial<AppSettings> | undefined }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: () => (app.settings === undefined ? null : { settings: app.settings }),
}))

afterEach(() => {
  cleanup()
  gate.owl = true
  app.settings = undefined
})

describe('creature choice', () => {
  it('shows each creature in order, walking above its name, in a group named by the heading', () => {
    render(<CreatureChoice value="sotto" shown onShow={() => undefined} onChoose={() => undefined} />)
    const group = screen.getByRole('group', { name: 'Creature' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map(button => button.textContent)).toEqual(['Sotto', 'Claude bot'])
    expect(buttons.map(button => within(button).getByTestId('walk').dataset.creature)).toEqual(['sotto', 'claude'])
  })

  it('marks the chosen creature pressed and says so in its name', () => {
    const { rerender } = render(<CreatureChoice value="sotto" shown onShow={() => undefined} onChoose={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Use Sotto as the creature, currently active' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Use Claude bot as the creature' })).toHaveAttribute('aria-pressed', 'false')
    rerender(<CreatureChoice value="claude" shown onShow={() => undefined} onChoose={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Use Sotto as the creature' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Use Claude bot as the creature, currently active' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('chooses with a click or the keyboard, and passes the active one on too, as the effort color does', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<CreatureChoice value="sotto" shown onShow={() => undefined} onChoose={onChoose} />)
    await user.click(screen.getByRole('button', { name: 'Use Claude bot as the creature' }))
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose).toHaveBeenLastCalledWith('claude')
    await user.click(screen.getByRole('button', { name: 'Use Sotto as the creature, currently active' }))
    expect(onChoose).toHaveBeenLastCalledWith('sotto')
    screen.getByRole('button', { name: 'Use Claude bot as the creature' }).focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onChoose).toHaveBeenCalledTimes(4)
    expect(onChoose).toHaveBeenLastCalledWith('claude')
  })
})

describe('appearance settings creature', () => {
  function renderSettings(initial: Partial<AppSettings>) {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, ...initial }
    const save = vi.fn<(patch: SettingsPatch, text?: string) => Promise<boolean>>(async () => true)
    render(<AppearanceSettings settings={settings} platform="win32" onSave={save} getSettings={() => settings} />)
    return { save }
  }

  it('saves the chosen creature on its own', async () => {
    const user = userEvent.setup()
    const { save } = renderSettings({})
    await user.click(screen.getByRole('button', { name: 'Use Claude bot as the creature' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ creature: 'claude' }, 'Creature saved.'))
  })

  it('shows the saved creature pressed', () => {
    renderSettings({ creature: 'claude' })
    expect(screen.getByRole('button', { name: 'Use Claude bot as the creature, currently active' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Use Sotto as the creature' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('creature switch', () => {
  it('turns the creature off and on, and hides the choice while it is off', async () => {
    const user = userEvent.setup()
    const save = vi.fn<(patch: SettingsPatch, text?: string) => Promise<boolean>>(async () => true)
    const settings: AppSettings = { ...DEFAULT_SETTINGS, showCreature: false }
    render(<AppearanceSettings settings={settings} platform="win32" onSave={save} getSettings={() => settings} />)
    expect(screen.queryByRole('group', { name: 'Creature' })).toBeNull()
    await user.click(screen.getByRole('switch', { name: 'Show the creature' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ showCreature: true }, 'Creature shown.'))
  })

  it('shows no switch and the whole choice where the switch is held to Owl, whatever was saved', () => {
    gate.owl = false
    const settings: AppSettings = { ...DEFAULT_SETTINGS, showCreature: false }
    render(<AppearanceSettings settings={settings} platform="win32" onSave={vi.fn(async () => true)} getSettings={() => settings} />)
    expect(screen.queryByRole('switch', { name: 'Show the creature' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Creature' })).toBeInTheDocument()
  })

  it('hides the creature only where the switch is in this build and turned off', () => {
    function Probe() { return <span data-testid="shown">{String(useCreatureShown())}</span> }
    const shown = () => { render(<Probe />); const text = screen.getByTestId('shown').textContent; cleanup(); return text }
    expect(shown()).toBe('true')
    app.settings = { showCreature: false }
    expect(shown()).toBe('false')
    gate.owl = false
    expect(shown()).toBe('true')
    gate.owl = true
    app.settings = { showCreature: true }
    expect(shown()).toBe('true')
  })
})

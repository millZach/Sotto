import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSettings } from '../../../src/renderer/src/features/settings/AppearanceSettings'
import { CreatureChoice } from '../../../src/renderer/src/features/settings/themes/CreatureChoice'
import type { LaterWords } from '../../../src/renderer/src/features/settings/laterWords'
import { saying } from '../../fixtures/renderer/laterWords'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '../../../src/shared/settings'
import { creatureShown, useCreature, useCreatureShown } from '../../../src/renderer/src/state/creature'

// The real walk needs matchMedia and animation frames; the choice only cares which creature it shows.
vi.mock('../../../src/renderer/src/agents/CreatureWalk', () => ({
  CreatureWalk: ({ creature }: { creature: string }) => <span data-testid="walk" data-creature={creature} />,
}))

// The switch and Lardo are Owl features (ADR-0072); each test says whether this build has them.
const gate = vi.hoisted(() => ({ owl: true, lardo: false }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => (id === 'creature-toggle' && gate.owl) || (id === 'lardo-creature' && gate.lardo),
}))
const app = vi.hoisted(() => ({ settings: undefined as Partial<AppSettings> | undefined }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: () => (app.settings === undefined ? null : { settings: app.settings }),
}))

afterEach(() => {
  cleanup()
  gate.owl = true
  gate.lardo = false
  app.settings = undefined
})

describe('creature choice', () => {
  it('shows each creature in order by name, in a group named by the heading', () => {
    render(<CreatureChoice value="sotto" shown onShow={() => undefined} onChoose={() => undefined} />)
    const group = screen.getByRole('group', { name: 'Creature' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map(button => button.textContent)).toEqual(['Sotto', 'Claude bot'])
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
    const save = vi.fn<(patch: SettingsPatch, text?: LaterWords) => Promise<boolean>>(async () => true)
    render(<AppearanceSettings settings={settings} platform="win32" onSave={save} getSettings={() => settings} />)
    return { save }
  }

  it('saves the chosen creature on its own', async () => {
    const user = userEvent.setup()
    const { save } = renderSettings({})
    await user.click(screen.getByRole('button', { name: 'Use Claude bot as the creature' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ creature: 'claude' }, saying('Creature saved.')))
  })

  it('walks the chosen creature above the preview’s composer, and none while it is hidden', () => {
    renderSettings({ creature: 'claude' })
    expect(document.querySelector('.studio-threads__creature [data-testid="walk"]')).toHaveAttribute('data-creature', 'claude')
    cleanup()
    renderSettings({ showCreature: false })
    expect(document.querySelector('.studio-threads__creature')).toBeNull()
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
    const save = vi.fn<(patch: SettingsPatch, text?: LaterWords) => Promise<boolean>>(async () => true)
    const settings: AppSettings = { ...DEFAULT_SETTINGS, showCreature: false }
    render(<AppearanceSettings settings={settings} platform="win32" onSave={save} getSettings={() => settings} />)
    expect(screen.queryByRole('group', { name: 'Creature' })).toBeNull()
    await user.click(screen.getByRole('switch', { name: 'Show the creature' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ showCreature: true }, saying('Creature shown.')))
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

describe('Lardo', () => {
  it('is offered after Claude bot only where his Owl feature is on', () => {
    render(<CreatureChoice value="sotto" shown onShow={() => undefined} onChoose={() => undefined} />)
    expect(within(screen.getByRole('group', { name: 'Creature' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Sotto', 'Claude bot'])
    cleanup()
    gate.lardo = true
    render(<CreatureChoice value="lardo" shown onShow={() => undefined} onChoose={() => undefined} />)
    expect(within(screen.getByRole('group', { name: 'Creature' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Sotto', 'Claude bot', 'Lardo'])
    expect(screen.getByRole('button', { name: 'Use Lardo as the creature, currently active' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves Lardo on its own', async () => {
    gate.lardo = true
    const user = userEvent.setup()
    const save = vi.fn<(patch: SettingsPatch, text?: LaterWords) => Promise<boolean>>(async () => true)
    render(<AppearanceSettings settings={DEFAULT_SETTINGS} platform="win32" onSave={save} getSettings={() => DEFAULT_SETTINGS} />)
    await user.click(screen.getByRole('button', { name: 'Use Lardo as the creature' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ creature: 'lardo' }, saying('Creature saved.')))
  })

  it('where he is held, a saved Lardo shows and is marked as Sotto\u2019s creature, and stays saved', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, creature: 'lardo' }
    const save = vi.fn(async () => true)
    render(<AppearanceSettings settings={settings} platform="win32" onSave={save} getSettings={() => settings} />)
    expect(screen.getByRole('button', { name: 'Use Sotto as the creature, currently active' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.studio-threads__creature [data-testid="walk"]')).toHaveAttribute('data-creature', 'sotto')
    expect(save).not.toHaveBeenCalled()
  })

  it('stands above the composer only where the build offers him', () => {
    function Probe() { return <span data-testid="creature">{useCreature()}</span> }
    const creature = () => { render(<Probe />); const text = screen.getByTestId('creature').textContent; cleanup(); return text }
    app.settings = { creature: 'lardo' }
    expect(creature()).toBe('sotto')
    gate.lardo = true
    expect(creature()).toBe('lardo')
    expect(creatureShown('dragon', true)).toBe('sotto')
    expect(creatureShown(undefined, true)).toBe('sotto')
    expect(creatureShown('claude', false)).toBe('claude')
  })
})

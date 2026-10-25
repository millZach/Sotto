import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { saying } from '../../../../fixtures/renderer/laterWords'

import { AppearanceSettings } from '../../../../../src/renderer/src/features/settings/AppearanceSettings'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../../src/shared/settings'
import type { SottoPlatform } from '../../../../../src/shared/platform'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', () => ({
  useOwlFeature: (id: string) => id === 'menu-bar-owl' && owl.on,
}))

afterEach(() => {
  cleanup()
  owl.on = false
})

function setup({ platform = 'darwin', on = true, settings = {} }: { platform?: SottoPlatform; on?: boolean; settings?: Partial<AppSettings> } = {}) {
  owl.on = on
  const all: AppSettings = { ...DEFAULT_SETTINGS, ...settings }
  const onSave = vi.fn(async () => true)
  render(<AppearanceSettings settings={all} platform={platform} onSave={onSave} getSettings={() => all} />)
  return { onSave, user: userEvent.setup() }
}

const owlHeading = () => screen.queryByRole('heading', { name: 'Menu bar owl' })

describe('MenuBarOwlSettings', () => {
  it.each<SottoPlatform>(['win32', 'linux'])('is hidden on %s', platform => {
    setup({ platform })
    expect(owlHeading()).not.toBeInTheDocument()
  })

  it('is hidden on a Mac when the Owl feature is off', () => {
    setup({ on: false })
    expect(owlHeading()).not.toBeInTheDocument()
  })

  it('shows both groups on a Mac with the Owl feature on, pressed state from settings', () => {
    setup({ settings: { menuBarOwlBody: 'ink', menuBarOwlEyes: 'amber' } })
    expect(owlHeading()).toBeVisible()
    expect(screen.getByText('The owl perched on a branch in your menu bar.')).toBeVisible()
    const body = screen.getByRole('group', { name: 'Body' })
    const eyes = screen.getByRole('group', { name: 'Eyes' })
    expect(within(body).getAllByRole('button')).toHaveLength(3)
    expect(within(eyes).getAllByRole('button')).toHaveLength(3)
    expect(within(body).getByRole('button', { name: "Use Ink as the owl's body color, currently active" })).toHaveAttribute('aria-pressed', 'true')
    expect(within(body).getByRole('button', { name: "Use Slate as the owl's body color" })).toHaveAttribute('aria-pressed', 'false')
    expect(within(eyes).getByRole('button', { name: "Use Amber as the owl's eye color, currently active" })).toHaveAttribute('aria-pressed', 'true')
    expect(within(eyes).getByRole('button', { name: "Use Sotto teal as the owl's eye color" })).toHaveAttribute('aria-pressed', 'false')
  })

  it('saves a body or eye choice with its own text', async () => {
    const { onSave, user } = setup()
    await user.click(screen.getByRole('button', { name: "Use Light as the owl's body color" }))
    expect(onSave).toHaveBeenLastCalledWith({ menuBarOwlBody: 'light' }, saying('Owl body saved.'))
    await user.click(screen.getByRole('button', { name: "Use Ice blue as the owl's eye color" }))
    expect(onSave).toHaveBeenLastCalledWith({ menuBarOwlEyes: 'ice' }, saying('Owl eyes saved.'))
  })
})

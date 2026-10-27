import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { appearancePreview, themeColorVariable } from '../../../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../../src/shared/settings'
import { resolveThemeFor } from '../../../../../src/shared/themes/library'

const owl = vi.hoisted(() => ({ on: new Set<string>(['watcher', 'night-falls']) }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => owl.on.has(id),
}))

afterEach(() => {
  cleanup()
  appearancePreview.reset()
  owl.on = new Set(['watcher', 'night-falls'])
})

async function open(settings: Partial<AppSettings> = {}) {
  const user = userEvent.setup()
  const update = vi.fn(async () => true)
  render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings } })} />)
  await selectCategory('Appearance')
  const section = document.querySelector('#settings-appearance') as HTMLElement
  return { user, update, section }
}

const split = (section: HTMLElement) => within(section).getByRole('switch', { name: 'A different theme when dark' })

describe('Settings > Appearance as a studio', () => {
  it('groups the page into the Theme, Details and Motion cards beside the preview', async () => {
    const { section } = await open()
    expect(within(section).getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
    expect(within(section).getByText('Theme, details & motion')).toBeVisible()
    for (const card of ['Theme', 'Details', 'Motion']) expect(within(section).getByRole('region', { name: card })).toBeInTheDocument()
    expect(within(section).getByRole('complementary', { name: 'Preview' })).toBeInTheDocument()
    // The preview comes first in reading order, so where the page is narrow and it stands on top, Tab meets it first.
    const preview = within(section).getByRole('complementary', { name: 'Preview' })
    expect(preview.compareDocumentPosition(within(section).getByRole('region', { name: 'Theme' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(section).queryByRole('combobox', { name: 'Theme' })).not.toBeInTheDocument()
  })

  it('shows one grid while both halves share a theme, and a press there uses the theme for both halves', async () => {
    const { user, update, section } = await open({ appearance: 'dark', lightTheme: 't3-code', darkTheme: 't3-code' })
    expect(split(section)).toHaveAttribute('aria-checked', 'false')
    const grid = within(section).getByRole('radiogroup', { name: 'Theme' })
    expect(within(grid).getByRole('radio', { name: 'Sotto' })).toHaveAttribute('aria-checked', 'true')
    expect(within(section).queryByRole('radiogroup', { name: 'Light theme' })).not.toBeInTheDocument()
    await user.click(within(grid).getByRole('radio', { name: 'Hush' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ lightTheme: 'hush', darkTheme: 'hush' }))
  })

  it('starts split when the saved halves differ, chooses each half on its own, and on turning off gives the dark half the light theme', async () => {
    const { user, update, section } = await open({ appearance: 'light', lightTheme: 'citrine', darkTheme: 'hush' })
    expect(split(section)).toHaveAttribute('aria-checked', 'true')
    const light = within(section).getByRole('radiogroup', { name: 'Light theme' })
    const dark = within(section).getByRole('radiogroup', { name: 'Dark theme' })
    expect(within(light).getByRole('radio', { name: 'Citrine' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dark).getByRole('radio', { name: 'Hush' })).toHaveAttribute('aria-checked', 'true')
    expect(light).toHaveAccessibleDescription('Painting the window now.')

    await user.click(within(section).getByRole('radiogroup', { name: 'Color scheme' }).querySelector<HTMLElement>('[role="radio"]:nth-child(2)')!)
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: 'system' }))
    await user.click(within(dark).getByRole('radio', { name: 'Sotto' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ darkTheme: 't3-code' }))

    await user.click(split(section))
    expect(within(section).getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument()
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ darkTheme: 'citrine' }))
  })

  it('reaches the scheme and the tiles by keyboard, one Tab stop per group, choosing as the arrows move', async () => {
    const { user, update, section } = await open()
    const scheme = within(section).getByRole('radiogroup', { name: 'Color scheme' })
    const grid = within(section).getByRole('radiogroup', { name: 'Theme' })
    within(scheme).getByRole('radio', { name: 'Dark' }).focus()
    await user.keyboard('{Tab}')
    expect(within(grid).getByRole('radio', { name: 'Sotto' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(within(grid).getByRole('radio', { name: 'Hush' })).toHaveFocus()
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ lightTheme: 'hush', darkTheme: 'hush' }))
    await user.keyboard('{Tab}')
    expect(split(section)).toHaveFocus()
  })

  it('shows the other half in the preview alone, from its resolved colours, and saves nothing', async () => {
    const { user, update, section } = await open({ appearance: 'dark', lightTheme: 'hush', darkTheme: 'hush' })
    const window = section.querySelector<HTMLElement>('.appearance-preview__window')!
    expect(window).not.toHaveAttribute('data-theme-scope')
    expect(window).toHaveAccessibleName('Threads in Hush, dark')
    await user.click(within(within(section).getByRole('radiogroup', { name: 'Color scheme the preview shows' })).getByRole('radio', { name: 'Light' }))
    expect(window).toHaveAttribute('data-theme-scope', 'light')
    expect(window.style.getPropertyValue(themeColorVariable('canvas'))).toBe(resolveThemeFor({ lightTheme: 'hush', darkTheme: 'hush', customThemes: [] }, 'light').colors.canvas)
    expect(window).toHaveAccessibleName('Threads in Hush, light')
    expect(document.documentElement.style.getPropertyValue(themeColorVariable('canvas'))).not.toBe(window.style.getPropertyValue(themeColorVariable('canvas')))
    await user.click(within(within(section).getByRole('radiogroup', { name: 'Room the preview shows' })).getByRole('radio', { name: 'Watcher' }))
    expect(window).toHaveAccessibleName('Watcher in Hush, light')
    expect(update).not.toHaveBeenCalled()
  })

  it('offers no Watcher room in the preview where Watcher is held back', async () => {
    owl.on = new Set()
    const { section } = await open()
    expect(within(section).queryByRole('radiogroup', { name: 'Room the preview shows' })).not.toBeInTheDocument()
  })

  it('saves reduced motion and night falls from the Motion card, through Settings’ own saves', async () => {
    const { user, update, section } = await open()
    const motion = within(section).getByRole('region', { name: 'Motion' })
    await user.selectOptions(within(motion).getByRole('combobox', { name: 'Reduced motion' }), 'on')
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
    await user.click(within(motion).getByRole('switch', { name: 'Night falls between Dictate or Threads and Watcher' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ roomTransition: false }))
    await user.click(within(motion).getByRole('radio', { name: 'Stars' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ roomTransitionLook: 'stars' }))
    const speed = within(motion).getByRole('slider', { name: 'Night falls speed' })
    fireEvent.change(speed, { target: { value: '1.5' } })
    fireEvent.pointerUp(speed)
    await waitFor(() => expect(update).toHaveBeenCalledWith({ roomTransitionSpeed: 1.5 }))
  })
})

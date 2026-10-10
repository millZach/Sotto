import { deferred, createBridge, openPage, renderApp } from '../../fixtures/renderer/appHarness'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { applyDocumentPreferences } from '../../../src/renderer/src/App'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

describe('Sotto application onboarding integration', () => {
  it('shows first-run onboarding and applies the motion preference and the chosen appearance, not the widget theme', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        theme: 'dark' as const,
        appearance: 'light' as const,
        lightTheme: 'tropic',
        reducedMotion: 'on' as const,
      })),
    })
    renderApp(bridge)

    await waitFor(() => expect(screen.getByRole('heading', { name: /talk to your computer and your coding agents/i })).toBeVisible())
    // The heading commits with the settings render; the preferences land in an
    // effect, so the attributes need their own wait.
    await waitFor(() => expect(document.documentElement.dataset.reducedMotion).toBe('on'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).toHaveAttribute('data-theme-id', 'tropic')
  })

  it('removes a forced motion attribute when following system motion', () => {
    document.documentElement.dataset.reducedMotion = 'on'
    applyDocumentPreferences({ ...DEFAULT_SETTINGS, reducedMotion: 'system' })
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-theme-id', 't3-code')
  })

  it.each(['light', 'dark', 'system'] as const)('paints an upgraded install dark whatever its persisted %s widget theme says', (theme) => {
    document.documentElement.dataset.theme = 'light'
    applyDocumentPreferences({ ...DEFAULT_SETTINGS, theme, reducedMotion: 'on' }, document.documentElement, false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
  })

  it('resolves system appearance against the operating system scheme and follows it live', async () => {
    const listeners = new Set<() => void>()
    const query = { matches: false, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
    vi.stubGlobal('matchMedia', vi.fn((media: string) => media === '(prefers-color-scheme: dark)' ? query : { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
    try {
      renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'system' as const, lightTheme: 'hush', darkTheme: 'citrine' })) }))
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'))
      expect(document.documentElement).toHaveAttribute('data-theme-id', 'hush')
      act(() => {
        query.matches = true
        for (const listener of listeners) listener()
      })
      // The system change hands the window to the independently chosen dark half.
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
      expect(document.documentElement).toHaveAttribute('data-theme-id', 'citrine')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('previews Light and then a light theme together while both saves are delayed, and never repaints an older choice', async () => {
    const user = userEvent.setup()
    const saves: Array<{ patch: Partial<AppSettings>; result: ReturnType<typeof deferred<AppSettings>> }> = []
    let persisted: AppSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true }
    const bridge = createBridge({
      getSettings: vi.fn(async () => persisted),
      updateSettings: vi.fn((patch) => {
        const result = deferred<AppSettings>()
        saves.push({ patch, result })
        return result.promise
      }),
    })
    renderApp(bridge)
    await openPage('home')
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const root = document.documentElement

    await user.click(screen.getByRole('tab', { name: 'Appearance' }))
    const lightHalf = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Light theme' })
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    await user.click(within(lightHalf()).getByRole('radio', { name: 'Citrine' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-theme-id', 'citrine')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    expect(within(lightHalf()).getByRole('radio', { name: 'Citrine' })).toHaveAttribute('aria-checked', 'true')
    // Only the light half moved: the dark half still belongs to Sotto.
    expect(within(screen.getByRole('radiogroup', { name: 'Dark theme' })).getByRole('radio', { name: 'Sotto' })).toHaveAttribute('aria-checked', 'true')

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.patch).toEqual({ appearance: 'light' })
    persisted = { ...persisted, appearance: 'light' }
    await act(async () => { saves[0]!.result.resolve(persisted) })
    expect(root).toHaveAttribute('data-theme-id', 'citrine')

    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]!.patch).toEqual({ lightTheme: 'citrine' })
    persisted = { ...persisted, lightTheme: 'citrine' }
    await act(async () => { saves[1]!.result.resolve(persisted) })
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-theme-id', 'citrine')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    expect(within(lightHalf()).getByRole('radio', { name: 'Citrine' })).toHaveAttribute('aria-checked', 'true')
  })

  it('restores the truthful persisted look when the final overlapping appearance save fails', async () => {
    const user = userEvent.setup()
    const saves: Array<ReturnType<typeof deferred<AppSettings>>> = []
    let persisted: AppSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true }
    renderApp(createBridge({
      getSettings: vi.fn(async () => persisted),
      updateSettings: vi.fn(() => {
        const result = deferred<AppSettings>()
        saves.push(result)
        return result.promise
      }),
    }))
    await openPage('home')
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme-id', 't3-code'))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const root = document.documentElement

    await user.click(screen.getByRole('tab', { name: 'Appearance' }))
    const lightHalf = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Light theme' })
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    await user.click(within(lightHalf()).getByRole('radio', { name: 'Tropic' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-theme-id', 'tropic')

    await waitFor(() => expect(saves).toHaveLength(1))
    persisted = { ...persisted, appearance: 'light' }
    await act(async () => { saves[0]!.resolve(persisted) })
    await waitFor(() => expect(saves).toHaveLength(2))
    await act(async () => { saves[1]!.reject(new Error('disk full')) })

    await waitFor(() => expect(root).toHaveAttribute('data-theme-id', 't3-code'))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(within(lightHalf()).getByRole('radio', { name: 'Sotto' })).toHaveAttribute('aria-checked', 'true')
    expect(document.body).toHaveTextContent(/could not be saved/i)
  })

  it('paints the next launch from the last applied look before settings answer', async () => {
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'light' as const, lightTheme: 'linen', glassOpacity: 55 })) }))
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme-id', 'linen'))
    expect(document.documentElement.style.getPropertyValue('--theme-glass-opacity')).toBe('55%')
    const { readCachedAppearance } = await import('../../../src/renderer/src/state/appearance')
    expect(readCachedAppearance()).toMatchObject({ appearance: 'light', lightTheme: 'linen', darkTheme: 't3-code', glassOpacity: 55 })
    localStorage.setItem('sotto.appearance', '{"appearance":"sepia","lightTheme":"linen","accent":"green"}')
    expect(readCachedAppearance()).toMatchObject({ appearance: 'dark', lightTheme: 'linen' })
    expect(readCachedAppearance()).not.toHaveProperty('accent')
    localStorage.setItem('sotto.appearance', 'not json')
    expect(readCachedAppearance()).toMatchObject({ appearance: 'dark', lightTheme: 't3-code', darkTheme: 't3-code' })
  })
})

// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { OmarchyThemeMonitor, initializeOmarchySelection } from '../../../src/main/themes/omarchy'
import { SettingsRepository } from '../../../src/main/storage/settingsRepository'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { parseOmarchyTheme } from '../../../src/shared/themes/omarchy'
import fixtures from '../../fixtures/omarchy-themes.json'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, watch: vi.fn(actual.watch), openSync: vi.fn(actual.openSync) }
})
const root = join(process.cwd(), 'artifacts/omarchy-theme/unit')
mkdirSync(root, { recursive: true })
const owned: string[] = []
const monitors: OmarchyThemeMonitor[] = []
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.dispose(); for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); vi.clearAllMocks() })
function home(): string { const path = mkdtempSync(join(root, 'home-')); owned.push(path); return path }
function render(home: string, slug: keyof typeof fixtures.themes): void {
  const current = join(home, '.local/state/omarchy/current')
  mkdirSync(join(current, 'next-theme'), { recursive: true })
  writeFileSync(join(current, 'next-theme/sotto.json'), JSON.stringify(fixtures.themes[slug].rendered))
  rmSync(join(current, 'theme'), { recursive: true, force: true })
  renameSync(join(current, 'next-theme'), join(current, 'theme'))
  writeFileSync(join(current, 'theme.name'), slug)
}
function monitor(home: string, platform: 'linux' | 'darwin' | 'win32' = 'linux') {
  const changed = vi.fn(), log = vi.fn()
  const theme = new OmarchyThemeMonitor(platform, home, changed, log)
  monitors.push(theme)
  return { theme, changed, log }
}

describe('Linux Omarchy theme reader', () => {
  it('selects Omarchy only for a fresh Linux profile with a valid palette', async () => {
    const theme = parseOmarchyTheme(fixtures.themes['tokyo-night'].rendered)
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      for (const exists of [false, true]) {
        const repository = { exists: vi.fn(async () => exists), update: vi.fn(async () => DEFAULT_SETTINGS) }
        await initializeOmarchySelection(platform, theme, repository)
        expect(repository.update).toHaveBeenCalledTimes(platform === 'linux' && !exists ? 1 : 0)
        if (platform === 'linux' && !exists) expect(repository.update).toHaveBeenCalledWith({ appearance:'system', lightTheme:'omarchy', darkTheme:'omarchy' })
      }
    }
    const repository = { exists: vi.fn(async () => false), update: vi.fn(async () => DEFAULT_SETTINGS) }
    await initializeOmarchySelection('linux', null, repository)
    expect(repository.update).not.toHaveBeenCalled()
  })
  it('survives successive directory and file replacements, falls back, and recovers', async () => {
    const directory = home()
    render(directory, 'tokyo-night')
    const { theme, changed, log } = monitor(directory)
    expect(theme.load()?.sourceName).toBe('Tokyo Night')
    theme.start()
    for (const slug of ['catppuccin-latte', 'rose-pine', 'hackerman'] as const) {
      render(directory, slug)
      await vi.waitFor(() => expect(theme.get()?.appearance).toBe(fixtures.themes[slug].rendered.appearance))
      await vi.waitFor(() => expect(theme.get()?.sourceName).toBe(slug.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ')))
    }
    writeFileSync(theme.path, '{broken')
    await vi.waitFor(() => expect(theme.get()).toBeNull())
    expect(log).toHaveBeenCalledWith('omarchy-theme-invalid')
    rmSync(theme.path)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('omarchy-theme-missing'))
    render(directory, 'tokyo-night')
    await vi.waitFor(() => expect(theme.get()?.sourceName).toBe('Tokyo Night'))
    expect(changed).toHaveBeenCalledTimes(5)
    theme.dispose()
    render(directory, 'rose-pine')
    expect(theme.get()?.sourceName).toBe('Tokyo Night')
  })
  it('finds an installation made after starting with no Omarchy folders', async () => {
    const directory = home(), { theme, log } = monitor(directory)
    expect(theme.load()).toBeNull()
    theme.start()
    expect(log).toHaveBeenCalledExactlyOnceWith('omarchy-theme-missing')
    render(directory, 'tokyo-night')
    await vi.waitFor(() => expect(theme.get()?.sourceName).toBe('Tokyo Night'))
  })
  it('refuses oversized or unresolved files without logging their contents', () => {
    const directory = home()
    render(directory, 'tokyo-night')
    const { theme, log } = monitor(directory)
    writeFileSync(theme.path, 'secret {{ foreground }}'.repeat(4000))
    expect(theme.load()).toBeNull()
    expect(log.mock.calls).toEqual([['omarchy-theme-invalid']])
  })
  it.each(['win32', 'darwin'] as const)('%s performs no file reads or watching, even with a rendered file present', (platform) => {
    const directory = home()
    render(directory, 'tokyo-night')
    vi.clearAllMocks()
    const { theme, log } = monitor(directory, platform)
    expect(theme.load()).toBeNull()
    theme.start()
    expect(fs.watch).not.toHaveBeenCalled()
    expect(fs.openSync).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
  it('projects live palettes through settings reads and saves only the selection', async () => {
    const directory = home()
    render(directory, 'tokyo-night')
    const { theme } = monitor(directory)
    theme.load()
    const path = join(directory, 'settings.json')
    const repository = new SettingsRepository(path, { omarchyTheme: () => theme.get() })
    await repository.update({ lightTheme: 'omarchy', darkTheme: 'omarchy', appearance: 'system' })
    expect((await repository.get()).omarchyTheme?.sourceName).toBe('Tokyo Night')
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('omarchyTheme')
    expect((await repository.update({ glassOpacity: 85 })).darkTheme).toBe('omarchy')
    const reopened = new SettingsRepository(path, { omarchyTheme: () => null })
    expect(await reopened.get()).toMatchObject({ lightTheme:'omarchy', darkTheme:'omarchy', omarchyTheme:null })
    const nonLinux = new SettingsRepository(path)
    expect((await nonLinux.get()).darkTheme).toBe(DEFAULT_SETTINGS.darkTheme)
  })
})

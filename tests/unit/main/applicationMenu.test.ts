// @vitest-environment node
import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  buildApplicationMenuTemplate,
  type ApplicationMenuItem,
} from '../../../src/main/app/applicationMenu'

function template(
  overrides: Partial<Parameters<typeof buildApplicationMenuTemplate>[0]> = {},
): ApplicationMenuItem[] {
  return buildApplicationMenuTemplate({
    platform: 'darwin',
    appName: 'Sotto',
    includeDeveloperTools: false,
    onShowSettings: () => undefined,
    onCheckForUpdates: () => undefined,
    ...overrides,
  })
}

function darwinTemplate(
  overrides: Partial<Parameters<typeof buildApplicationMenuTemplate>[0]> = {},
): ApplicationMenuItem[] {
  return template({ ...overrides, platform: 'darwin' })
}

function submenu(items: ApplicationMenuItem[], label: string): ApplicationMenuItem[] {
  const menu = items.find((item) => item.label === label)
  if (menu?.submenu === undefined) throw new Error(`No ${label} menu`)
  return menu.submenu
}

function entries(items: ApplicationMenuItem[]): string[] {
  return items.map((item) => item.role ?? item.type ?? item.label ?? '')
}

describe('buildApplicationMenuTemplate', () => {
  describe.each(['win32', 'linux'] as const)('on %s (#1825)', (platform) => {
    it('carries Settings, Close and zoom alone in a packaged build, so no browser key reaches it', () => {
      const items = template({ platform, includeDeveloperTools: false, onShowTurnRecords: () => undefined })
      expect(items.map((item) => item.label)).toEqual(['Sotto', 'View'])
      expect(entries(submenu(items, 'Sotto'))).toEqual(['Settings…', 'separator', 'close'])
      expect(entries(submenu(items, 'View'))).toEqual(['resetZoom', 'zoomIn', 'zoomOut'])
      const roles = JSON.stringify(items)
      for (const role of ['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']) expect(roles).not.toContain(`"${role}"`)
    })

    it('adds reload and developer tools only with the option the Mac menu follows', () => {
      expect(entries(submenu(template({ platform, includeDeveloperTools: true }), 'View'))).toEqual([
        'reload',
        'toggleDevTools',
        'separator',
        'resetZoom',
        'zoomIn',
        'zoomOut',
      ])
    })

    it('opens Settings on Ctrl+, through the same callback as the Mac’s Cmd+,', () => {
      const onShowSettings = vi.fn()
      const settings = submenu(template({ platform, onShowSettings }), 'Sotto').find((item) => item.label === 'Settings…')
      expect(settings?.accelerator).toBe('Control+,')
      settings?.click?.()
      expect(onShowSettings).toHaveBeenCalledTimes(1)
    })

    it('leaves the update check to the tray', () => {
      expect(JSON.stringify(template({ platform }))).not.toContain('Check for Updates')
    })
  })

  it('names the top-level macOS menus after the app', () => {
    expect(darwinTemplate({ appName: 'Sotto' }).map((item) => item.label)).toEqual([
      'Sotto',
      'Edit',
      'View',
      'Window',
    ])
  })

  it('leaves out the update check where Sotto cannot update itself', () => {
    const items = buildApplicationMenuTemplate({
      platform: 'darwin',
      appName: 'Sotto',
      includeDeveloperTools: false,
      onShowSettings: () => undefined,
    })
    expect(entries(submenu(items ?? [], 'Sotto'))).toEqual([
      'about',
      'separator',
      'Settings…',
      'separator',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ])
  })

  it('offers updates, settings, hiding and quitting from the app menu', () => {
    expect(entries(submenu(darwinTemplate(), 'Sotto'))).toEqual([
      'about',
      'Check for Updates…',
      'separator',
      'Settings…',
      'separator',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ])
  })

  it('opens settings from the standard macOS shortcut', () => {
    const onShowSettings = vi.fn()
    const settings = submenu(darwinTemplate({ onShowSettings }), 'Sotto').find(
      (item) => item.label === 'Settings…',
    )

    expect(settings?.accelerator).toBe('Command+,')

    settings?.click?.()

    expect(onShowSettings).toHaveBeenCalledTimes(1)
  })

  it('asks for an update check from the app menu', () => {
    const onCheckForUpdates = vi.fn()
    submenu(darwinTemplate({ onCheckForUpdates }), 'Sotto')
      .find((item) => item.label === 'Check for Updates…')
      ?.click?.()

    expect(onCheckForUpdates).toHaveBeenCalledTimes(1)
  })

  it('carries the edit roles that drive clipboard shortcuts in text fields', () => {
    expect(entries(submenu(darwinTemplate(), 'Edit'))).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
    ])
  })

  it('carries the standard window roles', () => {
    expect(entries(submenu(darwinTemplate(), 'Window'))).toEqual([
      'minimize',
      'zoom',
      'close',
      'front',
    ])
  })

  it('zooms and enters full screen from the View menu in a packaged build', () => {
    expect(entries(submenu(darwinTemplate({ includeDeveloperTools: false }), 'View'))).toEqual([
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ])
  })

  it('adds reload and developer tools to the View menu only when developer tools are included', () => {
    expect(entries(submenu(darwinTemplate({ includeDeveloperTools: true }), 'View'))).toEqual([
      'reload',
      'toggleDevTools',
      'separator',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ])
  })

  it('builds an independent template on every call', () => {
    const onShowSettings = vi.fn()
    const onCheckForUpdates = vi.fn()
    const first = darwinTemplate({ onShowSettings, onCheckForUpdates })
    const second = darwinTemplate({ onShowSettings, onCheckForUpdates })

    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first).toEqual(second)
  })

  it('produces a template Electron accepts as menu options', () => {
    const electronTemplate: MenuItemConstructorOptions[] = darwinTemplate({
      includeDeveloperTools: true,
    })

    expect(electronTemplate).toHaveLength(4)
  })

  it('adds a developer command that reveals recent turn records', () => {
    const onShowTurnRecords = vi.fn()
    const view = submenu(
      darwinTemplate({ includeDeveloperTools: true, onShowTurnRecords }),
      'View',
    )

    expect(entries(view)).toEqual([
      'reload',
      'toggleDevTools',
      'separator',
      'Show recent turn records',
      'separator',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ])

    view.find((item) => item.label === 'Show recent turn records')?.click?.()

    expect(onShowTurnRecords).toHaveBeenCalledTimes(1)
  })
})

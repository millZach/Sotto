import { t } from '@lingui/core/macro'

import type { SottoPlatform } from '../../shared/platform'

/**
 * The roles this application menu uses. Every value is an Electron menu role, so
 * the template stays assignment-compatible with MenuItemConstructorOptions
 * without importing electron into this pure builder.
 */
export type ApplicationMenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'delete'
  | 'selectAll'
  | 'reload'
  | 'toggleDevTools'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'togglefullscreen'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'front'

export interface ApplicationMenuItem {
  readonly role?: ApplicationMenuRole
  readonly type?: 'separator'
  readonly label?: string
  readonly accelerator?: string
  readonly click?: () => void
  // Mutable so the template can be handed straight to Menu.buildFromTemplate,
  // which does not accept readonly arrays.
  readonly submenu?: ApplicationMenuItem[]
}

export interface ApplicationMenuTemplateOptions {
  readonly platform: SottoPlatform
  readonly appName: string
  readonly includeDeveloperTools: boolean
  readonly onShowSettings: () => void
  /** Left out where Sotto cannot update itself, which drops the menu command. */
  readonly onCheckForUpdates?: () => void
  readonly onShowTurnRecords?: () => void
}

function separator(): ApplicationMenuItem {
  return { type: 'separator' }
}

function appMenu(
  appName: string,
  onShowSettings: () => void,
  onCheckForUpdates: (() => void) | undefined,
): ApplicationMenuItem {
  return {
    label: appName,
    submenu: [
      { role: 'about' },
      ...(onCheckForUpdates ? [{ label: t`Check for Updates…`, click: onCheckForUpdates }] : []),
      separator(),
      { label: t`Settings…`, accelerator: 'Command+,', click: onShowSettings },
      separator(),
      { role: 'services' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      separator(),
      { role: 'quit' },
    ],
  }
}

// Without these roles macOS delivers no ⌘C/⌘V/⌘A to Sotto's own text fields.
function editMenu(): ApplicationMenuItem {
  return {
    label: t`Edit`,
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      separator(),
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  }
}

// A packaged build's View menu is zoom alone, with full screen on a Mac. Reload and developer tools come only with
// `includeDeveloperTools`, which main sets for an unpackaged run, so no browser key reaches a shipped build.
function viewMenu(includeDeveloperTools: boolean, fullScreen: boolean, onShowTurnRecords?: () => void): ApplicationMenuItem {
  return {
    label: t`View`,
    submenu: [
      ...(includeDeveloperTools
        ? [
            { role: 'reload' as const },
            { role: 'toggleDevTools' as const },
            ...(onShowTurnRecords
              ? [separator(), { label: t`Show recent turn records`, click: onShowTurnRecords }]
              : []),
            separator(),
          ]
        : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      ...(fullScreen ? [separator(), { role: 'togglefullscreen' as const }] : []),
    ],
  }
}

function windowMenu(): ApplicationMenuItem {
  return {
    label: t`Window`,
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { role: 'close' },
      { role: 'front' },
    ],
  }
}

/**
 * Windows and Linux: a menu the frameless window never shows, there only for its keys (#1825). Electron's default
 * menu, kept until then, answered Ctrl+R, Ctrl+Shift+R and Ctrl+Shift+I in a shipped build. This one keeps the zoom
 * keys and Close on Ctrl+W, adds Settings on Ctrl+, as the Mac has it on Cmd+, and gives developer tools only to the
 * same option the Mac's menu follows. Edit roles are left out: Chromium answers a text field's own keys off a Mac.
 */
function hiddenMenu(options: ApplicationMenuTemplateOptions): ApplicationMenuItem[] {
  return [
    {
      label: options.appName,
      submenu: [
        { label: t`Settings…`, accelerator: 'Control+,', click: options.onShowSettings },
        separator(),
        { role: 'close' },
      ],
    },
    viewMenu(options.includeDeveloperTools, false),
  ]
}

/**
 * Builds the application menu in the interface language shown now; main builds it again when that changes
 * (ADR-0123). Role items take their words from Electron and the system, and the first menu keeps the app's name.
 * A Mac shows its menu; Windows and Linux get one only for its keys.
 */
export function buildApplicationMenuTemplate(options: ApplicationMenuTemplateOptions): ApplicationMenuItem[] {
  if (options.platform !== 'darwin') return hiddenMenu(options)
  return [
    appMenu(options.appName, options.onShowSettings, options.onCheckForUpdates),
    editMenu(),
    viewMenu(options.includeDeveloperTools, true, options.onShowTurnRecords),
    windowMenu(),
  ]
}

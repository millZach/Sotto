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
      ...(onCheckForUpdates ? [{ label: 'Check for Updates…', click: onCheckForUpdates }] : []),
      separator(),
      { label: 'Settings…', accelerator: 'Command+,', click: onShowSettings },
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
    label: 'Edit',
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

// Zoom and full screen match the View menu Electron gives the Windows build by default.
function viewMenu(includeDeveloperTools: boolean, onShowTurnRecords?: () => void): ApplicationMenuItem {
  return {
    label: 'View',
    submenu: [
      ...(includeDeveloperTools
        ? [
            { role: 'reload' as const },
            { role: 'toggleDevTools' as const },
            ...(onShowTurnRecords
              ? [separator(), { label: 'Show recent turn records', click: onShowTurnRecords }]
              : []),
            separator(),
          ]
        : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      separator(),
      { role: 'togglefullscreen' },
    ],
  }
}

function windowMenu(): ApplicationMenuItem {
  return {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { role: 'close' },
      { role: 'front' },
    ],
  }
}

/**
 * Builds the application menu template for a platform. Windows returns null:
 * the app ships without an application menu today and the caller installs null.
 */
export function buildApplicationMenuTemplate(
  options: ApplicationMenuTemplateOptions,
): ApplicationMenuItem[] | null {
  if (options.platform !== 'darwin') {
    return null
  }

  return [
    appMenu(options.appName, options.onShowSettings, options.onCheckForUpdates),
    editMenu(),
    viewMenu(options.includeDeveloperTools, options.onShowTurnRecords),
    windowMenu(),
  ]
}

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
}

function separator(): ApplicationMenuItem {
  return { type: 'separator' }
}

function appMenu(
  appName: string,
  onShowSettings: () => void,
): ApplicationMenuItem {
  return {
    label: appName,
    submenu: [
      { role: 'about' },
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

function viewMenu(): ApplicationMenuItem {
  return {
    label: 'View',
    submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
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
    appMenu(options.appName, options.onShowSettings),
    editMenu(),
    ...(options.includeDeveloperTools ? [viewMenu()] : []),
    windowMenu(),
  ]
}

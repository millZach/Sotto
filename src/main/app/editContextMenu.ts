import type { ApplicationMenuRole } from './applicationMenu'

/**
 * What a right-click reports about where it landed: the parts of Electron's `ContextMenuParams` the menu reads, so
 * this builder stays free of electron.
 */
export interface EditContextMenuParams {
  readonly isEditable: boolean
  readonly selectionText: string
  readonly editFlags: {
    readonly canUndo: boolean
    readonly canRedo: boolean
    readonly canCut: boolean
    readonly canCopy: boolean
    readonly canPaste: boolean
    readonly canSelectAll: boolean
  }
}

type EditRole = Extract<ApplicationMenuRole, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'>

export interface EditContextMenuItem {
  readonly role?: EditRole
  readonly type?: 'separator'
  readonly enabled?: boolean
}

/**
 * The menu a right-click in Sotto's own windows opens (#1821): a text field's Undo, Redo, Cut, Copy, Paste and Select
 * All, each greyed when it has nothing to act on, and Copy for words selected anywhere else. Null leaves the click
 * alone. Role items take their words from Electron and the system, as the application menu's do (ADR-0123). The
 * window's own menus, a reply's copy button, a link and an image, cancel the page's event, and Electron then reports
 * no right-click here at all.
 */
export function editContextMenuTemplate(params: EditContextMenuParams): EditContextMenuItem[] | null {
  const flags = params.editFlags
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll },
    ]
  }
  if (params.selectionText.trim() !== '') return [{ role: 'copy', enabled: flags.canCopy }]
  return null
}

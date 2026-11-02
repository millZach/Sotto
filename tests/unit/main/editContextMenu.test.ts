// @vitest-environment node
import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'

import { editContextMenuTemplate, type EditContextMenuParams } from '../../../src/main/app/editContextMenu'

const none = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false }

function params(overrides: Partial<EditContextMenuParams> & { readonly flags?: Partial<EditContextMenuParams['editFlags']> } = {}): EditContextMenuParams {
  return { isEditable: false, selectionText: '', ...overrides, editFlags: { ...none, ...overrides.flags } }
}

const shown = (items: ReturnType<typeof editContextMenuTemplate>): string[] => (items ?? []).map(item => item.role ?? item.type ?? '')

describe('editContextMenuTemplate (#1821)', () => {
  it('gives a text field Undo, Redo, Cut, Copy, Paste and Select All, greyed where they have nothing to act on', () => {
    const items = editContextMenuTemplate(params({ isEditable: true, flags: { canPaste: true, canSelectAll: true } }))
    expect(shown(items)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    expect(items?.filter(item => item.role !== undefined).map(item => [item.role, item.enabled])).toEqual([
      ['undo', false], ['redo', false], ['cut', false], ['copy', false], ['paste', true], ['selectAll', true],
    ])
  })

  it('keeps the field’s menu whole when words in it are selected', () => {
    const items = editContextMenuTemplate(params({ isEditable: true, selectionText: 'hello', flags: { canCut: true, canCopy: true, canUndo: true } }))
    expect(shown(items)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    expect(items?.find(item => item.role === 'cut')?.enabled).toBe(true)
  })

  it('offers Copy alone for words selected in text that cannot be edited', () => {
    expect(editContextMenuTemplate(params({ selectionText: 'Found the cause.', flags: { canCopy: true } }))).toEqual([{ role: 'copy', enabled: true }])
  })

  it('leaves a right-click on anything else alone', () => {
    expect(editContextMenuTemplate(params())).toBeNull()
    expect(editContextMenuTemplate(params({ selectionText: '  \n' }))).toBeNull()
  })

  it('produces a template Electron accepts as menu options', () => {
    const template: MenuItemConstructorOptions[] = editContextMenuTemplate(params({ isEditable: true }))!
    expect(template).toHaveLength(8)
  })
})

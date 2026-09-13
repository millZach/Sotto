import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_EDITOR_MIN_SIZE, THEME_EDITOR_ROLE_GROUPS, ThemeEditorHost, themeEditorColorFamily } from '../../../src/renderer/src/features/settings/themes/ThemeEditor'
import { closeThemeEditor, openThemeEditor } from '../../../src/renderer/src/features/settings/themes/themeEditorSession'
import { changedPaintKinds, creditedRole } from '../../../src/renderer/src/features/settings/themes/themeInspector'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { THEME_COLOR_ROLES } from '../../../src/shared/themes/library'

// jsdom cannot resolve custom properties into painted colours, so the probes
// are stood in for here; tests/e2e/phase-three-themes.spec.ts runs them for real.
const probe = vi.hoisted(() => ({ role: 'sidebarRowHover' as string | null, uses: 3 }))
vi.mock('../../../src/renderer/src/features/settings/themes/themeInspector', async (original) => {
  const actual = await original<typeof import('../../../src/renderer/src/features/settings/themes/themeInspector')>()
  return {
    ...actual,
    inspectThemeRoleAtElement: vi.fn((element: Element) => (probe.role === null || element.closest('[data-theme-editor-panel]') ? null : { element, role: probe.role })),
    highlightThemeRoleUsage: vi.fn(() => probe.uses),
  }
})

afterEach(() => {
  act(() => closeThemeEditor())
  cleanup()
})

describe('theme inspector rules', () => {
  it('can reveal every theme role in an editor row', () => {
    const rows = new Set(THEME_EDITOR_ROLE_GROUPS.flatMap(group => group.families.map(family => family.role)))
    for (const role of THEME_COLOR_ROLES) expect(rows.has(themeEditorColorFamily(role)?.role as never), role).toBe(true)
    expect(themeEditorColorFamily('sidebarRowActive')?.label).toBe('Sidebar selection')
  })

  it('credits the ink, not the background its contrast mixes in, and compares each paint separately', () => {
    expect(creditedRole(['canvas', 'text'])).toBe('text')
    expect(creditedRole(['canvas'])).toBe('canvas')
    expect(creditedRole([])).toBeNull()
    const before = { background: 'rgb(1, 2, 3)', border: '', foreground: 'rgb(4, 5, 6)' }
    expect(changedPaintKinds(before, { ...before, foreground: 'rgb(1, 254, 167)' })).toEqual(['foreground'])
  })
})

describe('theme editor inspector and resizing', () => {
  let pageClicks = 0
  const scrolled: Element[] = []

  beforeEach(() => {
    scrolled.length = 0
    // jsdom has no layout, so no scrollIntoView; record what the pick reveals.
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this) }
    probe.role = 'sidebarRowHover'
    probe.uses = 3
    pageClicks = 0
  })

  function renderEditor() {
    const settings: AppSettings = { ...DEFAULT_SETTINGS }
    render(
      <>
        <button type="button" onClick={() => { pageClicks += 1 }}>Page action</button>
        <ThemeEditorHost settings={settings} onSave={vi.fn(async () => true)} getSettings={() => settings} />
      </>,
    )
    act(() => openThemeEditor({ editingThemeId: null, seedThemeId: 'ocean', seedName: null, initialAppearance: 'dark' }))
    return screen.getByRole('dialog', { name: 'Create theme' })
  }

  it('picks a colour from the page without pressing it, opens its row and spotlights its uses', async () => {
    const user = userEvent.setup()
    const dialog = renderEditor()
    const inspect = screen.getByRole('button', { name: 'Inspect app colors' })
    await user.click(inspect)
    expect(screen.getByRole('button', { name: 'Cancel inspecting app colors' })).toHaveAttribute('aria-pressed', 'true')
    expect(dialog).toHaveTextContent('Select an element · Esc to cancel')

    await user.click(screen.getByRole('button', { name: 'Page action' }))
    expect(pageClicks).toBe(0)
    // A family colour lives in Advanced, so the pick opens it and marks the row.
    expect(screen.getByRole('switch', { name: 'Use advanced theme colors' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Hide where Sidebar selection is used' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(dialog).toHaveTextContent('Sidebar selection · 3 uses'))
    await waitFor(() => expect(scrolled.map(element => element.getAttribute('data-theme-color-role'))).toEqual(['sidebarRowSelected']))
    expect(screen.getByRole('button', { name: 'Inspect app colors' })).toHaveAttribute('aria-pressed', 'false')

    // Disarmed, the page is usable again while the spotlight stays.
    await user.click(screen.getByRole('button', { name: 'Page action' }))
    expect(pageClicks).toBe(1)
  })

  it('lets Escape cancel inspecting, then clear a spotlight, then close', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(screen.getByRole('button', { name: 'Inspect app colors' }))
    screen.getByRole('button', { name: 'Page action' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Inspect app colors' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('dialog', { name: 'Create theme' })).toBeVisible()

    // A colour's label is the other way to a spotlight.
    await user.click(screen.getByRole('button', { name: 'Show where Background is used' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Background · 3 uses'))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Show where Background is used' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('dialog')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps inspecting when the pointer lands on nothing a theme paints', async () => {
    const user = userEvent.setup()
    probe.role = null
    renderEditor()
    await user.click(screen.getByRole('button', { name: 'Inspect app colors' }))
    await user.click(screen.getByRole('button', { name: 'Page action' }))
    expect(pageClicks).toBe(0)
    expect(screen.getByRole('button', { name: 'Cancel inspecting app colors' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('resizes from the corner grip within its minimum and the window', () => {
    const dialog = renderEditor()
    const grip = dialog.querySelector('.theme-editor__grip')!
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(grip, { clientX: 120, clientY: 110, pointerId: 1 })
    expect(dialog.style.width).toBe(`${THEME_EDITOR_MIN_SIZE.width}px`)
    expect(dialog.style.height).toBe(`${THEME_EDITOR_MIN_SIZE.height}px`)
    fireEvent.pointerMove(grip, { clientX: 5000, clientY: 5000, pointerId: 1 })
    expect(dialog.style.width).toBe(`${window.innerWidth - 8}px`)
    expect(dialog.style.height).toBe(`${window.innerHeight - 8}px`)
    fireEvent.pointerUp(grip, { pointerId: 1 })
    fireEvent.pointerMove(grip, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(dialog.style.width).toBe(`${window.innerWidth - 8}px`)

    // Minimized, the panel hugs its header whatever size was chosen.
    fireEvent.click(screen.getByRole('button', { name: 'Minimize the theme editor' }))
    expect(dialog.style.height).toBe('')
  })
})

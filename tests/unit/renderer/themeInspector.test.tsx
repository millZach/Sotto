import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_EDITOR_MIN_SIZE, THEME_EDITOR_ROLE_GROUPS, ThemeEditorHost, themeEditorColorFamily } from '../../../src/renderer/src/features/settings/themes/ThemeEditor'
import { closeThemeEditor, openThemeEditor } from '../../../src/renderer/src/features/settings/themes/themeEditorSession'
import * as inspector from '../../../src/renderer/src/features/settings/themes/themeInspector'
import { changedPaintKinds, creditedRole } from '../../../src/renderer/src/features/settings/themes/themeInspector'
import { useDiagramPalette } from '../../../src/renderer/src/agents/diagrams/diagramPalette'
import { THEME_TOKEN_PROBE_ATTRIBUTE } from '../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { THEME_COLOR_ROLES } from '../../../src/shared/themes/library'

// jsdom cannot resolve custom properties into painted colours, so the probes
// are stood in for here; tests/e2e/phase-three-themes.spec.ts runs them for real.
const probe = vi.hoisted(() => ({ role: 'sidebarRowHover' as string | null, uses: 3, real: false }))
vi.mock('../../../src/renderer/src/features/settings/themes/themeInspector', async (original) => {
  const actual = await original<typeof import('../../../src/renderer/src/features/settings/themes/themeInspector')>()
  return {
    ...actual,
    inspectThemeRoleAtElement: vi.fn((element: Element) => (probe.role === null || element.closest('[data-theme-editor-panel]') ? null : { element, role: probe.role })),
    highlightThemeRoleUsage: vi.fn((roles: Parameters<typeof actual.highlightThemeRoleUsage>[0]) => (probe.real ? actual.highlightThemeRoleUsage(roles) : probe.uses)),
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

describe('the spotlight and colour readers do not wake each other', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const highlight = vi.mocked(inspector.highlightThemeRoleUsage)
  const wait = (ms: number) => act(() => new Promise<void>(resolve => { setTimeout(resolve, ms) }))

  beforeEach(() => {
    probe.real = true
    highlight.mockClear()
    // jsdom has no canvas; a stand-in lets the diagram palette add its hidden probe span as Chromium does.
    HTMLCanvasElement.prototype.getContext = (() => ({ clearRect() {}, fillRect() {}, fillStyle: '', getImageData: () => ({ data: [1, 2, 3, 255] }) })) as never
    // A resolved token that is not hex is what makes the palette paint it through a probe.
    document.documentElement.setAttribute('style', '--theme-canvas: #101418; --tt-code-bg: color-mix(in oklab, #101418 90%, white)')
  })

  afterEach(() => {
    probe.real = false
    HTMLCanvasElement.prototype.getContext = originalGetContext
    document.documentElement.removeAttribute('style')
    document.querySelectorAll('[data-test-page-change]').forEach(element => element.remove())
  })

  function DiagramReader() {
    const palette = useDiagramPalette()
    return <output aria-label="Diagram text">{palette.text}</output>
  }

  it('stays idle with a drawing on screen, yet refreshes once for a real page change', async () => {
    const user = userEvent.setup()
    const settings: AppSettings = { ...DEFAULT_SETTINGS }
    render(
      <>
        <DiagramReader />
        <ThemeEditorHost settings={settings} onSave={vi.fn(async () => true)} getSettings={() => settings} />
      </>,
    )
    act(() => openThemeEditor({ editingThemeId: null, seedThemeId: 'ocean', seedName: null, initialAppearance: 'dark' }))
    await user.click(screen.getByRole('button', { name: 'Show where Background is used' }))

    let probes = 0
    const counter = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.hasAttribute(THEME_TOKEN_PROBE_ATTRIBUTE)) probes += 1
    })
    counter.observe(document.body, { childList: true, subtree: true })
    await wait(100)
    const settled = highlight.mock.calls.length
    probes = 0
    // Before the fix each refresh's sentinels made the palette probe, whose span scheduled the next refresh.
    await wait(1300)
    expect(highlight.mock.calls.length).toBe(settled)
    expect(probes).toBe(0)

    // The inspector's own overlays and other readers' probes coming and going are not page changes.
    act(() => {
      const reader = document.createElement('span')
      reader.setAttribute(THEME_TOKEN_PROBE_ATTRIBUTE, '')
      document.body.append(reader)
      reader.remove()
      const spotlight = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      spotlight.id = 'theme-inspector-spotlight'
      document.body.append(spotlight)
      spotlight.remove()
    })
    await wait(700)
    expect(highlight.mock.calls.length).toBe(settled)

    // A streaming reply growing the page refreshes the count, once.
    act(() => {
      const reply = document.createElement('p')
      reply.setAttribute('data-test-page-change', '')
      document.body.append(reply)
    })
    await waitFor(() => expect(highlight.mock.calls.length).toBe(settled + 1), { timeout: 1500 })
    await wait(1100)
    expect(highlight.mock.calls.length).toBe(settled + 1)
    counter.disconnect()
  })

  it('reads the palette again when the theme really changes, not when a probe puts a colour back', async () => {
    render(<DiagramReader />)
    const root = document.documentElement
    const reads = vi.spyOn(window, 'getComputedStyle')
    await act(async () => {
      root.style.setProperty('--tt-text', '#01fea7', 'important')
      root.style.removeProperty('--tt-text')
    })
    expect(reads).not.toHaveBeenCalled()

    await act(async () => { root.style.setProperty('--tt-text', '#123456') })
    expect(screen.getByRole('status', { name: 'Diagram text' })).toHaveTextContent('#123456')
    reads.mockClear()
    await act(async () => { root.dataset.theme = 'light' })
    expect(reads).toHaveBeenCalled()
    reads.mockRestore()
    delete root.dataset.theme
  })
})

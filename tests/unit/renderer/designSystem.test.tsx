import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Button } from '../../../src/renderer/src/components/Button'
import { Field } from '../../../src/renderer/src/components/Field'
import { LevelMeter } from '../../../src/renderer/src/components/LevelMeter'
import { Select } from '../../../src/renderer/src/components/Select'
import { ShortcutKey } from '../../../src/renderer/src/components/ShortcutKey'
import { ToastRegion } from '../../../src/renderer/src/components/ToastRegion'
import { Toggle } from '../../../src/renderer/src/components/Toggle'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { MODES, THEME_IDS, contrast, over, resolveColor, rootDeclarations } from './themeTokenResolver'

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
const tokensCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8')
const onboardingSource = readFileSync(join(process.cwd(), 'src/renderer/src/features/onboarding/Onboarding.tsx'), 'utf8')

afterEach(cleanup)

describe('Sotto design-system primitives', () => {
  it('provides a 44px control and an explicit keyboard-focus treatment', () => {
    render(<Button>Continue</Button>)

    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).toHaveClass('tt-button')
    expect(button).toHaveClass('tt-focusable')
  })

  it('requires icon-only controls to have an accessible name', () => {
    render(
      <Button iconOnly aria-label="Close setup">
        Close
      </Button>,
    )

    expect(screen.getByRole('button', { name: 'Close setup' })).toBeVisible()
  })

  it('exposes toggle state and supports keyboard activation', async () => {
    const onChange = vi.fn()
    render(<Toggle label="Play sound cues" checked={false} onCheckedChange={onChange} />)

    const toggle = screen.getByRole('switch', { name: 'Play sound cues' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('keeps each toggle label and description in one vertical copy region', () => {
    const { container } = render(
      <Toggle
        label="Automatic paste"
        description="Paste into the application that had focus before recording started."
        checked
        onCheckedChange={() => undefined}
      />,
    )

    const copy = container.querySelector('.tt-toggle__copy')
    expect(copy).not.toBeNull()
    expect(copy?.children).toHaveLength(2)
    expect(copy?.querySelector('strong')).toHaveTextContent('Automatic paste')
    expect(copy?.querySelector('.tt-field__description')).toHaveTextContent('Paste into the application')
  })

  it('links field labels, descriptions, and errors to the control', () => {
    render(
      <Field
        label="Shortcut"
        description="Choose a system-wide shortcut."
        error="That shortcut is already in use."
      >
        <input />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Shortcut' })
    expect(input).toHaveAccessibleDescription(
      'Choose a system-wide shortcut. That shortcut is already in use.',
    )
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('clamps and names microphone activity without relying on animation', () => {
    render(<LevelMeter value={2} label="Microphone activity" />)

    expect(screen.getByRole('meter', { name: 'Microphone activity' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    )
  })

  it('keeps native select semantics and supports labelled keyboard use', async () => {
    render(
      <Field label="Theme">
        <Select defaultValue="system">
          <option value="system">System</option>
          <option value="dark">Dark</option>
        </Select>
      </Field>,
    )

    const select = screen.getByRole('combobox', { name: 'Theme' })
    await userEvent.selectOptions(select, 'dark')
    expect(select).toHaveValue('dark')
  })

  it('renders a shortcut as readable keyboard keys with one accessible name', () => {
    render(<ShortcutKey accelerator="Ctrl+Shift+Space" platform="win32" />)

    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(document.querySelectorAll('kbd')).toHaveLength(3)
    expect(screen.getAllByText('+', { ignore: false })).toHaveLength(2)
  })

  it('renders macOS glyph chips without separators under a spelled-out label', () => {
    render(<ShortcutKey accelerator="Control+Shift+Space" platform="darwin" />)

    expect(screen.getByLabelText('Control+Shift+Space')).toBeVisible()
    expect([...document.querySelectorAll('kbd')].map((key) => key.textContent))
      .toEqual(['⌃', '⇧', 'Space'])
    expect(screen.queryByText('+')).not.toBeInTheDocument()
  })

  it('announces informational and error toast messages with appropriate urgency', () => {
    render(<ToastRegion messages={[
      { id: 'saved', message: 'Settings saved' },
      { id: 'failed', message: 'Could not save', tone: 'error' },
    ]} />)

    expect(screen.getByRole('status')).toHaveTextContent('Settings saved')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save')
  })

  it('defines the Crossing tokens for a dark and a light room, scoped to the root, and both reduced-motion paths', () => {
    for (const token of [
      'canvas', 'surface', 'surface-elevated', 'text', 'text-2', 'text-muted', 'border', 'hairline', 'pill', 'pill-ink',
      'primary', 'primary-hover', 'activity', 'success', 'warning', 'error',
      'error-contrast', 'focus-ring', 'shadow-sm', 'shadow-lg', 'radius-sm', 'radius-md', 'radius-lg', 'radius-pill',
    ]) {
      expect(tokensCss).toContain(`--tt-${token}:`)
    }
    // Every room colour comes from the active theme's roles (ADR-0011).
    expect(tokensCss).toContain('--tt-canvas: var(--theme-canvas);')
    expect(tokensCss).toContain('color-scheme: dark;')
    expect(tokensCss).toContain('color-scheme: light;')
    // The resolved mode lives on the root; the stylesheet never queries the system itself.
    expect(tokensCss).toContain(":root[data-theme='light']")
    expect(tokensCss).not.toContain('prefers-color-scheme')
    // The retired Rail layout's side-panel token stays gone (--tt-sidebar is the nav-rail fill).
    expect(tokensCss).not.toMatch(/--tt-side:/u)
    expect(globalCss).not.toContain('data-theme')
    expect(globalCss).not.toContain('prefers-color-scheme')
    expect(tokensCss).toMatch(/--tt-font-ui:\s*'Figtree'/u)
    expect(globalCss).toContain('font-optical-sizing: auto')
    expect(globalCss).toContain('min-height: 44px')
    expect(globalCss).toContain(':focus-visible')
    expect(globalCss).toContain('prefers-reduced-motion: reduce')
    expect(globalCss).toContain("[data-reduced-motion='on']")
    expect(globalCss).toContain('animation-duration: 1ms !important')
    expect(globalCss).toMatch(/h1\[tabindex='-1'\]:focus\s*\{[^}]*outline:\s*none/su)
    expect(globalCss).toMatch(/:focus-visible[^}]*outline:\s*3px solid var\(--tt-focus-ring\)/su)
    expect(globalCss).toContain('color: var(--tt-error-contrast)')
  })

  it('contains no common UTF-8 mojibake markers in user-visible onboarding copy', () => {
    expect(onboardingSource).not.toMatch(/\u00c3|\u00c2|\u00e2/u)
  })

  it('keeps control borders at 3:1 and every text tier and the activity accent at 4.5:1 in every room and built-in theme', () => {
    for (const mode of MODES) {
      for (const themeId of THEME_IDS) {
        const declarations = rootDeclarations(mode, themeId)
        const canvas = resolveColor('--tt-canvas', declarations)
        const color = (name: string) => over(resolveColor(`--tt-${name}`, declarations), canvas)
        for (const surface of ['canvas', 'surface', 'surface-elevated'] as const) {
          expect(contrast(color('border'), color(surface)), `${mode}/${themeId} border on ${surface}`).toBeGreaterThanOrEqual(3)
          for (const ink of ['text', 'text-2', 'text-muted', 'activity'] as const) {
            expect(contrast(color(ink), color(surface)), `${mode}/${themeId} ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
          }
        }
        // The finished thread's ring is the success colour, and it is drawn on
        // the sidebar as often as on the page.
        for (const surface of ['canvas', 'sidebar'] as const) {
          expect(contrast(color('success'), color(surface)), `${mode}/${themeId} success on ${surface}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('bundles Figtree as local latin and latin-ext subsets without touching the widget', () => {
    const fontsCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/fonts.css'), 'utf8')
    const faces = [...fontsCss.matchAll(/font-family:\s*'Figtree'/gu)]
    expect(faces).toHaveLength(2)
    expect(fontsCss).toContain("url('../assets/fonts/figtree-latin.woff2')")
    expect(fontsCss).toContain("url('../assets/fonts/figtree-latin-ext.woff2')")
    expect(fontsCss).toMatch(/font-weight:\s*200 800/u)
    const widgetCss = readFileSync(join(process.cwd(), 'src/renderer/src/widget/widget.css'), 'utf8')
    expect(widgetCss).not.toContain('Figtree')
  })

  it('normalizes the production Electron shortcut for Windows display', () => {
    render(<ShortcutKey accelerator={DEFAULT_SETTINGS.hotkey} platform="win32" />)

    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.queryByText('CommandOrControl')).not.toBeInTheDocument()
  })
})

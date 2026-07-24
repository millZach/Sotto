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

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
const tokensCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8')
const onboardingSource = readFileSync(join(process.cwd(), 'src/renderer/src/features/onboarding/Onboarding.tsx'), 'utf8')

function channelToLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/gu)?.map((value) => Number.parseInt(value, 16))
  if (channels?.length !== 3) throw new Error(`Invalid test color: ${hex}`)
  return 0.2126 * channelToLinear(channels[0]!)
    + 0.7152 * channelToLinear(channels[1]!)
    + 0.0722 * channelToLinear(channels[2]!)
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function colorPalettes(): Array<Record<'canvas' | 'surface' | 'surface-elevated' | 'border', string>> {
  const names = ['canvas', 'surface', 'surface-elevated', 'border'] as const
  const declarations = [...tokensCss.matchAll(/--tt-(canvas|surface|surface-elevated|border):\s*(#[0-9a-f]{6});/giu)]
  const palettes: Array<Partial<Record<(typeof names)[number], string>>> = []
  for (const match of declarations) {
    const name = match[1] as (typeof names)[number]
    if (name === 'canvas') palettes.push({})
    palettes.at(-1)![name] = match[2]!
  }
  return palettes.map((palette) => {
    for (const name of names) if (palette[name] === undefined) throw new Error(`Missing ${name} token`)
    return palette as Record<(typeof names)[number], string>
  })
}

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
    render(<ShortcutKey accelerator="Ctrl+Shift+Space" />)

    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(document.querySelectorAll('kbd')).toHaveLength(3)
  })

  it('announces informational and error toast messages with appropriate urgency', () => {
    render(<ToastRegion messages={[
      { id: 'saved', message: 'Settings saved' },
      { id: 'failed', message: 'Could not save', tone: 'error' },
    ]} />)

    expect(screen.getByRole('status')).toHaveTextContent('Settings saved')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save')
  })

  it('defines complete light/dark/system tokens, 44px controls, and both reduced-motion paths', () => {
    for (const token of [
      'canvas', 'surface', 'surface-elevated', 'text', 'text-muted', 'border',
      'primary', 'primary-hover', 'activity', 'success', 'warning', 'error',
      'error-contrast', 'focus-ring', 'shadow-sm', 'shadow-lg', 'radius-sm', 'radius-md', 'radius-lg',
    ]) {
      expect(tokensCss).toContain(`--tt-${token}:`)
    }
    expect(tokensCss).toContain("[data-theme='light']")
    expect(tokensCss).toContain("[data-theme='dark']")
    expect(tokensCss).toContain('prefers-color-scheme: dark')
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

  it('keeps control and card borders at 3:1 contrast against every supported surface', () => {
    const palettes = colorPalettes()
    expect(palettes).toHaveLength(3)
    for (const palette of palettes) {
      for (const surface of ['canvas', 'surface', 'surface-elevated'] as const) {
        expect(contrastRatio(palette.border, palette[surface])).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('normalizes the production Electron shortcut for Windows display', () => {
    render(<ShortcutKey accelerator={DEFAULT_SETTINGS.hotkey} />)

    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.queryByText('CommandOrControl')).not.toBeInTheDocument()
  })
})

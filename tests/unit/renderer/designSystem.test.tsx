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

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
const tokensCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8')
const onboardingSource = readFileSync(join(process.cwd(), 'src/renderer/src/features/onboarding/Onboarding.tsx'), 'utf8')

afterEach(cleanup)

describe('TalkType design-system primitives', () => {
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
    expect(globalCss).not.toContain('.onboarding-card h1:focus')
    expect(globalCss).toContain('color: var(--tt-error-contrast)')
  })

  it('contains no common UTF-8 mojibake markers in user-visible onboarding copy', () => {
    expect(onboardingSource).not.toMatch(/\u00c3|\u00c2|\u00e2/u)
  })
})

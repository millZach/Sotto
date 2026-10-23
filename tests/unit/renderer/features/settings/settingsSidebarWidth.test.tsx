import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { THREADS_SIDEBAR_KEY } from '../../../../../src/renderer/src/agents/sidebarSize'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'

const windowWidth = window.innerWidth

function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}
afterEach(() => setWindowWidth(windowWidth))

/** The width the Settings sections' column is given, as the stylesheet reads it. */
function columnWidth(): string {
  const { container } = render(<SettingsView {...baseProps()} />)
  return container.querySelector<HTMLElement>('.settings-layout')!.style.getPropertyValue('--app-sidebar-width')
}

describe('the Settings column', () => {
  it('is as wide as the Threads sidebar is, so going there and back moves nothing', () => {
    // Nothing saved: the sidebar's default.
    expect(columnWidth()).toBe('320px')
  })

  it.each([
    ['the minimum', { width: 260, collapsed: false }, 260],
    ['one the person dragged to', { width: 400, collapsed: false }, 400],
    ['the maximum', { width: 480, collapsed: false }, 480],
    // The sidebar can be collapsed to its rail; Settings has no rail, so it keeps the width the sidebar expands to.
    ['the width a collapsed sidebar expands to', { width: 360, collapsed: true }, 360],
  ])('takes %s', (_name, saved, shown) => {
    localStorage.setItem(THREADS_SIDEBAR_KEY, JSON.stringify(saved))
    expect(columnWidth()).toBe(`${shown}px`)
  })

  it('narrows with the window the way the sidebar does, keeping 470px for the room', () => {
    localStorage.setItem(THREADS_SIDEBAR_KEY, JSON.stringify({ width: 480, collapsed: false }))
    setWindowWidth(820)
    expect(columnWidth()).toBe('350px')
  })

  it('starts at the default when the saved width is damaged', () => {
    localStorage.setItem(THREADS_SIDEBAR_KEY, '{"width":"wide"')
    expect(columnWidth()).toBe('320px')
  })
})

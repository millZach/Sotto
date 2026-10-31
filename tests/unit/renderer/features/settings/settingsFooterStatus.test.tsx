import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'

// #1907: the footer status lay over the page's scrolling column and covered whatever row scrolled under it. It is now
// the column's last line, after the scroll, so the scroll ends above it. footer-status-clearance.spec.ts measures it.
describe("Settings' footer status", () => {
  it('is the last line of the page column, after the scroll rather than over it', () => {
    const { container } = render(<SettingsView {...baseProps({ statusText: 'Changes save as you make them.' })} />)
    const status = container.querySelector('.page-status')
    expect(status?.textContent).toBe('Changes save as you make them.')
    expect(status?.parentElement?.classList.contains('settings-detail')).toBe(true)
    expect(status?.parentElement?.lastElementChild).toBe(status)
    expect(status?.previousElementSibling?.classList.contains('settings-scroll')).toBe(true)
  })

  it('takes no line when the page has nothing to say', () => {
    const { container } = render(<SettingsView {...baseProps()} />)
    expect(container.querySelector('.page-status')).toBeNull()
  })
})

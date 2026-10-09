import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SottoPlatform } from '../../../src/shared/platform'
import { PageWindowControls } from '../../../src/renderer/src/components/WindowControls'

const state = vi.hoisted(() => ({
  platform: 'win32' as SottoPlatform,
  windowMaximized: false,
  actions: { toggleMaximizeApp: vi.fn(), minimizeApp: vi.fn(), hideApp: vi.fn() },
}))
vi.mock('../../../src/renderer/src/state/AppContext', () => ({ useOptionalApp: () => state }))

afterEach(() => { cleanup(); vi.clearAllMocks(); state.windowMaximized = false })

describe('PageWindowControls', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('draws Windows controls or no reserved corner on %s', (platform) => {
    state.platform = platform
    const { container } = render(<PageWindowControls />)
    if (platform !== 'win32') {
      expect(container).toBeEmptyDOMElement()
      return
    }
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Sotto' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize Sotto' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Sotto to tray' }))
    expect(state.actions.minimizeApp).toHaveBeenCalledOnce()
    expect(state.actions.toggleMaximizeApp).toHaveBeenCalledOnce()
    expect(state.actions.hideApp).toHaveBeenCalledOnce()
  })

  it('keeps the Windows restore control when maximized', () => {
    state.platform = 'win32'
    state.windowMaximized = true
    render(<PageWindowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore Sotto' }))
    expect(state.actions.toggleMaximizeApp).toHaveBeenCalledOnce()
  })
})

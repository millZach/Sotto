import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from '../../../src/renderer/src/components/AppShell'

afterEach(cleanup)

describe('AppShell', () => {
  it('provides navigation, one main landmark, status footer, and tray-safe window controls', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const minimize = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    render(
      <AppShell navigation="home" statusText="Ready" onNavigate={navigate} onMinimize={minimize} onClose={close}>
        <h1>Home</h1>
      </AppShell>,
    )

    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(navigate).toHaveBeenCalledWith('settings')
    await user.click(screen.getByRole('button', { name: /minimize talktype/i }))
    await user.click(screen.getByRole('button', { name: /close talktype to tray/i }))
    expect(minimize).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(screen.getByText('Ready')).toHaveAttribute('aria-live', 'polite')
  })

  it('defines draggable chrome, no-drag controls, and the compact 820px layout without mojibake', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
    const source = [
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/AppShell.tsx',
      'src/renderer/src/components/ConfirmationDialog.tsx',
      'src/renderer/src/features/home/HomeView.tsx',
      'src/renderer/src/features/history/HistoryView.tsx',
      'src/renderer/src/features/settings/SettingsView.tsx',
      'src/renderer/src/features/help/HelpView.tsx',
    ].map((path) => readFileSync(join(process.cwd(), path), 'utf8')).join('\n')
    expect(css).toContain('-webkit-app-region: drag')
    expect(css).toContain('-webkit-app-region: no-drag')
    expect(css).toContain('@media (max-width: 820px)')
    expect(source).not.toMatch(/\u00c3|\u00c2|\u00e2/u)
  })

  it('keeps keyboard focus inside destructive confirmation dialogs', async () => {
    const user = userEvent.setup()
    const { ConfirmationDialog } = await import('../../../src/renderer/src/components/ConfirmationDialog')
    render(<ConfirmationDialog title="Remove?" description="Local files" confirmLabel="Remove" cancelLabel="Keep" onCancel={vi.fn()} onConfirm={vi.fn(async () => false)} />)
    const cancel = screen.getByRole('button', { name: 'Keep' })
    const confirm = screen.getByRole('button', { name: 'Remove' })
    expect(cancel).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
  })
})

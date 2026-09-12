import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell, roomFor } from '../../../src/renderer/src/components/AppShell'

afterEach(cleanup)

const chrome = {
  platform: 'win32' as const,
  onMinimize: vi.fn(),
  onClose: vi.fn(),
}

describe('AppShell', () => {
  it('provides the strip, one main landmark, the footer links, and one status sentence', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const { container } = render(
      <AppShell {...chrome} navigation="home" statusText="Instant model, English. Pastes automatically." onNavigate={navigate}>
        <h1>Ready when you are.</h1>
      </AppShell>,
    )

    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(container.querySelectorAll('.app-strip')).toHaveLength(1)
    expect(screen.getByText('Sotto')).toBeInTheDocument()
    const links = screen.getByRole('navigation', { name: 'Pages' })
    expect(links.querySelectorAll('a')).toHaveLength(5)
    for (const name of ['Threads', 'History', 'Memory', 'Settings', 'Help']) {
      expect(screen.getByRole('link', { name })).not.toHaveAttribute('aria-current')
    }
    expect(screen.queryByRole('link', { name: /home|dictionary|agents|dictate/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(navigate).toHaveBeenCalledWith('settings')
    expect(screen.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
    const status = screen.getByText('Instant model, English. Pastes automatically.')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('contentinfo')).toContainElement(status)
    expect(container.querySelector('.app-titlebar, .app-navigation, .app-stage, .dictation-strip')).toBeNull()
  })

  it('exposes the switch as a tablist with one selected tab per room and a roving tabindex', () => {
    const { rerender } = render(<AppShell {...chrome} navigation="home"><p /></AppShell>)
    const tablist = screen.getByRole('tablist', { name: 'Mode' })
    const dictate = screen.getByRole('tab', { name: 'Dictate' })
    const agents = screen.getByRole('tab', { name: 'Agents' })
    expect(tablist).toContainElement(dictate)
    expect(dictate).toHaveAttribute('aria-selected', 'true')
    expect(dictate).toHaveAttribute('tabindex', '0')
    expect(agents).toHaveAttribute('aria-selected', 'false')
    expect(agents).toHaveAttribute('tabindex', '-1')

    rerender(<AppShell {...chrome} navigation="threads"><p /></AppShell>)
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('link', { name: 'Threads' })).toHaveAttribute('aria-current', 'page')

    rerender(<AppShell {...chrome} navigation="settings"><p /></AppShell>)
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })

  it('moves between the rooms with the pointer and the arrow, Home and End keys', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    render(<AppShell {...chrome} navigation="home" onNavigate={navigate}><p /></AppShell>)

    await user.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(navigate).toHaveBeenLastCalledWith('agents')

    screen.getByRole('tab', { name: 'Dictate' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(navigate).toHaveBeenLastCalledWith('agents')
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(navigate).toHaveBeenLastCalledWith('home')
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(navigate).toHaveBeenLastCalledWith('agents')
    await user.keyboard('{Home}')
    expect(navigate).toHaveBeenLastCalledWith('home')
    expect(navigate).toHaveBeenCalledTimes(5)
  })

  it('shows the strip and the room but no switch or footer before the management window is ready', () => {
    const { container } = render(<AppShell {...chrome} navigation={null}><p>Preparing Sotto...</p></AppShell>)
    expect(container.querySelector('.app-shell')).toHaveClass('app-shell--bare')
    expect(screen.getByRole('main')).toHaveTextContent('Preparing Sotto...')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
  })

  it('leaves the window controls to macOS and reserves the traffic-light strip', () => {
    const { container } = render(<AppShell {...chrome} platform="darwin" navigation="home"><p /></AppShell>)
    expect(screen.queryByRole('button', { name: /minimize sotto/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close sotto to tray/i })).not.toBeInTheDocument()
    expect(container.querySelector('.app-strip')).toHaveClass('app-strip--mac')
  })

  it('maps pages to the room they light', () => {
    expect(roomFor('home')).toBe('dictate')
    expect(roomFor('agents')).toBe('agents')
    expect(roomFor('threads')).toBe('agents')
    expect(roomFor('history')).toBeNull()
    expect(roomFor(null)).toBeNull()
  })

  it('keeps the three-row shell, the room as the one scrollport, and the drag regions in the stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
    expect(css).toMatch(/\.app-shell\s*\{[^}]*grid-template-rows:\s*60px minmax\(0, 1fr\) 44px;/su)
    expect(css).toMatch(/\.app-shell\s*\{[^}]*height:\s*100vh;/su)
    expect(css).toMatch(/\.app-shell--bare\s*\{[^}]*grid-template-rows:\s*60px minmax\(0, 1fr\);/su)
    expect(css).toMatch(/\.app-strip\s*\{[^}]*-webkit-app-region:\s*drag;/su)
    expect(css).toMatch(/\.app-switch\s*\{[^}]*-webkit-app-region:\s*no-drag;/su)
    expect(css).toMatch(/\.app-controls\s*\{[^}]*-webkit-app-region:\s*no-drag;/su)
    expect(css).toMatch(/\.app-strip--mac\s*\{[^}]*padding-left:\s*78px;/su)
    expect(css).toMatch(/\.app-room\s*\{[^}]*overflow:\s*auto;/su)
    expect(css).toMatch(/\.app-footer\s*\{[^}]*border-top:\s*1px solid var\(--tt-hairline\);/su)
    expect(css).toContain('@media (max-width: 820px)')
    for (const dead of ['.app-frame', '.app-titlebar', '.app-navigation', '.app-stage', '.app-content', '.dictation-strip', '.home-', '--tt-side', '--tt-primary-fill']) {
      expect(css).not.toContain(dead)
    }
  })

  it('keeps the shell sources free of mojibake', () => {
    const source = [
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/AppShell.tsx',
      'src/renderer/src/components/ConfirmationDialog.tsx',
      'src/renderer/src/features/dictate/DictateRoom.tsx',
      'src/renderer/src/features/history/HistoryView.tsx',
      'src/renderer/src/features/settings/SettingsView.tsx',
      'src/renderer/src/features/help/HelpView.tsx',
    ].map((path) => readFileSync(join(process.cwd(), path), 'utf8')).join('\n')
    expect(source).not.toMatch(/Ã|Â|â/u)
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

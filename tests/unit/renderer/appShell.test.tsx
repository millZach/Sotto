import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell, roomFor } from '../../../src/renderer/src/components/AppShell'

// The switch asks settings whether the voice coordinator is on; the beta ships
// it off, so the default here is off and one test turns it on.
const voice = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({
  useVoiceCoordinatorEnabled: () => voice.enabled,
}))
// Memory is off for the beta the same way; its page link comes and goes with it.
const memory = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../src/renderer/src/state/memoryFeature', () => ({
  useMemoryEnabled: () => memory.enabled,
}))

afterEach(() => {
  cleanup()
  voice.enabled = false
  memory.enabled = false
})

const chrome = {
  platform: 'win32' as const,
  onMinimize: vi.fn(),
  onMaximize: vi.fn(),
  onClose: vi.fn(),
}

describe('AppShell', () => {
  it('maximizes and restores from a keyboard-accessible window control', async () => {
    const onMaximize = vi.fn()
    const { rerender } = render(<AppShell {...chrome} onMaximize={onMaximize} navigation="home"><p /></AppShell>)
    const button = screen.getByRole('button', { name: 'Maximize Sotto' })
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(onMaximize).toHaveBeenCalledOnce()
    rerender(<AppShell {...chrome} onMaximize={onMaximize} maximized navigation="home"><p /></AppShell>)
    expect(screen.getByRole('button', { name: 'Restore Sotto' })).toHaveFocus()
  })

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
    // Memory is hidden for the beta, so its link is not among them.
    expect(links.querySelectorAll('a')).toHaveLength(5)
    for (const name of ['Threads', 'Chats', 'History', 'Settings', 'Help']) {
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

  it('lists the Memory page only while memory is switched on', () => {
    memory.enabled = true
    render(<AppShell {...chrome} navigation="home"><p /></AppShell>)
    const links = screen.getByRole('navigation', { name: 'Pages' })
    expect(links.querySelectorAll('a')).toHaveLength(6)
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument()
  })

  it('exposes the switch as a tablist with one selected tab per room and a roving tabindex', () => {
    const { rerender } = render(<AppShell {...chrome} navigation="home"><p /></AppShell>)
    const tablist = screen.getByRole('tablist', { name: 'Mode' })
    const dictate = screen.getByRole('tab', { name: 'Dictate' })
    const threads = screen.getByRole('tab', { name: 'Threads' })
    expect(tablist).toContainElement(dictate)
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(screen.queryByRole('tab', { name: 'Agents' })).not.toBeInTheDocument()
    expect(dictate).toHaveAttribute('aria-selected', 'true')
    expect(dictate).toHaveAttribute('tabindex', '0')
    expect(threads).toHaveAttribute('aria-selected', 'false')
    expect(threads).toHaveAttribute('tabindex', '-1')

    rerender(<AppShell {...chrome} navigation="chats"><p /></AppShell>)
    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('link', { name: 'Chats' })).toHaveAttribute('aria-current', 'page')

    rerender(<AppShell {...chrome} navigation="settings"><p /></AppShell>)
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })

  it('adds the Agents room to the switch only when the voice coordinator is on', () => {
    voice.enabled = true
    render(<AppShell {...chrome} navigation="agents"><p /></AppShell>)
    const tablist = screen.getByRole('tablist', { name: 'Mode' })
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(3)
    for (const name of ['Dictate', 'Agents', 'Threads']) {
      expect(screen.getByRole('tab', { name })).toBeVisible()
    }
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('tabindex', '0')
  })

  it('moves between the rooms with the pointer and the arrow, Home and End keys', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    render(<AppShell {...chrome} navigation="home" onNavigate={navigate}><p /></AppShell>)

    await user.click(screen.getByRole('tab', { name: 'Threads' }))
    expect(navigate).toHaveBeenLastCalledWith('threads')

    screen.getByRole('tab', { name: 'Dictate' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(navigate).toHaveBeenLastCalledWith('threads')
    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(navigate).toHaveBeenLastCalledWith('home')
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(navigate).toHaveBeenLastCalledWith('threads')
    await user.keyboard('{Home}')
    expect(navigate).toHaveBeenLastCalledWith('home')
    expect(navigate).toHaveBeenCalledTimes(5)
  })

  it('hands the whole window to a page layout: no strip, no footer, one main landmark', () => {
    const { container } = render(
      <AppShell {...chrome} navigation="threads" layout="page" statusText="Looking after two threads." updateControl={<button type="button">Update</button>}>
        <p>Thread sidebar</p>
      </AppShell>,
    )
    expect(container.querySelector('.app-shell')).toHaveClass('app-shell--page')
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toHaveClass('app-room--page')
    expect(screen.getByRole('main')).toHaveTextContent('Thread sidebar')
    expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument()
    // The page carries its own window controls, so the shell offers none.
    expect(screen.queryByRole('button', { name: /minimize sotto/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Looking after two threads.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
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
    expect(roomFor('threads')).toBe('threads')
    expect(roomFor('chats')).toBe('threads')
    expect(roomFor('memory')).toBe('threads')
    expect(roomFor('history')).toBeNull()
    expect(roomFor(null)).toBeNull()
  })

  it('keeps the three-row shell, the room as the one scrollport, and the drag regions in the stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
    expect(css).toMatch(/\.app-shell\s*\{[^}]*grid-template-rows:\s*60px minmax\(0, 1fr\) 44px;/su)
    expect(css).toMatch(/\.app-shell\s*\{[^}]*height:\s*100vh;/su)
    expect(css).toMatch(/\.app-shell--bare\s*\{[^}]*grid-template-rows:\s*60px minmax\(0, 1fr\);/su)
    expect(css).toMatch(/\.app-shell--page\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/su)
    expect(css).toMatch(/\.app-room--page\s*\{[^}]*overflow:\s*hidden;/su)
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

  it('keeps the room mounted when a page hands the window over and another takes the strip back', () => {
    // The memory surface lives inside the room and remembers a dismissed questionnaire only while mounted,
    // so the Threads page (page layout) and the Agents room (strip layout) must share one room element.
    const mounts = vi.fn()
    function Room(): React.ReactNode { React.useEffect(() => { mounts() }, []); return <p>room</p> }
    const { rerender } = render(<AppShell {...chrome} navigation="threads" layout="page"><Room /></AppShell>)
    expect(screen.queryByRole('tablist', { name: 'Mode' })).not.toBeInTheDocument()
    rerender(<AppShell {...chrome} navigation="agents" layout="strip"><Room /></AppShell>)
    expect(screen.getByRole('tablist', { name: 'Mode' })).toBeVisible()
    rerender(<AppShell {...chrome} navigation="threads" layout="page"><Room /></AppShell>)
    expect(mounts).toHaveBeenCalledTimes(1)
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

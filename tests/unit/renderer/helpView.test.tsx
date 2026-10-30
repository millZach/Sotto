import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HelpView } from '../../../src/renderer/src/features/help/HelpView'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))

afterEach(() => { cleanup(); vi.mocked(useOptionalApp).mockReset() })

function withWatcher(enabled: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { watcher: enabled, muse: false } } } as unknown as AppContextValue)
}

describe('HelpView', () => {
  it('names Linux and explains button dictation, manual paste and the Wayland shortcut limit', () => {
    const copy = platformCopy('linux')
    render(<HelpView shortcut="Super+CommandOrControl+X" holdShortcut="F9" platform="linux" version="3.4.0" />)
    expect(screen.getByText(/Sotto 3.4.0, Linux/)).toBeVisible()
    expect(screen.getByText(/Hold F9 to talk, or press Super\+Ctrl\+X to start and stop/)).toBeVisible()
    expect(screen.getByText(copy.settingsGlobalShortcutDescription)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.queryByLabelText('Ctrl+Shift+Space')).not.toBeInTheDocument()
    expect(screen.queryByText(/anywhere to begin/)).not.toBeInTheDocument()
    expect(screen.queryByText(/previous working shortcut active/)).not.toBeInTheDocument()
  })

  it('names the Linux keys Settings saved', () => {
    render(<HelpView shortcut="Super+Alt+D" holdShortcut="F10" platform="linux" version="3.4.0" />)
    expect(screen.getByText(/Hold F10 to talk, or press Super\+Alt\+D to start and stop/)).toBeVisible()
    render(<HelpView shortcut="Super+Alt+D" platform="linux" version="3.4.0" />)
    expect(screen.getByText(/^Press Super\+Alt\+D to start and stop, once/)).toBeVisible()
  })

  it('sends Linux to the widget to cancel, because Escape is a global shortcut Wayland never delivers', () => {
    render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="linux" version="3.4.0" />)
    expect(screen.getByText(/To stop without transcribing, press Cancel on the floating widget/)).toBeVisible()
    expect(screen.queryByText(/Escape/)).not.toBeInTheDocument()
    expect(screen.queryByText('Cancel recording')).not.toBeInTheDocument()
  })

  it('keeps the Escape row on Windows', () => {
    render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="win32" />)
    expect(screen.getByText('Cancel recording')).toBeVisible()
  })

  it('documents operation, privacy, and paste limitations honestly', () => {
    const copy = platformCopy('win32')
    render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="win32" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()
    expect(screen.getByText(/press escape to cancel/i)).toBeVisible()
    expect(screen.getByText(/Audio you dictate never leaves this computer/i)).toBeVisible()
    expect(screen.getByText(/AI cleanup, when it is on, sends the transcript text to OpenRouter on your key/i)).toBeVisible()
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.getByText(/previous working shortcut active/i)).toBeVisible()
    expect(screen.getByText(/resetting settings reopens first-run setup/i)).toBeVisible()
    // Ctrl+K opens the Dictate room on the Journal's search now that there is no History page (#1293).
    expect(screen.getByText('Search transcripts')).toBeVisible()
    expect(screen.queryByText('Search history')).not.toBeInTheDocument()
    expect(screen.queryByText(/History controls/)).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('Ctrl+Shift+Space')[0]).toBeVisible()
    expect(screen.queryByRole('heading', { level: 2, name: 'Paste permissions' })).not.toBeInTheDocument()
  })

  it('adds the macOS permission card and platform copy on darwin', () => {
    const copy = platformCopy('darwin')
    render(<HelpView shortcut="Control+Shift+Space" platform="darwin" />)
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Paste permissions' })).toBeVisible()
    expect(screen.getByText(copy.accessibilityHelp ?? '')).toBeVisible()
    expect(screen.getAllByLabelText('Control+Shift+Space')[0]).toBeVisible()
  })

  it('explains Watcher under its own topic, which Watcher’s room opens with focus on its title (#1822)', () => {
    withWatcher(true)
    const { rerender } = render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="win32" />)
    const topic = screen.getByRole('heading', { level: 2, name: 'How Watcher works' }).closest('details')!
    expect(topic).toHaveAttribute('id', 'help-watcher')
    expect(topic).toHaveTextContent('It runs on your own Codex, Claude Code or Grok Build account, with that provider’s own tools.')
    expect(topic).toHaveTextContent('only you answer a thread’s questions and permissions')
    rerender(<HelpView shortcut="CommandOrControl+Shift+Space" platform="win32" openTopic={{ topic: 'help-watcher', key: 1 }} />)
    expect(topic.querySelector('summary')).toHaveFocus()
    // Escape folds it and leaves focus on its title (AGENTS.md: anything that opens answers Escape).
    fireEvent.keyDown(topic.querySelector('summary')!, { key: 'Escape' })
    expect(topic).not.toHaveAttribute('open')
    expect(topic.querySelector('summary')).toHaveFocus()
  })

  it('leaves Watcher out where Watcher is not on (ADR-0072)', () => {
    withWatcher(false)
    render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="win32" openTopic={{ topic: 'help-watcher', key: 1 }} />)
    expect(screen.queryByRole('heading', { name: 'How Watcher works' })).toBeNull()
  })
})

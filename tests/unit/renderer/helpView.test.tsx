import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HelpView } from '../../../src/renderer/src/features/help/HelpView'
import { platformCopy } from '../../../src/renderer/src/platformCopy'

afterEach(cleanup)

describe('HelpView', () => {
  it('names Linux and explains button dictation, manual paste and the Wayland shortcut limit', () => {
    const copy = platformCopy('linux')
    render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="linux" version="3.4.0" />)
    expect(screen.getByText(/Sotto 3.4.0, Linux/)).toBeVisible()
    expect(screen.getByText(/Use the dictation button to begin, then press Stop to finish/)).toBeVisible()
    expect(screen.getByText(copy.settingsGlobalShortcutDescription)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.queryByLabelText('Ctrl+Shift+Space')).not.toBeInTheDocument()
    expect(screen.queryByText(/anywhere to begin/)).not.toBeInTheDocument()
    expect(screen.queryByText(/previous working shortcut active/)).not.toBeInTheDocument()
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
    expect(screen.getByText(/Audio you dictate is sent to OpenRouter for transcription/i)).toBeVisible()
    expect(screen.getByText(/Add your OpenRouter API key in Settings/i)).toBeVisible()
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.getByText(/previous working shortcut active/i)).toBeVisible()
    expect(screen.getByText(/resetting settings reopens first-run setup/i)).toBeVisible()
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
})

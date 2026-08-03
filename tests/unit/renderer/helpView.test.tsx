import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HelpView } from '../../../src/renderer/src/features/help/HelpView'
import { platformCopy } from '../../../src/renderer/src/platformCopy'

afterEach(cleanup)

describe('HelpView', () => {
  it('documents operation, privacy, optional network metadata, and paste limitations honestly', () => {
    const copy = platformCopy('win32')
    render(<HelpView shortcut="CommandOrControl+Shift+Space" platform="win32" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()
    expect(screen.getByText(/press escape to cancel/i)).toBeVisible()
    expect(screen.getByText(/speech and transcripts stay on this computer/i)).toBeVisible()
    expect(screen.getByText(/ip address and request time/i)).toBeVisible()
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.getByText(/previous working shortcut active/i)).toBeVisible()
    expect(screen.getByText(/resetting settings reopens first-run setup/i)).toBeVisible()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.queryByRole('heading', { level: 2, name: 'Paste permissions' })).not.toBeInTheDocument()
  })

  it('adds the macOS permission card and platform copy on darwin', () => {
    const copy = platformCopy('darwin')
    render(<HelpView shortcut="Control+Shift+Space" platform="darwin" />)
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.helpPasteFallback)).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Paste permissions' })).toBeVisible()
    expect(screen.getByText(copy.accessibilityHelp ?? '')).toBeVisible()
    expect(screen.getByLabelText('Control+Shift+Space')).toBeVisible()
  })
})

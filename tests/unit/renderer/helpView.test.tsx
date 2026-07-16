import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HelpView } from '../../../src/renderer/src/features/help/HelpView'

afterEach(cleanup)

describe('HelpView', () => {
  it('documents operation, privacy, optional network metadata, and paste limitations honestly', () => {
    render(<HelpView shortcut="CommandOrControl+Shift+Space" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()
    expect(screen.getByText(/press escape to cancel/i)).toBeVisible()
    expect(screen.getByText(/speech and transcripts stay on this computer/i)).toBeVisible()
    expect(screen.getByText(/ip address and request time/i)).toBeVisible()
    expect(screen.getByText(/clipboard first/i)).toBeVisible()
    expect(screen.getByText(/elevated, protected, or password/i)).toBeVisible()
    expect(screen.getByText(/previous working shortcut active/i)).toBeVisible()
    expect(screen.getByText(/resetting settings reopens first-run setup/i)).toBeVisible()
  })
})

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { AppTitlebar } from '../../../src/renderer/src/components/AppTitlebar'

it('renders TalkType branding and invokes tray-safe controls', async () => {
  const user = userEvent.setup()
  const onMinimize = vi.fn()
  const onClose = vi.fn()

  render(<AppTitlebar onMinimize={onMinimize} onClose={onClose} />)

  expect(screen.getByLabelText('TalkType application')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Minimize TalkType' }))
  await user.click(screen.getByRole('button', { name: 'Close TalkType to tray' }))

  expect(onMinimize).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

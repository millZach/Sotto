import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Questionnaire, emptyQuestionnaire } from '../../../src/renderer/src/features/memory/Questionnaire'

afterEach(cleanup)

it('provides readable progress text without announcing each step', () => {
  const props = { draft: emptyQuestionnaire, onChange: vi.fn(), onSave: vi.fn(async () => true), onLater: vi.fn(), busy: false, error: '' }
  const { rerender } = render(<Questionnaire {...props} />)
  expect(screen.getByText('Question 1 of 9')).toHaveClass('tt-visually-hidden')
  expect(screen.getByText('1 / 9')).toHaveAttribute('aria-hidden', 'true')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  rerender(<Questionnaire {...props} draft={{ ...emptyQuestionnaire, step: 1 }} />)
  expect(screen.getByText('Question 2 of 9')).toHaveClass('tt-visually-hidden')
  expect(screen.getByText('2 / 9')).toHaveAttribute('aria-hidden', 'true')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

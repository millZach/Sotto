import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ThreadUsage } from '../../../src/renderer/src/agents/ThreadUsage'

afterEach(cleanup)
it('distinguishes missing native data from reported zero and exposes the billing basis', async () => {
  const user = userEvent.setup()
  const view = render(<ThreadUsage />)
  expect(screen.getByText('Tokens unavailable')).toBeVisible()
  expect(screen.getByText('Context unavailable')).toBeVisible()
  expect(screen.getByText('Estimate unavailable')).toBeVisible()
  view.rerender(<ThreadUsage usage={{ latest: { input: 0, output: 0 }, contextUsed: 0, contextWindow: 200000, estimatedUsd: 0,
    rateVersions: ['2026-09-13-standard-v1'], partial: false, updatedAt: '2026-09-13' }} />)
  expect(screen.getByText('0 in / 0 out tokens')).toBeVisible()
  expect(screen.getByText('Context 0%')).toBeVisible()
  await user.click(screen.getByText('Est. $0.0000'))
  expect(screen.getByText(/not subscription billing/)).toBeVisible()
})
it('does not attribute old model context to a newly selected model, while keeping observed thread costs', () => {
  render(<ThreadUsage modelId="new" usage={{ modelId: 'old', latest: { input: 2000 }, contextUsed: 2000, contextWindow: 200000,
    estimatedUsd: 0.01, rateVersions: ['2026-09-13-standard-v1'], partial: true, updatedAt: '2026-09-13' }} />)
  expect(screen.getByText('Context unavailable')).toBeVisible()
  expect(screen.getByText('Est. ≥ $0.0100')).toBeVisible()
})
it('adds up the thread tokens across requests and models, keeping the latest request as detail', () => {
  render(<ThreadUsage modelId="new" usage={{ modelId: 'old', latest: { input: 160_728, output: 439 }, total: { input: 2_410_000, output: 38_694 },
    rateVersions: [], partial: false, updatedAt: '2026-09-15' }} />)
  expect(screen.getByText('2,410,000 in / 38,694 out tokens')).toHaveAttribute('title', 'Latest request: 160,728 in / 439 out tokens')
})

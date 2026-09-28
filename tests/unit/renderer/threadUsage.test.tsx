import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ThreadUsage } from '../../../src/renderer/src/agents/ThreadUsage'

afterEach(cleanup)
it('distinguishes missing native data from reported zero and exposes the billing basis', () => {
  const view = render(<ThreadUsage />)
  expect(screen.getByText('Context unavailable')).toBeVisible()
  expect(screen.getByText('Estimate unavailable')).toBeVisible()
  expect(screen.getByText('Estimate unavailable')).toHaveAttribute('title', expect.stringContaining('not subscription billing'))
  view.rerender(<ThreadUsage usage={{ latest: { input: 0, output: 0 }, contextUsed: 0, contextWindow: 200000, estimatedUsd: 0,
    rateVersions: ['2026-09-13-standard-v1'], partial: false, updatedAt: '2026-09-13' }} />)
  // Nothing used yet is a figure of its own, and reads differently from having no figure at all.
  expect(screen.getByText('0%').closest('span')).toHaveAttribute('title', '0 of 200,000 tokens in the context window (0%)')
  expect(screen.getByText('$0.00')).toBeVisible()
  expect(screen.getByText('$0.00')).toHaveAttribute('title', expect.stringContaining('Rate inputs: 2026-09-13-standard-v1.'))
})
it('shows how full the context window is, and says so in the title', () => {
  render(<ThreadUsage usage={{ latest: { input: 33_600 }, contextUsed: 33_600, contextWindow: 480_000, estimatedUsd: 1.75,
    rateVersions: ['2026-09-13-standard-v1'], partial: false, updatedAt: '2026-09-18' }} />)
  const context = screen.getByText('7%').closest('span')!
  expect(context).toHaveTextContent('7% context')
  expect(context).toHaveAttribute('title', '33,600 of 480,000 tokens in the context window (7%)')
  expect(screen.getByText('$1.75')).toBeVisible()
})
it('does not attribute old model context to a newly selected model, while keeping observed thread costs', () => {
  render(<ThreadUsage modelId="new" usage={{ modelId: 'old', latest: { input: 2000 }, contextUsed: 2000, contextWindow: 200000,
    estimatedUsd: 0.01, rateVersions: ['2026-09-13-standard-v1'], partial: true, updatedAt: '2026-09-13' }} />)
  expect(screen.getByText('Context unavailable')).toBeVisible()
  const cost = screen.getByText('≥ $0.01')
  expect(cost).toBeVisible()
  expect(cost).toHaveAttribute('title', expect.stringContaining('may have cost more'))
})
it('keeps a fraction of a cent visible, and warns in the title when the estimate may not survive a restart', () => {
  render(<ThreadUsage usage={{ latest: { input: 40 }, estimatedUsd: 0.0007, rateVersions: [], partial: false, persistenceError: true, updatedAt: '2026-09-15' }} />)
  const cost = screen.getByText('$0.0007')
  expect(cost).toHaveAttribute('title', expect.stringContaining('may be lost after restart'))
  expect(cost).toHaveAttribute('title', expect.stringContaining('No supported priced usage yet.'))
})

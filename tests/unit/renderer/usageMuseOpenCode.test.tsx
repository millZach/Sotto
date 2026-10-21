import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from '../../../src/shared/agents'
import type { UsageHostRead } from '../../../src/shared/usageDashboard'
import { UsageView } from '../../../src/renderer/src/features/usage/UsageView'
import { USAGE_NOW, USAGE_ZONE, activityRow, dashboard, fixtureBridge, localActivity, localQuotas, tokens } from '../../fixtures/renderer/usageReads'

// Muse and OpenCode are counted in Sotto threads; Muse's limits are read, and OpenCode is left off Subscriptions entirely
// (ADR-0083, October 21, 2026). Each is an Owl feature of its own, and a provider held to Owl is offered nowhere.
const gate = vi.hoisted(() => ({ held: new Set<ProviderId>() }))
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useHeldProviders: () => gate.held, useOwlFeature: () => true }))
afterEach(() => { cleanup(); gate.held = new Set() })

const laptop = { hostId: 'laptop', name: 'zach-laptop', kind: 'local' as const, connected: true }
function host(): UsageHostRead {
  const base = localActivity()
  const muse = activityRow(6, 0, 0, tokens(300_000, 20_000, 120_000, 5_000))
  const opencode = activityRow(4, 0, 0, tokens(140_000, 9_000, 40_000, 0))
  return { hostId: 'laptop', status: 'ready', persistence: 'saved', activity: { ...base,
    providers: [...base.providers, { ...muse, providerId: 'muse' }, { ...opencode, providerId: 'opencode' }],
    models: [...base.models, { ...muse, providerId: 'muse', modelId: 'muse-wonder-full-1.0' }, { ...opencode, providerId: 'opencode', modelId: 'anthropic/claude-sonnet-4-5' }],
    modelCount: base.modelCount + 2,
  }, quotas: [...localQuotas(), { providerId: 'muse', status: 'unavailable', refreshable: false, reason: 'not-reported', windows: [] }] }
}
async function open() {
  render(<UsageView now={() => USAGE_NOW} timeZone={USAGE_ZONE} computers={[laptop]} bridge={fixtureBridge(dashboard(host()))} />)
  await screen.findByRole('tablist', { name: 'Usage measures' })
  return userEvent.setup()
}

describe('Muse and OpenCode on the Usage page', () => {
  it('offers both in the provider menu, gives Muse a Subscriptions section and leaves OpenCode off it', async () => {
    const user = await open()
    await user.click(screen.getByRole('button', { name: 'Provider: All providers' }))
    expect(within(screen.getByRole('listbox', { name: 'Provider' })).getAllByRole('option').map(option => option.textContent))
      .toEqual(['All providers', 'Codex', 'Claude Code', 'Grok Build', 'Devin', 'Muse', 'OpenCode'])
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('tab', { name: 'Subscriptions' }))
    const sections = screen.getAllByRole('region').filter(region => region.hasAttribute('aria-labelledby'))
      .map(region => within(region).getByRole('heading', { level: 2 }).textContent)
    expect(sections).toEqual(['Codex', 'Claude Code', 'Grok Build', 'Devin', 'Muse'])
    const muse = screen.getByRole('region', { name: 'Muse' })
    expect(muse).toHaveTextContent('Muse subscription')
    expect(muse).toHaveTextContent('No reading yet. Muse reports its limits after a Muse turn runs on this computer.')
    expect(within(muse).queryByRole('button')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/OpenCode.{0,40}limits? (can't|couldn't|haven't)/u)
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    expect(screen.getAllByText('OpenCode').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Muse').length).toBeGreaterThan(0)
  })

  it('offers neither where both are held to Owl', async () => {
    gate.held = new Set(['muse', 'opencode'])
    const user = await open()
    await user.click(screen.getByRole('button', { name: 'Provider: All providers' }))
    expect(within(screen.getByRole('listbox', { name: 'Provider' })).getAllByRole('option').map(option => option.textContent))
      .toEqual(['All providers', 'Codex', 'Claude Code', 'Grok Build', 'Devin'])
  })

  it('says which providers are counted in Sotto only and that OpenCode reports no limits', async () => {
    await open()
    const about = screen.getByText('About these numbers').closest('details')!
    expect(about).toHaveTextContent('Grok Build, Devin, Muse and OpenCode are counted in Sotto only.')
    expect(about).toHaveTextContent("OpenCode doesn't report account limits, so it isn't on Subscriptions.")
  })
})

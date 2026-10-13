import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageActivityAggregate, UsageBridge, UsageDashboardRead, UsageLocalRead } from '../../../src/shared/usageDashboard'
import { USAGE_TOKEN_FIELDS } from '../../../src/shared/usageDashboard'
import { UsageView } from '../../../src/renderer/src/features/usage/UsageView'
import { formatField, presentUsage, rangeBounds, sumFields, usageModelName } from '../../../src/renderer/src/features/usage/usagePresentation'
import { deferred } from '../../fixtures/deferred'

afterEach(cleanup)
const now = () => new Date('2026-10-12T16:00:00Z')
const unknown = { knownRows: 0, rows: 0, partial: false }
function aggregate(user = 3): UsageActivityAggregate {
  return { tokens: Object.fromEntries(USAGE_TOKEN_FIELDS.map(field => [field, unknown])) as UsageActivityAggregate['tokens'],
    prompts: { user, watcher: 1, wakeUp: 1, total: user + 2, steered: 1 }, tokenRecords: 0, partialTokenRecords: 0, undatedTokenRecords: 0, activeThreads: 1, activeDays: 1 }
}
function activity(user = 3): UsageLocalRead {
  const totals = aggregate(user)
  return { metadata: { startedAt: '2026-10-01T00:00:00Z', revision: 7, generation: 0, legacySeedCompleted: true }, totals, timeZone: 'America/Los_Angeles',
    providers: [{ ...totals, providerId: 'codex' }], models: [{ ...totals, providerId: 'codex', modelId: 'gpt-6.1-sol' }], modelCount: 1, modelsTruncated: false,
    daily: [{ ...totals, day: '2026-10-12' }], dailyCoverage: 'complete', hourly: [{ weekday: 0, hour: 9, prompts: totals.prompts }] }
}
function dashboard(user = 3): UsageDashboardRead {
  return { hosts: [{ hostId: 'laptop', status: 'ready', activity: activity(user), persistence: 'saved', quotas: [
    { providerId: 'grok', status: 'available', refreshable: true, observedAt: '2026-10-12T15:50:00Z', windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', resetsAt: '2026-10-18T00:00:00Z' }] },
    { providerId: 'claude', status: 'unavailable', refreshable: false, reason: 'refresh-unavailable', windows: [] },
  ] }] }
}
function bridge(read = dashboard()): UsageBridge {
  return { read: vi.fn(async () => read), refresh: vi.fn(async () => read), clear: vi.fn(async () => [{ hostId: 'laptop', status: 'cleared' as const }]) }
}
const props = { now, timeZone: 'America/Los_Angeles', computers: [{ hostId: 'laptop', name: 'Laptop' }] }

describe('Usage figures', () => {
  it('uses provider catalog names and a native fallback while preserving model identity', () => {
    const catalog = [{ id: 'native:claude:model:sonnet', providerId: 'claude' as const, provider: 'Claude Code', name: 'Sonnet 4.6', ready: true },
      { id: 'native:codex:model:sonnet', providerId: 'codex' as const, provider: 'Codex', name: 'Different provider', ready: true }]
    expect(usageModelName('native:claude:model:sonnet', 'claude', catalog)).toBe('Sonnet 4.6')
    expect(usageModelName('native:claude:model:claude-sonnet-4-6', 'claude', catalog)).toBe('Sonnet 4.6')
    expect(usageModelName('native:claude:model:sonnet%5B1m%5D', 'claude', catalog)).toBe('Sonnet 4.6')
    expect(usageModelName('native:grok:model:new-model', 'grok', catalog)).toBe('new-model')
  })
  it('preserves known zero and lower bounds when another computer has unknown fields', () => {
    const combined = sumFields([{ value: 0, knownRows: 1, rows: 1, partial: false }, { knownRows: 0, rows: 2, partial: true }])
    expect(combined).toEqual({ value: 0, knownRows: 1, rows: 3, partial: true })
    expect(formatField(combined)).toBe('≥ 0')
    expect(formatField(unknown)).toBe('—')
    expect(sumFields([{ value: Number.MAX_SAFE_INTEGER, knownRows: 1, rows: 1, partial: false }, { value: 1, knownRows: 1, rows: 1, partial: false }])).toEqual({ knownRows: 2, rows: 2, partial: true })
  })
  it('combines hosts once, unions daily buckets and separates selected-model prompts from token models', () => {
    const local = dashboard()
    const remote = activity(4)
    remote.providers.push({ ...remote.totals, providerId: 'claude', activeThreads: 9 })
    remote.models.push({ ...aggregate(0), providerId: 'codex', modelId: 'native-fallback', tokenRecords: 1 })
    local.hosts.push({ hostId: 'forge', status: 'ready', activity: remote, quotas: [] })
    const view = presentUsage(local)
    expect(view.totals.prompts.user).toBe(7)
    expect(view.totals.activeThreads).toBe(2)
    expect(view.totals.activeDays).toBe(1)
    expect(view.daily[0]?.prompts.user).toBe(7)
    expect(view.models[0]?.prompts.user).toBe(7)
    expect(view.busiest?.prompts.user).toBe(7)
  })
  it('uses local calendar dates across midnight and daylight saving', () => {
    expect(rangeBounds(7, new Date('2026-10-12T01:00:00Z'), 'America/Los_Angeles')).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(rangeBounds(7, new Date('2026-03-09T06:00:00Z'), 'America/Los_Angeles')).toEqual({ from: '2026-03-02', to: '2026-03-08' })
  })
})

describe('Usage view', () => {
  it('reuses recent quota readings across repeated page opens and still refreshes on a press', async () => {
    const data = dashboard()
    data.hosts[0]!.quotas[0]!.observedAt = '2026-10-12T15:59:31Z'
    const api = bridge(data)
    for (let open = 0; open < 5; open++) {
      const view = render(<UsageView {...props} bridge={api} />)
      await screen.findByRole('heading', { name: 'Prompts' })
      expect(api.refresh).not.toHaveBeenCalled()
      view.unmount()
    }
    render(<UsageView {...props} bridge={api} />)
    await screen.findByRole('heading', { name: 'Prompts' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh subscription limits' }))
    expect(api.refresh).toHaveBeenCalledOnce()
    expect(api.refresh).toHaveBeenCalledWith({})
  })
  it('automatically refreshes only stale provider readings on their owning computer', async () => {
    const data = dashboard()
    data.hosts[0]!.quotas[0]!.observedAt = '2026-10-12T15:59:31Z'
    data.hosts.push({ hostId: 'forge', status: 'ready', activity: activity(), quotas: [
      { providerId: 'grok', status: 'available', refreshable: true, observedAt: '2026-10-12T15:59:00Z', windows: [] },
      { providerId: 'claude', status: 'unavailable', refreshable: false, windows: [] },
    ] })
    const api = bridge(data)
    render(<UsageView {...props} bridge={api} />)
    await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce())
    expect(api.refresh).toHaveBeenCalledWith({ hostIds: ['forge'], providerIds: ['grok'] })
  })
  it('requests a first native reading once when a connected provider has no cached observation', async () => {
    const data = dashboard()
    data.hosts[0]!.quotas[0] = { providerId: 'grok', status: 'unavailable', refreshable: true, reason: 'not-read', windows: [] }
    const api = bridge(data)
    render(<UsageView {...props} bridge={api} />)
    await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce())
    expect(api.refresh).toHaveBeenCalledWith({ hostIds: ['laptop'], providerIds: ['grok'] })
  })
  it('does not claim an exact most-used model from an incomplete host ranking', async () => {
    const data = dashboard()
    data.hosts[0]!.activity!.modelsTruncated = true
    render(<UsageView {...props} bridge={bridge(data)} />)
    await screen.findByRole('tab', { name: /Most used model.*Ranking is incomplete/ })
    expect(screen.queryByRole('tab', { name: /Most used model gpt-6.1-sol/ })).not.toBeInTheDocument()
  })
  it('reads numeric data, counts accepted user prompts and shows unknown subscription percentages', async () => {
    const api = bridge()
    const user = userEvent.setup()
    render(<UsageView {...props} bridge={api} />)
    await screen.findByRole('heading', { name: 'Prompts' })
    expect(api.read).toHaveBeenCalledWith({ from: '2026-09-13', to: '2026-10-12', timeZone: 'America/Los_Angeles', includeDaily: true })
    expect(api.refresh).toHaveBeenCalledWith({ hostIds: ['laptop'], providerIds: ['grok'] })
    expect(screen.getByRole('tab', { name: /Prompts 3 accepted prompts from you/ })).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Subscriptions' }))
    const grok = screen.getByRole('region', { name: 'Grok Build on Laptop' })
    expect(within(grok).getByText('Percentage not reported.', { exact: false })).toBeVisible()
    expect(within(grok).queryByText('0%')).not.toBeInTheDocument()
    expect(screen.getByText('Updates when Claude Code reports limits.')).toBeVisible()
  })
  it('ignores a slow response from an earlier filter and passes provider and computer choices', async () => {
    const first = deferred<UsageDashboardRead>()
    const api = bridge()
    api.read = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(dashboard(8))
    api.refresh = vi.fn(() => new Promise<UsageDashboardRead>(() => undefined))
    const user = userEvent.setup()
    render(<UsageView {...props} bridge={api} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'codex')
    await screen.findByRole('tab', { name: /Prompts 8 accepted/ })
    await act(async () => first.resolve(dashboard(99)))
    expect(screen.queryByRole('tab', { name: /Prompts 99 accepted/ })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'laptop')
    await waitFor(() => expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ hostIds: ['laptop'], providerIds: ['codex'] })))
  })
  it('keeps unsupported and offline hosts visible while reading another host', async () => {
    const read = dashboard()
    read.hosts.push({ hostId: 'older', status: 'unsupported', quotas: [] }, { hostId: 'forge', status: 'offline', quotas: [] })
    render(<UsageView {...props} bridge={bridge(read)} computers={[...props.computers, { hostId: 'older', name: 'Older host' }, { hostId: 'forge', name: 'Forge' }]} />)
    await screen.findByRole('heading', { name: 'Prompts' })
    expect(screen.getByText(/Older host: usage needs an Owl host update/)).toBeVisible()
    expect(screen.getByText(/Forge: offline/)).toBeVisible()
    expect(screen.getByRole('tab', { name: /Prompts 3 accepted/ })).toBeVisible()
  })
  it('requires a new Clear confirmation when host figures changed, and restores focus on Escape', async () => {
    const api = bridge()
    api.clear = vi.fn(async () => [{ hostId: 'laptop', status: 'stale' as const }])
    const user = userEvent.setup()
    render(<UsageView {...props} bridge={api} />)
    await screen.findByRole('heading', { name: 'Prompts' })
    const trigger = screen.getByRole('button', { name: 'Clear usage' })
    await waitFor(() => expect(trigger).toBeEnabled())
    await user.click(trigger)
    expect(screen.getByRole('button', { name: 'Keep usage' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(api.clear).not.toHaveBeenCalled()
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Clear saved usage' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.clear).toHaveBeenCalledOnce()
    expect(api.clear).toHaveBeenCalledWith({ hosts: [{ hostId: 'laptop', expectedRevision: 7 }] })
    expect(screen.getByText(/Usage changed while the question was open/)).toBeVisible()
  })
  it('supports keyboard switching, hourly counts and an incomplete daily-range explanation', async () => {
    const read = dashboard()
    read.hosts[0]!.activity!.dailyCoverage = 'omitted-range'
    const user = userEvent.setup()
    render(<UsageView {...props} bridge={bridge(read)} />)
    await screen.findByRole('heading', { name: 'Prompts' })
    expect(screen.getByText(/Choose a date range of up to one year/)).toBeVisible()
    const tab = screen.getByRole('tab', { name: 'Overview' })
    tab.focus(); await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Subscriptions' })).toHaveFocus()
    await user.click(screen.getByRole('tab', { name: 'Overview' }))
    await user.click(screen.getByRole('tab', { name: /Busiest hour/ }))
    expect(screen.getByRole('heading', { name: 'When you work' })).toBeVisible()
    const hours = screen.getByRole('group', { name: 'Your prompts by weekday and hour' })
    hours.focus(); await user.keyboard('{ArrowRight}')
    expect(screen.getByText(/Mon, 1am: 0 prompts from you/)).toBeVisible()
  })
})

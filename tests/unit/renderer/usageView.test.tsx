import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageDashboardRead, UsageQuery } from '../../../src/shared/usageDashboard'
import { UsageView, type UsageComputer } from '../../../src/renderer/src/features/usage/UsageView'
import { deferred } from '../../fixtures/deferred'
import { USAGE_NOW, USAGE_ZONE, activityRow, dashboard, fixtureBridge, forgeHost, localActivity, localHost, oldForgeHost, tokens } from '../../fixtures/renderer/usageReads'

afterEach(cleanup)
const now = () => USAGE_NOW
const laptop = { hostId: 'laptop', name: 'zach-laptop', kind: 'local' as const, connected: true }
const forge = { hostId: 'forge', name: 'forge', kind: 'remote' as const, connected: true }
const props = { now, timeZone: USAGE_ZONE, computers: [laptop] }
const measures = () => screen.getByRole('tablist', { name: 'Usage measures' })
const measure = (name: RegExp) => within(measures()).getByRole('tab', { name })
const plainText = (): string => document.body.textContent ?? ''

async function open(read: UsageDashboardRead = dashboard(), computers: readonly UsageComputer[] = [laptop]) {
  const bridge = fixtureBridge(read)
  const view = render(<UsageView {...props} computers={computers} bridge={bridge} />)
  await screen.findByRole('tablist', { name: 'Usage measures' })
  return { bridge, view, user: userEvent.setup() }
}

describe('Usage page', () => {
  it('draws the header, the views, the filters and every index measure', async () => {
    const { bridge } = await open()
    expect(screen.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
    expect(screen.getByText('Your subscriptions, and the work on each computer, in Sotto and outside it.')).toBeVisible()
    expect(within(screen.getByRole('tablist', { name: 'Usage views' })).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Overview', 'Subscriptions', 'Models'])
    for (const name of ['Date range: Last 30 days', 'Provider: All providers', 'Computer: All computers', 'Where: Everywhere']) expect(screen.getByRole('button', { name })).toBeVisible()
    expect(within(measures()).getAllByRole('tab')).toHaveLength(7)
    expect(measure(/^Room left 55% Lowest: Codex, week$/u)).toBeVisible()
    expect(measure(/^Prompts 200 Sep 15 – Oct 14$/u)).toHaveAttribute('aria-selected', 'true')
    expect(measure(/^Tokens 42\.0M input \+ output$/u)).toBeVisible()
    expect(measure(/^Where 71% in Sotto of tokens · 65% of prompts$/u)).toBeVisible()
    expect(measure(/^From cache 88% of input tokens$/u)).toBeVisible()
    expect(measure(/^Most used model Claude Opus 5\.5 70% of prompts$/u)).toBeVisible()
    expect(measure(/^Busiest hour Wed 10 AM when you send the most$/u)).toBeVisible()
    expect(bridge.reads[0]).toEqual({ timeZone: USAGE_ZONE, includeDaily: true, from: '2026-09-15', to: '2026-10-14', hostIds: ['laptop'] })
  })

  it('shows prompts per day in plain dates, by provider, by the app that sent them and by who sent them', async () => {
    await open()
    const stage = screen.getByRole('tabpanel', { name: /Prompts/u })
    expect(within(stage).getByRole('heading', { name: 'Prompts' })).toBeVisible()
    expect(within(stage).getByText('Sep 15')).toBeVisible()
    expect(within(stage).getByText('Today')).toBeVisible()
    expect(stage).toHaveTextContent('About 7 a day · most on Oct 9, 80')
    expect(stage).toHaveTextContent('By provider')
    expect(stage).toHaveTextContent('Claude Code150')
    expect(stage).toHaveTextContent('Sent from')
    expect(stage).toHaveTextContent('Sotto130')
    expect(stage).toHaveTextContent('codex exec30')
    expect(stage).toHaveTextContent('You sent 190, Watcher 0 and wake-ups 10.')
    expect(plainText()).not.toMatch(/\d{4}-\d{2}-\d{2}/u)
  })

  it('reads a day from the chart with the arrow keys and lets go on Escape', async () => {
    const { user } = await open()
    const chart = screen.getByRole('group', { name: /^Prompts per day, Sep 15 – Oct 14\./u })
    chart.focus(); await user.keyboard('{End}')
    expect(screen.getByRole('tabpanel', { name: /Prompts/u })).toHaveTextContent('Wednesday, October 14, so far · 60 prompts')
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tabpanel', { name: /Prompts/u })).toHaveTextContent('Tuesday, October 13 · 60 prompts')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('tabpanel', { name: /Prompts/u })).toHaveTextContent('About 7 a day')
  })

  it('says why the share from cache is missing rather than calling reported tokens absent', async () => {
    const host = localHost()
    host.activity = { ...host.activity!, totals: activityRow(190, 10, 0, tokens(0, 500, 0, 0)) }
    const { user } = await open(dashboard(host))
    await user.click(measure(/^From cache /u))
    expect(screen.getByRole('tabpanel', { name: /From cache/u })).toHaveTextContent('No input tokens in this range, so none came from cache.')
  })
  it('keeps reported cache reads from reading as no token counts when input was not reported', async () => {
    const host = localHost()
    host.activity = { ...host.activity!, totals: activityRow(190, 10, 0, { ...tokens(), cached: { value: 100, knownRows: 1, rows: 1, partial: true } }) }
    const { user } = await open(dashboard(host))
    await user.click(measure(/^From cache /u))
    expect(screen.getByRole('tabpanel', { name: /From cache/u })).toHaveTextContent("Input tokens weren't reported in this range, so the share from cache can't be worked out.")
  })
  it('moves through the index with the arrow keys and opens each stage', async () => {
    const { user } = await open()
    measure(/^Prompts /u).focus()
    await user.keyboard('{ArrowDown}')
    expect(measure(/^Tokens /u)).toHaveFocus()
    const tokens = screen.getByRole('tabpanel', { name: /Tokens/u })
    expect(tokens).toHaveTextContent('Subagents: 22.0M of these tokens.')
    expect(within(tokens).getByRole('img', { name: '41.0M input tokens, including 36.0M cache read and 900K cache write, then 1.0M output tokens.' })).toBeVisible()
    for (const name of ['Cache read', 'Cache write', 'Uncached input', 'Output']) expect(within(tokens).getByText(name, { selector: 'dt' })).toBeVisible()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('heading', { name: 'Where you work' })).toBeVisible()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('heading', { name: 'Cache reads' })).toBeVisible()
    expect(screen.getByText(/36\.0M of 41\.0M input tokens were read from cache/u)).toBeVisible()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('heading', { name: 'Models' })).toBeVisible()
    expect(screen.getByText(/28\.0M tokens · 95% from cache · 9 provider sessions/u)).toBeVisible()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('heading', { name: 'When you work' })).toBeVisible()
    expect(screen.getByText('Wednesdays around 10 AM')).toBeVisible()
    const grid = screen.getByRole('group', { name: /^Prompts you sent, by weekday and hour/u })
    grid.focus(); await user.keyboard('{ArrowRight}')
    expect(screen.getByText('Mondays, 10 AM to 11 AM')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.getByText('Wednesdays around 10 AM')).toBeVisible()
    measure(/^Busiest hour /u).focus(); await user.keyboard('{Home}')
    expect(screen.getByRole('heading', { name: 'Room left' })).toBeVisible()
    expect(screen.getByText("Sotto can't read these limits yet")).toBeVisible()
  })

  it('splits the work by place: Sotto threads, their subagents, then each app outside Sotto', async () => {
    const { user } = await open()
    await user.click(measure(/^Where /u))
    const stage = screen.getByRole('tabpanel', { name: /Where/u })
    const rows = within(stage).getAllByRole('listitem')
    expect(rows.map(row => row.querySelector('.usage-share__name')?.textContent)).toEqual(["Sotto's subagents", 'Sotto threads', 'Claude Code', 'codex exec'])
    expect(rows[0]).toHaveTextContent('No prompts of their own. Your Sotto threads started them.')
    expect(rows[1]).toHaveTextContent('130 prompts, 10 of them wake-ups')
    expect(rows[2]).toHaveTextContent('40 prompts · 2.0M of the tokens from subagents')
    expect(rows[2]).toHaveTextContent('19%')
    expect(rows[3]).toHaveTextContent('30 prompts')
    expect(stage).toHaveTextContent('71% of tokens and 65% of prompts were in Sotto.')
    expect(stage).toHaveTextContent('In SottoOutside Sotto')
    // CONTEXT.md: say Outside Sotto, never "elsewhere".
    expect(plainText()).not.toMatch(/Elsewhere|elsewhere|sub-agent/u)
  })

  it('opens a filter from the keyboard, chooses a place and returns focus on Escape', async () => {
    const { bridge, user } = await open()
    const where = screen.getByRole('button', { name: 'Where: Everywhere' })
    where.focus(); await user.keyboard('{ArrowDown}')
    const list = screen.getByRole('listbox', { name: 'Where' })
    expect(within(list).getByRole('option', { name: 'Everywhere' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(where).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.click(within(screen.getByRole('listbox', { name: 'Where' })).getByRole('option', { name: 'Outside Sotto' }))
    expect(screen.getByRole('button', { name: 'Where: Outside Sotto' })).toHaveFocus()
    await waitFor(() => expect(bridge.reads.at(-1)).toEqual(expect.objectContaining({ sources: ['outside'], hostIds: ['laptop'] })))
  })

  it('reads every computer at once and paints the first that answers', async () => {
    const read = dashboard(localHost(), forgeHost())
    const bridge = fixtureBridge(read)
    const slow = deferred<UsageDashboardRead>()
    const answer = bridge.read
    bridge.read = vi.fn((query: UsageQuery) => query.hostIds?.[0] === 'forge' && query.since === undefined ? slow.promise : answer(query))
    render(<UsageView {...props} computers={[laptop, forge]} bridge={bridge} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading usage…')
    await screen.findByRole('tablist', { name: 'Usage measures' })
    expect(bridge.read).toHaveBeenCalledWith(expect.objectContaining({ hostIds: ['forge'] }))
    expect(measure(/^Prompts 200 /u)).toBeVisible()
    expect(screen.getByText('Still reading forge…')).toBeVisible()
    await act(async () => slow.resolve({ hosts: [forgeHost()] }))
    expect(measure(/^Prompts 220 /u)).toBeVisible()
    expect(screen.queryByText('Still reading forge…')).not.toBeInTheDocument()
  })

  it('still works with a host from before history, and says what it leaves out', async () => {
    const { bridge, user } = await open(dashboard(localHost(), oldForgeHost()), [laptop, forge])
    expect(measure(/^Prompts 230 /u)).toBeVisible()
    expect(measure(/^Where 75% in Sotto of tokens · 70% of prompts$/u)).toBeVisible()
    expect(screen.getByRole('tabpanel', { name: /Prompts/u })).toHaveTextContent('forge counts only its Sotto threads until its host update.')
    await user.click(measure(/^Where /u))
    expect(screen.getByRole('tabpanel', { name: /Where/u })).toHaveTextContent('forge counts only its Sotto threads until its host update.')
    await user.click(screen.getByRole('button', { name: 'Where: Everywhere' }))
    await user.click(screen.getByRole('option', { name: 'Outside Sotto' }))
    await waitFor(() => expect(bridge.reads.filter(query => query.sources?.[0] === 'outside')).toHaveLength(2))
    // forge's figures are all Sotto threads, so outside Sotto it adds nothing.
    await waitFor(() => expect(measure(/^Prompts 200 /u)).toBeVisible())
  })

  it('keeps an offline computer named and shows one without history as waiting for its update', async () => {
    await open(dashboard(localHost(), { hostId: 'forge', status: 'offline', quotas: [] }), [laptop, forge])
    expect(screen.getByText('forge is offline. Its figures appear when it reconnects.')).toBeVisible()
    expect(measure(/^Prompts 200 /u)).toBeVisible()
    cleanup()
    const bridge = fixtureBridge(dashboard({ hostId: 'forge', status: 'unsupported', quotas: [] }))
    render(<UsageView {...props} computers={[forge]} bridge={bridge} />)
    expect(await screen.findByRole('heading', { name: 'No history from forge yet' })).toBeVisible()
    expect(screen.getByText("forge's history appears after its host update.")).toBeVisible()
  })

  it('gives each provider one section with its freshest reading and other computers beside it', async () => {
    const { bridge, user } = await open(dashboard(localHost(), forgeHost()), [laptop, forge])
    await user.click(screen.getByRole('tab', { name: 'Subscriptions' }))
    expect(screen.queryByRole('button', { name: /^Date range/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Where/u })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Computer: All computers' })).toBeVisible()
    expect(screen.getAllByRole('region').filter(region => region.hasAttribute('aria-labelledby')).map(region => within(region).getByRole('heading', { level: 2 }).textContent)).toEqual(['Codex', 'Claude Code', 'Grok Build', 'Devin'])
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(codex).toHaveTextContent('Read just now · This computer')
    expect(codex).toHaveTextContent('On forge: 56% left, week · read 4 min ago')
    expect(codex).toHaveTextContent('Resets Monday, Oct 19, 9:58 PM, in 5 days')
    expect(codex).toHaveTextContent('78% of the time left')
    expect(within(codex).getByRole('img', { name: "Week: 55% of the allowance left, 78% of the window's time left" })).toBeVisible()
    await waitFor(() => expect(codex).toHaveTextContent('Since this window began: 12 prompts and 3.0M tokens on this computer, 2.0M of them in Sotto.'))
    expect(bridge.reads.some(query => query.since === '2026-10-13T04:58:00.000Z' && query.hostIds?.[0] === 'laptop' && query.providerIds?.[0] === 'codex')).toBe(true)
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('5 hours')).toBeVisible()
    expect(within(claude).getByText('Week')).toBeVisible()
    expect(claude).toHaveTextContent('Resets today 1:00 PM, in 2 h 20 min')
    expect(claude).toHaveTextContent('Resets Wednesday, Oct 21, 6:00 AM, in 7 days')
    const grok = screen.getByRole('region', { name: 'Grok Build' })
    expect(grok).toHaveTextContent('Grok reports when this resets, not how much is used.')
    expect(within(grok).getByRole('img', { name: /^Week: use not reported/u })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Devin' })).toHaveTextContent("Sotto can't read Devin's limits yet.")
    expect(within(screen.getByRole('region', { name: 'Devin' })).queryByRole('button')).not.toBeInTheDocument()
    expect(plainText()).not.toMatch(/\d{4}-\d{2}-\d{2}/u)
  })

  it('reads a provider again on request, Claude included, and keeps focus on the button', async () => {
    const { bridge, user } = await open()
    const refresh = vi.spyOn(bridge, 'refresh')
    await user.click(screen.getByRole('tab', { name: 'Subscriptions' }))
    const again = within(screen.getByRole('region', { name: 'Claude Code' })).getByRole('button', { name: 'Read Claude Code limits again' })
    await user.click(again)
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ hostIds: ['laptop'], providerIds: ['claude'] }))
    await waitFor(() => expect(again).toHaveTextContent('Read again'))
    expect(again).toHaveFocus()
  })

  it('never shows a window whose reset has passed as current', async () => {
    const host = localHost()
    host.quotas[1]!.windows[0] = { id: 'five-hour', kind: 'primary', label: 'Current session', usedPercent: 92, resetsAt: '2026-10-14T16:00:00Z', durationMinutes: 300 }
    const { user } = await open(dashboard(host))
    await user.click(screen.getByRole('tab', { name: 'Subscriptions' }))
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).queryByText('5 hours')).not.toBeInTheDocument()
    expect(claude).not.toHaveTextContent('8%')
    expect(within(claude).getByText('Week')).toBeVisible()
  })

  it('lists one row per served model with its details, and Escape closes them', async () => {
    const { bridge, user } = await open()
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    expect(screen.getByText(/models · /u).closest('p')).toHaveTextContent('4 models · 200 prompts · 42.0M tokens · Sep 15 – Oct 14')
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.usage-row__main')]
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      'Claude Opus 5.5, Claude Code: 140 prompts, 28.0M tokens, 95% from cache',
      'GPT-6.1 Sol, Codex: 50 prompts, 12.0M tokens, 78% from cache',
      'Model not reported, Claude Code: 10 prompts, tokens not reported',
      'Claude Haiku 4.5, Claude Code: 0 prompts, 2.0M tokens, 53% from cache',
    ])
    expect(screen.getByText('All models').parentElement).toHaveTextContent('All models20042.0M88%')
    await user.click(screen.getByRole('radio', { name: 'Tokens' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Cache' })).toHaveAttribute('aria-checked', 'true')
    const opus = screen.getByRole('button', { name: /^Claude Opus 5\.5,/u })
    await user.click(opus)
    expect(opus).toHaveAttribute('aria-expanded', 'true')
    const detail = document.getElementById(opus.getAttribute('aria-controls')!)!
    for (const name of ['Input', 'Cache read', 'Cache write', 'Output', 'Tokens per prompt', 'Provider sessions', 'Days used', 'Last used']) expect(within(detail).getByText(name)).toBeVisible()
    expect(detail).toHaveTextContent('Tokens per prompt200K')
    expect(detail).toHaveTextContent('Last usedToday')
    await waitFor(() => expect(bridge.reads.some(query => query.modelIds?.[0] === 'claude-opus-5-5' && query.providerIds?.[0] === 'claude')).toBe(true))
    await waitFor(() => expect(detail).toHaveTextContent('Prompts per day'))
    await user.keyboard('{Escape}')
    expect(opus).toHaveAttribute('aria-expanded', 'false')
    expect(opus).toHaveFocus()
    await user.click(screen.getByRole('button', { name: /^GPT-6\.1 Sol,/u }))
    expect(document.getElementById(screen.getByRole('button', { name: /^GPT-6\.1 Sol,/u }).getAttribute('aria-controls')!)).toHaveTextContent('Cache write—Not reported')
    expect(plainText()).not.toMatch(/claude-opus-5-5|gpt-6\.1-sol/u)
  })

  it('refreshes only stale limit readings on the computer that owns them when the page opens', async () => {
    const forgeRead = forgeHost()
    forgeRead.quotas[0]!.observedAt = new Date(USAGE_NOW.getTime() - 5 * 60_000).toISOString()
    const bridge = fixtureBridge(dashboard(localHost(), forgeRead))
    const refresh = vi.spyOn(bridge, 'refresh')
    render(<UsageView {...props} computers={[laptop, forge]} bridge={bridge} />)
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(refresh).toHaveBeenCalledWith({ hostIds: ['forge'], providerIds: ['codex'] })
  })

  it('reads Claude again on open when its fresh reading names no share', async () => {
    // A Claude Code event can carry a window's status and reset without its share; the page asks get_usage for it.
    const host = localHost()
    host.quotas = host.quotas.map(quota => quota.providerId !== 'claude' ? quota
      : { ...quota, windows: quota.windows.map(window => { const shareless = { ...window, status: 'allowed' as const }; delete shareless.usedPercent; return shareless }) })
    const bridge = fixtureBridge(dashboard(host))
    const refresh = vi.spyOn(bridge, 'refresh')
    render(<UsageView {...props} bridge={bridge} />)
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(refresh).toHaveBeenCalledWith({ hostIds: ['laptop'], providerIds: ['claude'] })
  })

  it('says nothing is recorded yet once usage was cleared, keeping the room-left gauges', async () => {
    const empty = activityRow(0, 0, 0, tokens())
    const cleared = localActivity(9)
    const host = { ...localHost(), activity: { ...cleared, metadata: { ...cleared.metadata, clearedAt: '2026-10-14T17:30:00.000Z' },
      totals: empty, providers: [], models: [], modelCount: 0, daily: [], hourly: [], clients: [] } }
    const bridge = fixtureBridge(dashboard(host))
    const user = userEvent.setup()
    render(<UsageView {...props} bridge={bridge} />)
    expect(await screen.findByRole('heading', { name: 'Nothing recorded yet' })).toBeVisible()
    expect(screen.getByText('Usage starts counting again with your next prompt.')).toBeVisible()
    expect(screen.getByRole('button', { name: /Claude Code/u })).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    expect(await screen.findByRole('heading', { name: 'No models recorded yet' })).toBeVisible()
  })

  it('shows an unreported token figure as a dash and an incomplete one as at least', async () => {
    const host = localHost()
    const totals = host.activity!.totals
    host.activity = { ...host.activity!, totals: { ...totals, tokens: { ...totals.tokens,
      cached: { knownRows: 0, rows: 10, partial: true }, input: { ...totals.tokens.input, partial: true } } } }
    const { user } = await open(dashboard(host))
    await user.click(measure(/^Tokens/u))
    const legend = await screen.findByText('Cache read')
    expect(legend.closest('div')).toHaveTextContent('—')
    expect(legend.closest('div')?.querySelector('dd')?.textContent).not.toBe('0')
    expect(screen.getAllByText('at least').length).toBeGreaterThan(0)
  })

  it('closes a menu whose every action is disabled with Escape, and when focus leaves it', async () => {
    // A computer whose host does not offer Usage has nothing to clear, so the menu's one action is disabled.
    render(<UsageView {...props} bridge={fixtureBridge(dashboard({ hostId: 'laptop', status: 'unsupported', quotas: [] }))} />)
    const user = userEvent.setup()
    const more = await screen.findByRole('button', { name: 'More usage actions' })
    await user.click(more)
    const menu = await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    expect(menu).not.toBeInTheDocument()
    expect(more).toHaveFocus()
    await user.click(more); await screen.findByRole('menu')
    await user.tab()
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
  it('shows the unreported cache share of a model as a dash and asks an older host for its details by public ID', async () => {
    const host = localHost()
    host.activity = { ...host.activity!, models: host.activity!.models.map(row => row.modelId !== 'gpt-6.1-sol' ? row
      : { ...row, tokens: { ...row.tokens, cached: { knownRows: 0, rows: 4, partial: true } } }) }
    const { bridge, user } = await open(dashboard(host))
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    const sol = await screen.findByRole('button', { name: /GPT-6\.1 Sol/u })
    expect(sol).toHaveAccessibleName(/an unreported share from cache/u)
    await user.click(sol)
    await waitFor(() => expect(bridge.reads.some(query => query.modelIds?.includes('native:codex:model:gpt-6.1-sol'))).toBe(true))
    expect(bridge.reads.find(query => query.modelIds !== undefined)?.modelIds).toEqual(['gpt-6.1-sol', 'native:codex:model:gpt-6.1-sol'])
  })
  it('asks an older host for a model by the dated spelling it stored as well as the served one', async () => {
    const host = localHost()
    host.activity = { ...host.activity!, models: host.activity!.models.map(row => row.modelId === 'claude-haiku-4-5' ? { ...row, modelId: 'native:claude:model:claude-haiku-4-5-20251001' } : row) }
    const { bridge, user } = await open(dashboard(host))
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    await user.click(await screen.findByRole('button', { name: /Claude Haiku 4\.5/u }))
    await waitFor(() => expect(bridge.reads.some(query => query.modelIds !== undefined)).toBe(true))
    expect(bridge.reads.find(query => query.modelIds !== undefined)?.modelIds)
      .toEqual(['claude-haiku-4-5', 'native:claude:model:claude-haiku-4-5', 'native:claude:model:claude-haiku-4-5-20251001'])
  })
  it('clears usage from the … menu with a confirmation, and asks again when figures changed', async () => {
    const { bridge, user } = await open()
    const clear = vi.spyOn(bridge, 'clear').mockResolvedValueOnce([{ hostId: 'laptop', status: 'stale' }])
    const more = screen.getByRole('button', { name: 'More usage actions' })
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Clear usage…' }))
    expect(screen.getByRole('dialog', { name: 'Clear saved usage?' })).toHaveTextContent("Thread history, subscription limits and the clients' own records stay as they are.")
    expect(screen.getByRole('button', { name: 'Keep usage' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(more).toHaveFocus()
    expect(clear).not.toHaveBeenCalled()
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Clear usage…' }))
    await user.click(screen.getByRole('button', { name: 'Clear saved usage' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(clear).toHaveBeenCalledWith({ hosts: [{ hostId: 'laptop', expectedRevision: 7 }] })
    expect(screen.getByText(/Usage changed while the question was open/u)).toBeVisible()
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Clear usage…' }))
    await user.click(screen.getByRole('button', { name: 'Clear saved usage' }))
    expect(await screen.findByText('Saved usage figures were cleared on the selected computers.')).toBeVisible()
  })

  it('switches views from the keyboard and closes the about list with Escape', async () => {
    const { user } = await open()
    screen.getByRole('tab', { name: 'Overview' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Subscriptions' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Subscriptions' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true')
    const summary = screen.getByText('About these numbers')
    await user.click(summary)
    expect(summary.closest('details')).toHaveAttribute('open')
    // jsdom does not focus a pressed summary the way Chromium does.
    summary.focus()
    await user.keyboard('{Escape}')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    expect(summary).toHaveFocus()
  })

  it('opens a provider section from a Room left gauge on a computer without history', async () => {
    const forgeOnly = { ...forgeHost(), activity: undefined, status: 'unsupported' as const }
    forgeOnly.quotas = forgeHost().quotas
    const bridge = fixtureBridge(dashboard(forgeOnly))
    const user = userEvent.setup()
    render(<UsageView {...props} computers={[forge]} bridge={bridge} />)
    const gauge = await screen.findByRole('button', { name: /^Codex: 56% left in the weekly window, resets Monday, Oct 19, 9:58 PM, in 5 days\. Open Subscriptions$/u })
    await user.click(gauge)
    expect(screen.getByRole('heading', { level: 2, name: 'Codex' })).toHaveFocus()
  })

  it('reads a computer again when it reconnects, keeping what is shown meanwhile', async () => {
    let forgeRead: UsageDashboardRead['hosts'][number] = { hostId: 'forge', status: 'offline', quotas: [] }
    const bridge = fixtureBridge(dashboard(localHost()))
    const answer = bridge.read
    bridge.read = vi.fn(async (query: UsageQuery) => query.hostIds?.[0] === 'forge' ? { hosts: [forgeRead] } : answer(query))
    const view = render(<UsageView {...props} computers={[laptop, { ...forge, connected: false }]} bridge={bridge} />)
    expect(await screen.findByText('forge is offline. Its figures appear when it reconnects.')).toBeVisible()
    forgeRead = forgeHost()
    view.rerender(<UsageView {...props} computers={[laptop, forge]} bridge={bridge} />)
    await waitFor(() => expect(measure(/^Prompts 220 /u)).toBeVisible())
    expect(screen.queryByText(/forge is offline/u)).not.toBeInTheDocument()
  })

  it('shows the failure rather than empty figures when the first read for new filters fails', async () => {
    const { bridge, user } = await open()
    bridge.read = vi.fn(() => Promise.reject(new Error('lost')))
    await user.click(screen.getByRole('button', { name: 'Where: Everywhere' }))
    await user.click(screen.getByRole('option', { name: 'Outside Sotto' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be read from this computer. Your saved figures were not changed./u)
    expect(screen.queryByRole('tablist', { name: 'Usage measures' })).not.toBeInTheDocument()
  })
  it('names the computer that failed to answer and offers to try again', async () => {
    const bridge = fixtureBridge(dashboard(localHost(), forgeHost()))
    const answer = bridge.read
    let fail = true
    bridge.read = vi.fn((query: UsageQuery) => query.hostIds?.[0] === 'forge' && fail ? Promise.reject(new Error('lost')) : answer(query))
    const user = userEvent.setup()
    render(<UsageView {...props} computers={[laptop, forge]} bridge={bridge} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Usage could not be read from forge. Your saved figures were not changed.')
    expect(measure(/^Prompts 200 /u)).toBeVisible()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(measure(/^Prompts 220 /u)).toBeVisible())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageBridge, UsageQuery } from '../../../src/shared/usageDashboard'
import { UsageView } from '../../../src/renderer/src/features/usage/UsageView'
import { forgetChartChoice } from '../../../src/renderer/src/features/usage/UsagePerDay'
import { deferred } from '../../fixtures/deferred'
import { USAGE_NOW, USAGE_ZONE, dashboard, fixtureBridge, localHost, splitBridge } from '../../fixtures/renderer/usageReads'

afterEach(() => { cleanup(); forgetChartChoice() })
const laptop = { hostId: 'laptop', name: 'zach-laptop', kind: 'local' as const, connected: true }
const measure = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Usage measures' })).getByRole('tab', { name })
const show = () => screen.getByRole('radiogroup', { name: 'Show on the chart' })
const style = () => screen.getByRole('radiogroup', { name: 'Draw the days as' })
const plot = (metric = 'Prompts') => screen.getByRole('group', { name: new RegExp(`^${metric} per day, `, 'u') })
const valueList = () => screen.getByRole('list', { name: /^Each (model|provider), / })
const values = () => within(valueList()).getAllByRole('listitem').map(item => [item.querySelector('span')!.textContent, item.querySelector('b')!.textContent])
const tones = () => Object.fromEntries(within(valueList()).getAllByRole('listitem').map(item => [item.querySelector('span')!.textContent, item.querySelector('i')!.getAttribute('data-tone')]))
const filteredReads = (bridge: { reads: UsageQuery[] }) => bridge.reads.filter(query => query.providerIds !== undefined || query.modelIds !== undefined)

async function open(bridge: UsageBridge = splitBridge()) {
  const view = render(<UsageView now={() => USAGE_NOW} timeZone={USAGE_ZONE} computers={[laptop]} bridge={bridge} />)
  await screen.findByRole('tablist', { name: 'Usage measures' })
  return { view, user: userEvent.setup() }
}

describe('Usage Per day chart split', () => {
  it('splits prompts by model: the top five by prompts, then Other, stacked, with every series named and its range total', async () => {
    const bridge = splitBridge()
    const { user } = await open(bridge)
    expect(within(show()).getByRole('radio', { name: 'Total' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('list', { name: /^Each / })).toBeNull()
    expect(filteredReads(bridge)).toEqual([])
    await user.click(within(show()).getByRole('radio', { name: 'By model' }))
    await waitFor(() => expect(values()[0]![1]).toBe('56'))
    expect(values()).toEqual([['Claude Opus 5.5', '56'], ['GPT-6.1 Sol', '30'], ['Claude Sonnet 5.5', '15'], ['Grok code 2', '7'], ['GPT-6 Mini', '5'], ['Other (2)', '5']])
    expect(within(valueList()).getByText('Other (2)').closest('li')).toHaveAttribute('title', 'Claude Haiku 4.5, Swe 1')
    expect(plot()).toHaveAccessibleName(/^Prompts per day, Sep 15 – Oct 14\. Stacked by model: Claude Opus 5\.5, GPT-6\.1 Sol, Claude Sonnet 5\.5, Grok code 2, GPT-6 Mini and Other \(2\)\. Use Left/u)
    // One filtered read for each drawn model, by every spelling its computers stored; Other is worked out, not read.
    const reads = filteredReads(bridge)
    expect(reads).toHaveLength(5)
    expect(reads[0]).toMatchObject({ includeDaily: true, providerIds: ['claude'], modelIds: ['claude-opus-5-5', 'native:claude:model:claude-opus-5-5'], hostIds: ['laptop'] })
    // October 9 stacks five pieces, the largest at the foot, and stays its day's total.
    const columns = plot().querySelectorAll('.usage-chart__column')
    expect(columns).toHaveLength(30)
    const october9 = [...columns[24]!.querySelectorAll('.usage-chart__bar')]
    expect(october9.map(bar => bar.getAttribute('data-tone'))).toEqual(['1', '2', '3', '5', 'other'])
    expect(october9.at(-1)).toHaveAttribute('data-top')
  })

  it('draws one unstacked line per series on Lines, and keeps Total looking as it did', async () => {
    const { user } = await open()
    expect(plot().querySelectorAll('.usage-chart__column')).toHaveLength(30)
    await user.click(within(style()).getByRole('radio', { name: 'Lines' }))
    expect(plot().querySelectorAll('.usage-chart__column')).toHaveLength(0)
    expect(plot().querySelectorAll('.usage-chart__line')).toHaveLength(1)
    await user.click(within(show()).getByRole('radio', { name: 'By provider' }))
    await waitFor(() => expect(plot().querySelectorAll('.usage-chart__line')).toHaveLength(4))
    expect(values()).toEqual([['Claude Code', '74'], ['Codex', '35'], ['Grok Build', '7'], ['Devin', '2']])
    expect(tones()).toEqual({ 'Claude Code': '2', Codex: '1', 'Grok Build': '5', Devin: '3' })
    expect(plot()).toHaveAccessibleName(/One line by provider: Claude Code, Codex, Grok Build and Devin\./u)
    expect(valueList()).toHaveAttribute('data-kind', 'lines')
  })

  it('reads every series for a day from the keyboard, announces them, and goes back to the range on Escape', async () => {
    const { user } = await open()
    await user.click(within(show()).getByRole('radio', { name: 'By model' }))
    await waitFor(() => expect(values()[0]![1]).toBe('56'))
    plot().focus()
    await user.keyboard('{End}')
    expect(values()).toEqual([['Claude Opus 5.5', '6'], ['GPT-6.1 Sol', '3'], ['Claude Sonnet 5.5', '1'], ['Grok code 2', '1'], ['GPT-6 Mini', '0'], ['Other (2)', '1']])
    expect(valueList()).toHaveAccessibleName('Each model, Wednesday, October 14, so far')
    expect(screen.getByRole('tabpanel', { name: /Prompts/u })).toHaveTextContent('Wednesday, October 14, so far · 12 prompts in all')
    expect(await screen.findByText('Wednesday, October 14, so far: 12 prompts. Claude Opus 5.5 6, GPT-6.1 Sol 3, Claude Sonnet 5.5 1, Grok code 2 1, GPT-6 Mini 0, Other (2) 1')).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(values()[0]).toEqual(['Claude Opus 5.5', '11'])
    await user.keyboard('{Escape}')
    expect(values()[0]).toEqual(['Claude Opus 5.5', '56'])
    expect(await screen.findByText('Whole range: 118 prompts. Claude Opus 5.5 56, GPT-6.1 Sol 30, Claude Sonnet 5.5 15, Grok code 2 7, GPT-6 Mini 5, Other (2) 5')).toBeInTheDocument()
    expect(plot()).toHaveFocus()
  })

  it('moves Show and Bars | Lines with the arrow keys from one Tab stop each', async () => {
    const { user } = await open()
    const total = within(show()).getByRole('radio', { name: 'Total' })
    expect(within(show()).getAllByRole('radio').map(radio => radio.tabIndex)).toEqual([0, -1, -1])
    total.focus(); await user.keyboard('{ArrowRight}')
    expect(within(show()).getByRole('radio', { name: 'By provider' })).toHaveFocus()
    expect(within(show()).getByRole('radio', { name: 'By provider' })).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{End}')
    expect(within(show()).getByRole('radio', { name: 'By model' })).toHaveAttribute('aria-checked', 'true')
    await user.tab()
    expect(within(style()).getByRole('radio', { name: 'Bars' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(within(style()).getByRole('radio', { name: 'Lines' })).toHaveAttribute('aria-checked', 'true')
  })

  it('remembers the choice across Prompts and Tokens, tabs and leaving Usage, and keeps a drawn model on its colour', async () => {
    const { user, view } = await open()
    await user.click(within(show()).getByRole('radio', { name: 'By model' }))
    await user.click(within(style()).getByRole('radio', { name: 'Lines' }))
    await waitFor(() => expect(values()[0]![1]).toBe('56'))
    const before = tones()
    await user.click(measure(/^Tokens /u))
    expect(within(show()).getByRole('radio', { name: 'By model' })).toHaveAttribute('aria-checked', 'true')
    expect(within(style()).getByRole('radio', { name: 'Lines' })).toHaveAttribute('aria-checked', 'true')
    // Tokens ranks by input and output: Claude Haiku comes in, GPT-6 Mini goes to Other, and Devin, with no tokens, is not offered.
    await waitFor(() => expect(values()[0]![1]).toBe('11.3M'))
    expect(values()).toEqual([['Claude Opus 5.5', '11.3M'], ['Claude Haiku 4.5', '9.1M'], ['GPT-6.1 Sol', '4.5M'], ['Claude Sonnet 5.5', '1.5M'], ['Grok code 2', '566K'], ['Other (1)', '202K']])
    const after = tones()
    for (const name of ['Claude Opus 5.5', 'GPT-6.1 Sol', 'Claude Sonnet 5.5', 'Grok code 2']) expect(after[name], name).toBe(before[name])
    expect(after['Claude Haiku 4.5']).toBe(before['GPT-6 Mini'])
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    await user.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(within(show()).getByRole('radio', { name: 'By model' })).toHaveAttribute('aria-checked', 'true')
    view.unmount()
    await open()
    expect(within(show()).getByRole('radio', { name: 'By model' })).toHaveAttribute('aria-checked', 'true')
    expect(within(style()).getByRole('radio', { name: 'Lines' })).toHaveAttribute('aria-checked', 'true')
  })

  it('leaves Devin out of tokens by provider and keeps the note that it reports none', async () => {
    const { user } = await open()
    await user.click(measure(/^Tokens /u))
    await user.click(within(show()).getByRole('radio', { name: 'By provider' }))
    await waitFor(() => expect(values()).toHaveLength(3))
    expect(values().map(row => row[0])).toEqual(['Claude Code', 'Codex', 'Grok Build'])
    expect(screen.getByRole('tabpanel', { name: /Tokens/u })).toHaveTextContent("Devin doesn't report tokens, so its 2 prompts aren't in these totals.")
  })

  it('keeps the frame and names the series while their days are read, drawing nothing until they arrive', async () => {
    const gate = deferred<void>()
    const { user } = await open(splitBridge(() => gate.promise))
    await user.click(within(show()).getByRole('radio', { name: 'By model' }))
    expect(plot()).toHaveAttribute('aria-busy', 'true')
    expect(plot()).toHaveTextContent("Reading each model's days…")
    expect(plot().querySelectorAll('.usage-chart__bar')).toHaveLength(0)
    expect(values()).toEqual([['Claude Opus 5.5', ''], ['GPT-6.1 Sol', ''], ['Claude Sonnet 5.5', ''], ['Grok code 2', ''], ['GPT-6 Mini', ''], ['Other (2)', '']])
    gate.resolve()
    await waitFor(() => expect(plot()).not.toHaveAttribute('aria-busy'))
    expect(values()[0]).toEqual(['Claude Opus 5.5', '56'])
  })

  it('says when the split could not be read and reads it again on request', async () => {
    let fail = true
    const { user } = await open(splitBridge(async () => { if (fail) throw new Error('offline') }))
    await user.click(within(show()).getByRole('radio', { name: 'By provider' }))
    expect(await screen.findByText(/^Each provider's days couldn't be read\. Nothing was lost, and the totals above still count them\./u)).toBeVisible()
    expect(plot().querySelectorAll('.usage-chart__line, .usage-chart__bar')).toHaveLength(0)
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(values()[0]).toEqual(['Claude Code', '74']))
    expect(screen.queryByText(/couldn't be read/u)).toBeNull()
  })

  it('offers no split when the host left days out, and keeps its sentence', async () => {
    const host = localHost()
    host.activity = { ...host.activity!, dailyCoverage: 'omitted-range', daily: [] }
    await open(fixtureBridge(dashboard(host)))
    expect(screen.queryByRole('radiogroup', { name: 'Show on the chart' })).toBeNull()
    expect(screen.getByText('Choose a range of a year or less to see each day. The totals still cover the whole range.')).toBeVisible()
  })
})

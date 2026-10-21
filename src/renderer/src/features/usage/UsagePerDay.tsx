import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { UsageActivityAggregate, UsageDailyAggregate, UsageModelAggregate, UsageProviderId } from '../../../../shared/usageDashboard'
import { roomKeyTarget } from '../../components/AppShell'
import { DailyChart, SeriesValues, type DayValue } from './UsageCharts'
import {
  assignSlots, chooseSeries, seriesValues, splitPlan, totalPlan,
  type ChartKind, type ChartMetric, type ChartShow, type SeriesCandidate,
} from './usageChartSeries'
import type { UsagePage } from './usagePage'
import { NO_TOKENS, PROVIDER_NAMES, fieldTokens, fieldValue, fmtInt, fmtTok, joinNames, joinedDays, longDay, modelSpellings } from './usagePresentation'

export interface ChartChoice { readonly show: ChartShow; readonly kind: ChartKind }
const FIRST_CHOICE: ChartChoice = { show: 'total', kind: 'bars' }

/*
 * Show and Bars | Lines are remembered while Sotto runs, across Prompts and Tokens, the Usage tabs and other pages,
 * and never saved. So is each drawn model's colour, so a model keeps it while it stays drawn.
 */
let remembered: ChartChoice = FIRST_CHOICE
let modelSlots: ReadonlyMap<string, number> = new Map()

/** Forget the chart choice and the models' colours, as quitting Sotto does. For tests. */
export function forgetChartChoice(): void { remembered = FIRST_CHOICE; modelSlots = new Map() }

export function useChartChoice(): [ChartChoice, (patch: Partial<ChartChoice>) => void] {
  const [choice, setChoice] = useState(remembered)
  const change = useCallback((patch: Partial<ChartChoice>): void => { remembered = { ...remembered, ...patch }; setChoice(remembered) }, [])
  return [choice, change]
}

const SHOWS: ReadonlyArray<readonly [ChartShow, string]> = [['total', 'Total'], ['provider', 'By provider'], ['model', 'By model']]
const KINDS: ReadonlyArray<readonly [ChartKind, string]> = [['bars', 'Bars'], ['lines', 'Lines']]
const NOUN: Record<Exclude<ChartShow, 'total'>, string> = { provider: 'provider', model: 'model' }

/** A small radio group in the `usage-seg` style: one Tab stop, the arrows move and choose. */
function Choice<T extends string>({ label, options, value, onChoose }: {
  readonly label: string
  readonly options: ReadonlyArray<readonly [T, string]>
  readonly value: T
  readonly onChoose: (value: T) => void
}): ReactNode {
  const group = useRef<HTMLDivElement>(null)
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = roomKeyTarget(event.key, index, options.length)
    if (target === null) return
    event.preventDefault(); onChoose(options[target]![0])
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
  }
  return <div ref={group} className="usage-seg usage-seg--small" role="radiogroup" aria-label={label}>{options.map(([key, name], index) => <button key={key} type="button" role="radio"
    className="tt-focusable" aria-checked={value === key} tabIndex={value === key ? 0 : -1} onClick={() => onChoose(key)} onKeyDown={event => onKey(event, index)}>{name}</button>)}</div>
}

/** What one filtered read asks for: a provider, or one model by every spelling its computers stored. */
interface SeriesRequest { readonly key: string; readonly providerId: UsageProviderId; readonly modelIds?: readonly string[] }

/**
 * Each drawn series' days, one filtered read per series across the chosen computers, only while a split is shown.
 * A new question drops the old answer at once; newer figures for the same question replace it when they arrive.
 */
function useSeriesDays(page: UsagePage, requests: readonly SeriesRequest[]): { days: ReadonlyMap<string, UsageDailyAggregate[]> | undefined; failed: boolean; retry: () => void } {
  const { bridge, query, hostIds, summary } = page
  const [found, setFound] = useState<{ question: string; days: ReadonlyMap<string, UsageDailyAggregate[]> } | undefined>(undefined)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const question = requests.length === 0 ? null : JSON.stringify([requests, query, hostIds])
  // The page reads its figures again every half minute; the split follows when they moved.
  const version = `${summary.totals.prompts.total}:${fieldValue(summary.totals.tokens.total)}:${summary.totals.tokenRecords}`
  const asked = useRef(requests)
  asked.current = requests
  useEffect(() => {
    if (bridge === undefined || question === null) return
    let current = true
    const list = asked.current
    Promise.all(list.map(request => bridge.read({ ...query, includeDaily: true, providerIds: [request.providerId],
      ...(request.modelIds === undefined ? {} : { modelIds: [...request.modelIds] }), ...(hostIds.length > 0 ? { hostIds: [...hostIds] } : {}) }))).then(results => {
      if (!current) return
      setFound({ question, days: new Map(results.map((result, index) => [list[index]!.key, joinedDays(result, query.sources)])) })
      setFailure(null)
    }, () => { if (current) setFailure(question) })
    return () => { current = false }
    // The question names every input; the arrays it is built from are new on each render.
  }, [bridge, question, version, attempt])
  const days = found !== undefined && found.question === question ? found.days : undefined
  return { days, failed: days === undefined && failure !== null && failure === question, retry: () => { setFailure(null); setAttempt(value => value + 1) } }
}

/** A day's tokens in words, keeping what was not reported. */
const dayTokens = (row: DayValue): string => !row.tokensKnown ? 'not reported,' : `${row.tokensPartial ? 'at least ' : ''}${fmtTok(row.input + row.output)}`

/**
 * The Per day block of the Prompts and Tokens stages: Show and Bars | Lines, the value list when the chart is split,
 * the chart and its legend. `children` sits under the heading, before the values.
 */
export function PerDay({ page, metric, rows, choice, onChoose, selected, hover, pin, setHover, setPin, children }: {
  readonly page: UsagePage
  readonly metric: ChartMetric
  readonly rows: readonly DayValue[]
  readonly choice: ChartChoice
  readonly onChoose: (patch: Partial<ChartChoice>) => void
  readonly selected: string | null
  readonly hover: string | null
  readonly pin: string | null
  readonly setHover: (day: string | null) => void
  readonly setPin: (day: string | null) => void
  readonly children?: ReactNode
}): ReactNode {
  const { summary } = page
  const { show, kind } = choice
  const tokens = metric === 'tokens'
  const measure = (row: UsageActivityAggregate, providerId: UsageProviderId): number => !tokens ? row.prompts.total
    : NO_TOKENS.has(providerId) ? 0 : fieldValue(row.tokens.input) + fieldValue(row.tokens.output)
  const models = new Map<string, UsageModelAggregate>(summary.models.map(row => [`${row.providerId}:${row.modelId}`, row]))
  const candidates: SeriesCandidate[] = show === 'provider'
    ? summary.providers.map(row => ({ key: row.providerId, name: PROVIDER_NAMES[row.providerId], providerId: row.providerId, total: measure(row, row.providerId) }))
    : show === 'model' ? summary.models.map(row => ({ key: `${row.providerId}:${row.modelId}`, name: page.modelName(row), providerId: row.providerId, total: measure(row, row.providerId) })) : []
  const series = chooseSeries(show, candidates)
  const requests: SeriesRequest[] = series.drawn.map(item => {
    const row = show === 'model' ? models.get(item.key) : undefined
    return row === undefined ? { key: item.key, providerId: item.providerId } : { key: item.key, providerId: item.providerId, modelIds: modelSpellings(summary, row) }
  })
  const { days: found, failed, retry } = useSeriesDays(page, requests)

  const drawnKeys = show === 'model' ? series.drawn.map(item => item.key).join('\n') : ''
  const slots = useMemo(() => assignSlots(drawnKeys === '' ? [] : drawnKeys.split('\n'), modelSlots), [drawnKeys])
  useEffect(() => { if (show === 'model') modelSlots = slots }, [show, slots])

  const dayList = rows.map(row => row.day)
  const totals = rows.map(row => tokens ? row.input + row.output : row.prompts)
  const values = found === undefined ? undefined : new Map(series.drawn.map(item => {
    const byDay = new Map((found.get(item.key) ?? []).map(row => [row.day, row]))
    return [item.key, dayList.map(day => { const row = byDay.get(day); return row === undefined ? 0 : measure(row, item.providerId) })] as const
  }))
  const split = show !== 'total'
  const plan = split
    ? splitPlan({ kind, choice: series, totals, values, slots, incomplete: show === 'model' && summary.modelsTruncated,
      titleOf: item => show === 'model' ? `${item.name} · ${PROVIDER_NAMES[item.providerId]}` : undefined })
    : { ...totalPlan(metric, kind, rows), ready: true }
  const noun = split ? NOUN[show] : ''
  // The note above says what failed; the plot stays empty rather than say it twice.
  const waiting = !plan.ready ? (failed ? '' : `Reading each ${noun}'s days…`) : undefined
  const dayIndex = selected === null ? null : dayList.indexOf(selected)
  const amount = (value: number): string => tokens ? fmtTok(value) : fmtInt(value)
  const unit = tokens ? 'tokens' : 'prompts'
  const names = joinNames(plan.series.map(item => item.name))
  const what = split && plan.series.length > 0 ? ` ${kind === 'bars' ? 'Stacked' : 'One line'} by ${noun}: ${names}.` : ''

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = rows.length - 1
    const index = (value: string | null): number => value === null ? -1 : dayList.indexOf(value)
    let current = pin ?? hover
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') current = current === null ? dayList[last]! : dayList[Math.max(0, Math.min(last, index(current) + (event.key === 'ArrowRight' ? 1 : -1)))]!
    else if (event.key === 'Home') current = dayList[0]!
    else if (event.key === 'End') current = dayList[last]!
    else if (event.key === 'Escape' && pin !== null) current = null
    else return
    event.preventDefault(); event.stopPropagation(); setHover(null); setPin(current)
    const at = current === null ? null : index(current)
    const row = at === null ? undefined : rows[at]
    const whole = row === undefined ? (tokens ? fieldTokens(summary.totals.tokens.total) : fmtInt(summary.totals.prompts.total)) : tokens ? dayTokens(row) : fmtInt(row.prompts)
    const parts = split && plan.ready && plan.series.length > 0 ? `. ${seriesValues(plan, at).map(item => `${item.name} ${amount(item.value)}`).join(', ')}` : ''
    page.announce(`${current === null ? 'Whole range' : longDay(current, page.today)}: ${whole} ${unit}${parts}`)
  }

  return <div className={`usage-per${tokens ? ' usage-stage__sub' : ''}`}>
    <div className="usage-chart-head">
      <h3>Per day</h3>
      <div className="usage-chart-tools">
        <span className="usage-chart-tools__label" aria-hidden="true">Show</span>
        <Choice label="Show on the chart" options={SHOWS} value={show} onChoose={value => onChoose({ show: value })} />
        <Choice label="Draw the days as" options={KINDS} value={kind} onChoose={value => onChoose({ kind: value })} />
      </div>
    </div>
    {children}
    {failed ? <p className="usage-note">Each {noun}'s days couldn't be read. Nothing was lost, and the totals above still count them. <button type="button" className="usage-link tt-focusable" onClick={retry}>Try again</button></p> : null}
    {split && plan.series.length > 0 ? <SeriesValues plan={plan} dayIndex={dayIndex} metric={metric} kind={kind} ready={plan.ready}
      label={`Each ${noun}, ${dayIndex === null ? page.rangeLabel : longDay(selected!, page.today)}`} /> : null}
    <DailyChart days={dayList} plan={plan} kind={kind} metric={metric} today={page.today} selected={selected} waiting={waiting}
      label={`${tokens ? 'Tokens' : 'Prompts'} per day, ${page.rangeLabel}.${what}`}
      onHover={setHover} onPin={() => { setPin(hover === null || pin === hover ? null : hover); setHover(null) }} onKey={onKey} />
    {!split && tokens ? <p className="usage-legend usage-legend--below">{kind === 'bars'
      ? <><span><i className="usage-kind--input" />Input</span><span><i className="usage-kind--out" />Output</span></>
      : <span><i className="usage-kind--both" />Input and output</span>}</p> : null}
  </div>
}

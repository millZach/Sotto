import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { i18n as interfaceI18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { UsageActivityAggregate, UsageDailyAggregate, UsageDashboardRead, UsageFieldTotal, UsageModelAggregate, UsageProviderId } from '../../../../shared/usageDashboard'
import { roomKeyTarget } from '../../components/AppShell'
import { DailyChart, SeriesValues, dismissDisclosure, type DayValue } from './UsageCharts'
import {
  assignSlots, chooseSeries, measureFigure, seriesValues, splitPlan, totalPlan,
  type ChartFigure, type ChartKind, type ChartMetric, type ChartShow, type SeriesCandidate,
} from './usageChartSeries'
import type { UsagePage } from './usagePage'
import { PROVIDER_NAMES, fieldValue, fmtInt, fmtTok, joinNames, joinedDays, longDay, modelSpellings } from './usagePresentation'

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

const SHOWS: ReadonlyArray<readonly [ChartShow, MessageDescriptor]> = [['total', msg`Total`], ['provider', msg`By provider`], ['model', msg`By model`]]
const KINDS: ReadonlyArray<readonly [ChartKind, MessageDescriptor]> = [['bars', msg`Bars`], ['lines', msg`Lines`]]

/** A small radio group in the `usage-seg` style: one Tab stop, the arrows move and choose. */
function Choice<T extends string>({ label, options, value, onChoose }: {
  readonly label: string
  readonly options: ReadonlyArray<readonly [T, MessageDescriptor]>
  readonly value: T
  readonly onChoose: (value: T) => void
}): ReactNode {
  const { i18n } = useLingui()
  const group = useRef<HTMLDivElement>(null)
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = roomKeyTarget(event.key, index, options.length)
    if (target === null) return
    event.preventDefault(); onChoose(options[target]![0])
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
  }
  return <div ref={group} className="usage-seg usage-seg--small" role="radiogroup" aria-label={label}>{options.map(([key, name], index) => <button key={key} type="button" role="radio"
    className="tt-focusable" aria-checked={value === key} tabIndex={value === key ? 0 : -1} onClick={() => onChoose(key)} onKeyDown={event => onKey(event, index)}>{i18n._(name)}</button>)}</div>
}

/** What one filtered read asks for: a provider, or one model by every spelling its computers stored. */
interface SeriesRequest { readonly key: string; readonly providerId: UsageProviderId; readonly modelIds?: readonly string[] }

/** The computers whose figures the page drew: every one that answered with its activity. */
const readyHosts = (read: UsageDashboardRead): string[] => read.hosts.filter(host => host.status === 'ready' && host.activity !== undefined).map(host => host.hostId)

/**
 * A filtered read answers for every computer the page's own figures came from, each with all its days. One that left a
 * computer out, or had it offline, failed or without days, would draw that computer's work as zero and hand it to Other.
 */
const covers = (read: UsageDashboardRead, hostIds: readonly string[]): boolean => hostIds.every(hostId => read.hosts.some(host =>
  host.hostId === hostId && host.status === 'ready' && host.activity?.dailyCoverage === 'complete'))

const NOTHING_TO_READ: ReadonlyMap<string, UsageDailyAggregate[]> = new Map()

/**
 * Each drawn series' days, one filtered read per series across the chosen computers, only while a split is shown.
 * A new question drops the old answer at once; newer figures for the same question replace it when they arrive. A read
 * that fails, or does not cover every computer the page drew, is a failure and nothing of it is drawn. With no series
 * to draw there is nothing to read, so the answer is ready at once.
 */
function useSeriesDays(page: UsagePage, requests: readonly SeriesRequest[]): { days: ReadonlyMap<string, UsageDailyAggregate[]> | undefined; failed: boolean; retry: () => void } {
  const { bridge, query, hostIds, summary, read } = page
  const [found, setFound] = useState<{ question: string; days: ReadonlyMap<string, UsageDailyAggregate[]> } | undefined>(undefined)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const expected = readyHosts(read)
  const question = requests.length === 0 ? null : JSON.stringify([requests, query, hostIds, expected])
  // The page reads its figures again every half minute; the split follows when they moved.
  const version = `${summary.totals.prompts.total}:${fieldValue(summary.totals.tokens.total)}:${summary.totals.tokenRecords}`
  const asked = useRef({ requests, expected })
  asked.current = { requests, expected }
  useEffect(() => {
    if (bridge === undefined || question === null) return
    let current = true
    const { requests: list, expected: hosts } = asked.current
    Promise.all(list.map(request => bridge.read({ ...query, includeDaily: true, providerIds: [request.providerId],
      ...(request.modelIds === undefined ? {} : { modelIds: [...request.modelIds] }), ...(hostIds.length > 0 ? { hostIds: [...hostIds] } : {}) }))).then(results => {
      if (!current) return
      if (!results.every(result => covers(result, hosts))) { setFailure(question); return }
      setFound({ question, days: new Map(results.map((result, index) => [list[index]!.key, joinedDays(result, query.sources)])) })
      setFailure(null)
    }, () => { if (current) setFailure(question) })
    return () => { current = false }
    // The question names every input; the arrays it is built from are new on each render.
  }, [bridge, question, version, attempt])
  if (question === null) return { days: NOTHING_TO_READ, failed: false, retry: () => undefined }
  const failed = failure === question
  const days = !failed && found !== undefined && found.question === question ? found.days : undefined
  return { days, failed, retry: () => { setFailure(null); setAttempt(value => value + 1) } }
}

/** A figure in words for the keyboard announcement, as the value list shows it. */
function figureWords(figure: ChartFigure, format: (value: number) => string): string {
  if (!figure.known) return interfaceI18n._(msg`not reported`)
  const shown = format(figure.value)
  return figure.partial ? interfaceI18n._(msg`at least ${shown}`) : shown
}
/** A token field as a figure, for the whole range's announcement. */
const fieldFigure = (field: UsageFieldTotal): ChartFigure => ({ value: field.value ?? 0, known: field.value !== undefined, partial: field.partial })

/** What Other holds, in a sentence: each model and its provider, and any models the ranking left out. */
function otherHolds(rest: readonly SeriesCandidate[], truncated: boolean): string {
  const named = rest.map(item => {
    const model = item.name, provider = PROVIDER_NAMES[item.providerId]
    return interfaceI18n._(msg`${model} from ${provider}`)
  })
  if (truncated) named.push(interfaceI18n._(msg`models Usage doesn't list`))
  const list = joinNames(named)
  return interfaceI18n._(msg`Other holds ${list}.`)
}

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
  const { t } = useLingui()
  const { summary } = page
  const { show, kind } = choice
  const tokens = metric === 'tokens'
  const measure = (row: UsageActivityAggregate, providerId: UsageProviderId): number => measureFigure(metric, row, providerId).value
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
  const split = show !== 'total'
  const pageDays = new Map(summary.daily.map(row => [row.day, row]))
  const totals = split ? dayList.map(day => measureFigure(metric, pageDays.get(day))) : []
  const values = found === undefined ? undefined : new Map(series.drawn.map(item => {
    const byDay = new Map((found.get(item.key) ?? []).map(row => [row.day, row]))
    return [item.key, dayList.map(day => measureFigure(metric, byDay.get(day), item.providerId))] as const
  }))
  const plan = split
    ? splitPlan({ kind, choice: series, totals, values, slots, incomplete: show === 'model' && summary.modelsTruncated,
      titleOf: item => show === 'model' ? `${item.name} · ${PROVIDER_NAMES[item.providerId]}` : undefined })
    : { ...totalPlan(metric, kind, rows), ready: true }
  // Each computer lists its models by tokens, a few hundred at most. The top five by tokens on one computer are still its
  // top five; by prompts, or joined across computers, a model left off a list may belong among them.
  const rankingIncomplete = show === 'model' && summary.modelsTruncated && (!tokens || readyHosts(page.read).length > 1)
  const other = plan.series.find(item => item.key === 'other')
  // The note above says what failed; the plot stays empty rather than say it twice.
  const byProvider = show === 'provider'
  const waiting = !plan.ready ? (failed ? '' : byProvider ? t`Reading each provider's days…` : t`Reading each model's days…`) : undefined
  const dayIndex = selected === null ? null : dayList.indexOf(selected)
  const amount = tokens ? fmtTok : fmtInt
  const names = joinNames(plan.series.map(item => item.name))
  const range = page.rangeLabel
  const perDayWords = tokens ? t`Tokens per day, ${range}.` : t`Prompts per day, ${range}.`
  const what = !(split && plan.series.length > 0) ? ''
    : kind === 'bars'
      ? byProvider ? t`Stacked by provider: ${names}.` : t`Stacked by model: ${names}.`
      : byProvider ? t`One line by provider: ${names}.` : t`One line by model: ${names}.`
  const valuesWhen = dayIndex === null ? page.rangeLabel : longDay(selected!, page.today)

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
    const whole: ChartFigure = row === undefined ? (tokens ? fieldFigure(summary.totals.tokens.total) : { value: summary.totals.prompts.total, known: true, partial: false })
      : tokens ? { value: row.input + row.output, known: row.tokensKnown, partial: row.tokensPartial } : { value: row.prompts, known: true, partial: false }
    const parts = split && plan.ready && plan.series.length > 0 ? `. ${seriesValues(plan, at).map(item => `${item.name} ${figureWords(item.figure, amount)}`).join(', ')}` : ''
    const figure = figureWords(whole, amount)
    const counted = whole.known ? tokens ? t`${figure} tokens` : t`${figure} prompts` : tokens ? t`tokens not reported` : t`prompts not reported`
    page.announce(`${current === null ? t`Whole range` : longDay(current, page.today)}: ${counted}${parts}`)
  }

  return <div className={`usage-per${tokens ? ' usage-stage__sub' : ''}`}>
    <div className="usage-chart-head">
      <h3><Trans>Per day</Trans></h3>
      <div className="usage-chart-tools">
        <span className="usage-chart-tools__label" aria-hidden="true"><Trans context="Usage chart">Show</Trans></span>
        <Choice label={t`Show on the chart`} options={SHOWS} value={show} onChoose={value => onChoose({ show: value })} />
        <Choice label={t`Draw the days as`} options={KINDS} value={kind} onChoose={value => onChoose({ kind: value })} />
      </div>
    </div>
    {children}
    {rankingIncomplete ? <p className="usage-note tt-paragraph">{tokens
      ? t`Ranking is incomplete. There are more models than Usage lists, so the models drawn may not be those with the most tokens. Other counts the rest.`
      : t`Ranking is incomplete. There are more models than Usage lists, so the models drawn may not be those with the most prompts. Other counts the rest.`}</p> : null}
    {failed ? <p className="usage-note tt-paragraph">{byProvider
      ? t`Each provider's days couldn't be read. Nothing was lost, and the totals above still count them.`
      : t`Each model's days couldn't be read. Nothing was lost, and the totals above still count them.`} <button type="button" className="usage-link tt-focusable" onClick={retry}><Trans>Try again</Trans></button></p> : null}
    {split && plan.series.length > 0 ? <SeriesValues plan={plan} dayIndex={dayIndex} metric={metric} kind={kind} ready={plan.ready}
      label={byProvider ? t`Each provider, ${valuesWhen}` : t`Each model, ${valuesWhen}`} /> : null}
    <DailyChart days={dayList} plan={plan} kind={kind} metric={metric} today={page.today} selected={selected} waiting={waiting}
      label={what === '' ? perDayWords : `${perDayWords} ${what}`}
      onHover={setHover} onPin={() => { setPin(hover === null || pin === hover ? null : hover); setHover(null) }} onKey={onKey} />
    {show === 'model' && plan.series.length > 0 ? <details className="usage-about usage-values-more" onKeyDown={dismissDisclosure}>
      <summary className="tt-focusable"><ChevronRight size={14} aria-hidden="true" />{other === undefined ? t`Each model's provider` : t`Each model's provider, and what Other holds`}</summary>
      <ul>
        {series.drawn.map(item => {
          const model = item.name, provider = PROVIDER_NAMES[item.providerId]
          return <li key={item.key}><Trans>{model}, from {provider}</Trans></li>
        })}
        {other === undefined ? null : <li>{otherHolds(series.rest, summary.modelsTruncated)}</li>}
      </ul>
    </details> : null}
    {!split && tokens ? <p className="usage-legend usage-legend--below">{kind === 'bars'
      ? <><span><i className="usage-kind--input" /><Trans>Input</Trans></span><span><i className="usage-kind--out" /><Trans>Output</Trans></span></>
      : <span><i className="usage-kind--both" /><Trans>Input and output</Trans></span>}</p> : null}
  </div>
}

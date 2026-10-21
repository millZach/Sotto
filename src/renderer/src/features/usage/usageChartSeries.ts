import type { UsageActivityAggregate, UsageProviderId } from '../../../../shared/usageDashboard'
import { NO_TOKENS, type TokenFigure } from './usagePresentation'

/**
 * What the Per day chart on Prompts and Tokens draws: the total, or the total split by provider or by model
 * (Zach's pick on October 21, 2026, ADR-0083). Bars stack, so a day stays as tall as its total; lines never stack,
 * so each one can be followed on its own. Everything here is pure: the page reads the days, this shapes them.
 */

export type ChartShow = 'total' | 'provider' | 'model'
export type ChartKind = 'bars' | 'lines'
export type ChartMetric = 'prompts' | 'tokens'
/** How a series is painted: the total's own tones, a numbered `--tt-chart-*` slot, or the Other grey. */
export type SeriesTone = 'strong' | 'input' | 'output' | 'other' | `${number}`

/** How many models By model draws before the rest go into Other. */
export const MODELS_DRAWN = 5
/** The series colours a theme provides, `--tt-chart-1` to `--tt-chart-6`. */
export const SERIES_SLOTS = 6
/** A provider keeps one colour wherever it is drawn, near its own: Codex blue, Claude orange, Devin cyan, Muse magenta, Grok violet, OpenCode amber. */
export const PROVIDER_SLOT: Readonly<Record<UsageProviderId, number>> = { codex: 1, claude: 2, devin: 3, muse: 4, grok: 5, opencode: 6 }

/** One provider or model that could be drawn, with its range total by the stage's measure. */
export interface SeriesCandidate {
  readonly key: string
  readonly name: string
  readonly providerId: UsageProviderId
  readonly total: number
}
export interface SeriesChoice {
  readonly show: ChartShow
  /** Drawn in this order: the largest first, at the foot of a stack and first in the value list. */
  readonly drawn: readonly SeriesCandidate[]
  /** What Other holds. Empty for By provider, which draws every provider with activity. */
  readonly rest: readonly SeriesCandidate[]
}

/** What Show draws: every provider with activity, or the top models and the rest. Nothing without activity is offered. */
export function chooseSeries(show: ChartShow, candidates: readonly SeriesCandidate[]): SeriesChoice {
  if (show === 'total') return { show, drawn: [], rest: [] }
  const active = candidates.filter(item => item.total > 0).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
  return show === 'provider' ? { show, drawn: active, rest: [] } : { show, drawn: active.slice(0, MODELS_DRAWN), rest: active.slice(MODELS_DRAWN) }
}

/**
 * Colour slots for the drawn models. A model drawn before keeps its slot; a new one takes the lowest free slot.
 * So a range or filter that changes which models are drawn never repaints the ones that stay.
 */
export function assignSlots(keys: readonly string[], previous: ReadonlyMap<string, number>): Map<string, number> {
  const slots = new Map<string, number>()
  for (const key of keys) {
    const slot = previous.get(key)
    if (slot !== undefined && slot >= 1 && slot <= SERIES_SLOTS) slots.set(key, slot)
  }
  const used = new Set(slots.values())
  for (const key of keys) {
    if (slots.has(key)) continue
    let slot = 1
    while (used.has(slot) && slot < SERIES_SLOTS) slot++
    used.add(slot); slots.set(key, slot)
  }
  return slots
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/**
 * One figure on the chart, as reported: unknown when no record reports it, partial when some records leave it out, so
 * the value is a lower bound. Token figures carry their record counts, so Other, the total less the drawn series, can
 * tell whether its own records were whole. Prompts are always whole and carry none.
 */
export interface ChartFigure extends TokenFigure {
  readonly records?: { readonly all: number; readonly known: number; readonly partial: number }
}
type FigureRecords = NonNullable<ChartFigure['records']>
export const wholeFigure = (value: number): ChartFigure => ({ value, known: true, partial: false })

/** A day's or a range's figure by the stage's measure. Devin reports no tokens, so its token figure is a plain zero. */
export function measureFigure(metric: ChartMetric, row: UsageActivityAggregate | undefined, providerId?: UsageProviderId): ChartFigure {
  if (metric === 'prompts') return wholeFigure(row?.prompts.total ?? 0)
  // A day without work holds no records: a reported zero that adds to other days' records as nothing.
  if (row === undefined || (providerId !== undefined && NO_TOKENS.has(providerId))) return { ...wholeFigure(0), records: { all: 0, known: 0, partial: 0 } }
  const { input, output, total } = row.tokens
  return { value: (input.value ?? 0) + (output.value ?? 0), known: row.tokenRecords === 0 || total.value !== undefined, partial: total.partial,
    records: { all: total.rows, known: total.knownRows, partial: row.partialTokenRecords } }
}

const fromRecords = (value: number, records: FigureRecords): ChartFigure =>
  ({ value, known: records.all === 0 || records.known > 0, partial: records.known < records.all || records.partial > 0, records })
const addRecords = (figures: readonly ChartFigure[]): FigureRecords => ({
  all: sum(figures.map(item => item.records!.all)), known: sum(figures.map(item => item.records!.known)), partial: sum(figures.map(item => item.records!.partial)),
})

/** Several days' figures as one: unknown only when nothing in them was reported, partial when anything was left out. */
export function sumFigures(figures: readonly ChartFigure[]): ChartFigure {
  const value = sum(figures.map(item => item.value))
  if (figures.length > 0 && figures.every(item => item.records !== undefined)) return fromRecords(value, addRecords(figures))
  const known = figures.length === 0 || figures.some(item => item.known)
  return { value, known, partial: known && figures.some(item => item.partial || !item.known) }
}

/**
 * What is left of a total once the drawn series are taken out: Other. The drawn series' records are part of the total's,
 * so the counts subtract; when they do not add up, Other is only as sure as the total and the series together.
 */
export function remainder(total: ChartFigure, parts: readonly ChartFigure[]): ChartFigure {
  const value = Math.max(0, total.value - sum(parts.map(item => item.value)))
  if (total.records !== undefined && parts.every(item => item.records !== undefined)) {
    const taken = addRecords(parts)
    const records = { all: total.records.all - taken.all, known: total.records.known - taken.known, partial: total.records.partial - taken.partial }
    if (records.all >= 0 && records.known >= 0 && records.partial >= 0 && records.known <= records.all) return fromRecords(value, records)
  }
  return { value, known: total.known, partial: total.known && (total.partial || parts.some(item => item.partial || !item.known)) }
}

export interface ChartSeries {
  readonly key: string
  readonly name: string
  /** What a pointer's tooltip says: the models in Other, or a model's provider. The page also says them in words. */
  readonly title?: string
  readonly tone: SeriesTone
  /** One value per day of the range, by the stage's measure: what is drawn, the reported part of each figure. */
  readonly values: readonly number[]
  readonly total: number
  /** Each day's figure as reported, and the range's. */
  readonly figures: readonly ChartFigure[]
  readonly figure: ChartFigure
}
export interface ChartPlan {
  readonly series: readonly ChartSeries[]
  /** Bars of more than one series stack; lines never do. */
  readonly stacked: boolean
  /** The tallest thing the plot holds: a day's whole stack for bars, the highest point for lines. */
  readonly peak: number
}

function plan(series: ChartSeries[], kind: ChartKind): ChartPlan {
  const stacked = kind === 'bars'
  const days = series[0]?.values.length ?? 0
  const peak = stacked
    ? Math.max(0, ...Array.from({ length: days }, (_, index) => sum(series.map(item => item.values[index] ?? 0))))
    : Math.max(0, ...series.flatMap(item => item.values))
  return { series, stacked, peak }
}

function makeSeries(key: string, name: string, tone: SeriesTone, figures: readonly ChartFigure[], title?: string): ChartSeries {
  const values = figures.map(item => Math.max(0, item.value))
  return { key, name, tone, values, total: sum(values), figures, figure: sumFigures(figures), ...(title === undefined ? {} : { title }) }
}

/** One day's figures for the Total view. */
export interface TotalDay { readonly prompts: number; readonly input: number; readonly output: number }

/** The Total view as it was before the split: prompts in the accent; tokens as input under output, or one line of both. */
export function totalPlan(metric: ChartMetric, kind: ChartKind, days: readonly TotalDay[]): ChartPlan {
  const make = (key: string, name: string, tone: SeriesTone, values: number[]): ChartSeries => makeSeries(key, name, tone, values.map(wholeFigure))
  if (metric === 'prompts') return plan([make('prompts', 'Prompts', 'strong', days.map(day => day.prompts))], kind)
  if (kind === 'lines') return plan([make('tokens', 'Input and output', 'strong', days.map(day => day.input + day.output))], kind)
  return plan([make('input', 'Input', 'input', days.map(day => day.input)), make('output', 'Output', 'output', days.map(day => day.output))], kind)
}

export interface SplitInput {
  readonly kind: ChartKind
  readonly choice: SeriesChoice
  /** The stage's figure for every day, all series together. */
  readonly totals: readonly ChartFigure[]
  /** Each drawn series' figure by day index, or undefined while its days are still being read. */
  readonly values: ReadonlyMap<string, readonly ChartFigure[]> | undefined
  readonly slots: ReadonlyMap<string, number>
  /** The ranking left some models out, so the total may hold more than the rest named. */
  readonly incomplete?: boolean
  readonly titleOf?: (item: SeriesCandidate) => string | undefined
}

/**
 * The split view. Other is each day's total less the drawn series, never below zero, and appears only when there is
 * a rest. Until the days arrive every value is zero and `ready` is false, so the page can name the series without
 * drawing anything that is not so.
 */
export function splitPlan({ kind, choice, totals, values, slots, incomplete = false, titleOf }: SplitInput): ChartPlan & { readonly ready: boolean } {
  const length = totals.length
  const zeros = (): ChartFigure[] => Array.from({ length }, () => wholeFigure(0))
  const drawn: ChartSeries[] = choice.drawn.map(item => {
    const figures = values === undefined ? zeros() : Array.from({ length }, (_, index) => values.get(item.key)?.[index] ?? wholeFigure(0))
    const tone: SeriesTone = `${choice.show === 'provider' ? PROVIDER_SLOT[item.providerId] : slots.get(item.key) ?? 1}`
    return makeSeries(item.key, item.name, tone, figures, titleOf?.(item))
  })
  const series = [...drawn]
  if (choice.show === 'model' && (choice.rest.length > 0 || incomplete)) {
    const other = values === undefined ? zeros() : totals.map((total, index) => remainder(total, drawn.map(item => item.figures[index]!)))
    const named = choice.rest.map(item => item.name)
    if (choice.rest.length > 0 || sum(other.map(item => item.value)) > 0) {
      series.push(makeSeries('other', choice.rest.length > 0 && !incomplete ? `Other (${choice.rest.length})` : 'Other', 'other', other,
        named.length > 0 ? named.join(', ') : undefined))
    }
  }
  return { ...plan(series, kind), ready: values !== undefined }
}

/** What the value list names: every series with its range figure, or with one day's when a day is read. */
export function seriesValues(chart: ChartPlan, dayIndex: number | null): Array<{ key: string; name: string; title?: string; tone: SeriesTone; figure: ChartFigure }> {
  return chart.series.map(item => ({ key: item.key, name: item.name, tone: item.tone, figure: dayIndex === null ? item.figure : item.figures[dayIndex] ?? wholeFigure(0),
    ...(item.title === undefined ? {} : { title: item.title }) }))
}

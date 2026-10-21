import React, { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { UsageTokenTotals } from '../../../../shared/usageDashboard'
import { seriesValues, type ChartKind, type ChartMetric, type ChartPlan } from './usageChartSeries'
import { fmtInt, fmtTok, hourLabel, shortDay, tokenParts, WEEKDAYS_SHORT, weekdayOf, LOW_LEFT, type TokenFigure } from './usagePresentation'

type Style = CSSProperties & Record<`--${string}`, string | number>

/** A dash that a screen reader reads as what it means. */
export function Dash(): ReactNode {
  return <span className="usage-dash"><span aria-hidden="true">—</span><span className="tt-visually-hidden">Not reported</span></span>
}

export function dismissDisclosure(event: KeyboardEvent<HTMLDetailsElement>): void {
  if (event.key !== 'Escape' || !event.currentTarget.open) return
  event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false
  event.currentTarget.querySelector<HTMLElement>('summary')?.focus()
}

export interface RingPart {
  /** Percentage left; undefined draws the dotted unknown ring. */
  readonly left: number | undefined
  readonly width: number
  readonly inset: number
  readonly inner?: boolean
}
/** Room-left rings: the longest window outside, the shortest inside, amber at 20% or less. */
export function Ring({ size, parts, stale = false, lowAware = true }: { readonly size: number; readonly parts: readonly RingPart[]; readonly stale?: boolean; readonly lowAware?: boolean }): ReactNode {
  const centre = size / 2
  return <svg className="usage-ring" data-stale={stale || undefined} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
    {parts.map((part, index) => {
      const radius = centre - part.inset - part.width / 2
      const circumference = 2 * Math.PI * radius
      if (part.left === undefined) return <circle key={index} className="usage-ring__unknown" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={part.width} strokeDasharray={`1.5 ${Math.max(3, part.width + 1.5)}`} strokeLinecap="round" />
      const low = lowAware && part.left <= LOW_LEFT
      return <React.Fragment key={index}>
        <circle className="usage-ring__track" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={part.width} />
        <circle className={`usage-ring__arc${part.inner ? ' usage-ring__arc--inner' : ''}`} data-low={low || undefined} cx={centre} cy={centre} r={radius} fill="none" strokeWidth={part.width} strokeLinecap="round"
          strokeDasharray={circumference.toFixed(2)} strokeDashoffset={(circumference * (1 - Math.max(0, Math.min(100, part.left)) / 100)).toFixed(2)}
          style={{ '--usage-circumference': circumference.toFixed(2) } as Style} transform={`rotate(-90 ${centre} ${centre})`} />
      </React.Fragment>
    })}
  </svg>
}

export function Spark({ values, width = 72, height = 24 }: { readonly values: readonly number[]; readonly width?: number; readonly height?: number }): ReactNode {
  if (values.length === 0) return null
  const maximum = Math.max(1, ...values)
  const step = width / Math.max(1, values.length - 1)
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - value / maximum * (height - 4)).toFixed(1)}`).join(' ')
  return <svg className="usage-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
}

/** A round top for the axis: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 of a power of ten. */
function niceMax(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * power >= value) return step * power
  return 10 * power
}

export interface DayValue { readonly day: string; readonly prompts: number; readonly input: number; readonly output: number; readonly tokensKnown: boolean; readonly tokensPartial: boolean }

/** A day's position across the plot, as a percentage of its width. */
const across = (index: number, count: number): string => `${((index + 0.5) / count * 100).toFixed(3)}%`

/**
 * The days of a range as bars or lines, with two gridlines. Bars of several series stack, the largest at the foot;
 * lines are drawn one per series, unstacked. The plot is one keyboard stop: Left and Right read a day, Home and End
 * the ends, Escape goes back to the whole range. While `waiting` says why, the frame stays and nothing is drawn.
 */
export function DailyChart({ days, plan, kind, metric, label, today, selected, waiting, onHover, onPin, onKey }: {
  readonly days: readonly string[]
  readonly plan: ChartPlan
  readonly kind: ChartKind
  readonly metric: ChartMetric
  readonly label: string
  readonly today: string
  readonly selected: string | null
  readonly waiting?: string | undefined
  readonly onHover: (day: string | null) => void
  readonly onPin: () => void
  readonly onKey: (event: KeyboardEvent<HTMLDivElement>) => void
}): ReactNode {
  const count = days.length
  const top = niceMax(Math.max(metric === 'prompts' ? 10 : 1e5, plan.peak))
  const gap = count <= 7 ? 18 : count <= 45 ? 4 : count <= 100 ? 2 : 1
  const radius = count > 60 ? 1 : count > 20 ? 3 : 5
  // A token chart with nothing reported, or a split with no series to draw, says so rather than draw an empty frame.
  const none = waiting !== undefined ? undefined : metric === 'tokens' && plan.peak === 0 ? 'No token counts in this range'
    : plan.series.length === 0 ? 'No prompts in this range' : undefined
  const scale = (amount: number): string => metric === 'prompts' ? fmtInt(amount) : fmtTok(amount)
  const index = selected === null ? -1 : days.indexOf(selected)
  const point = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const at = Math.max(0, Math.min(count - 1, Math.floor((event.clientX - rect.left) / rect.width * count)))
    onHover(days[at] ?? null)
  }
  const height = (value: number): string => (Math.max(0, value) / top).toFixed(4)
  const marks = count <= 7 ? days.map((_, at) => at) : [0, Math.round((count - 1) / 2), count - 1]
  let drawing: ReactNode = null
  if (waiting === undefined && kind === 'bars') {
    drawing = <div className="usage-chart__columns" data-split={(plan.series.length > 1 && plan.stacked) || undefined}>
      {days.map((day, at) => {
        const parts = plan.series.filter(item => (item.values[at] ?? 0) > 0)
        // A day with nothing keeps a one-pixel mark on the baseline, as the chart always had.
        const shown = parts.length > 0 ? parts : plan.series.slice(0, 1)
        return <span key={day} className="usage-chart__column" data-on={day === selected || undefined} style={{ '--usage-i': at } as Style}>
          {shown.map((item, place) => <i key={item.key} className="usage-chart__bar" data-tone={item.tone} data-top={place === shown.length - 1 || undefined}
            style={{ '--usage-h': height(item.values[at] ?? 0) } as Style} />)}
        </span>
      })}
    </div>
  } else if (waiting === undefined) {
    const y = (value: number): string => (100 - Math.max(0, value) / top * 100).toFixed(3)
    const path = (values: readonly number[]): string => values.map((value, at) => `${at === 0 ? 'M' : 'L'}${(at + 0.5).toFixed(2)},${y(value)}`).join(' ')
    const first = plan.series.length === 1 ? plan.series[0] : undefined
    const dot = (item: ChartPlan['series'][number], at: number, on: boolean): ReactNode => <span key={`${item.key}:${at}`} className="usage-chart__dot" data-tone={item.tone} data-on={on || undefined}
      style={{ left: across(at, count), bottom: `${(Math.max(0, item.values[at] ?? 0) / top * 100).toFixed(3)}%` }} />
    drawing = <div className="usage-chart__fill">
      <svg className="usage-chart__lines" viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {first !== undefined ? <path className="usage-chart__area" data-tone={first.tone} d={`${path(first.values)} L${(count - 0.5).toFixed(2)},100 L0.50,100 Z`} /> : null}
        {plan.series.map(item => <path key={item.key} className="usage-chart__line" data-tone={item.tone} d={path(item.values)} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {index >= 0 ? <><span className="usage-chart__cross" style={{ left: across(index, count) }} />{plan.series.map(item => dot(item, index, true))}</>
        : count <= 7 ? plan.series.flatMap(item => days.map((_, at) => dot(item, at, false))) : null}
    </div>
  }
  return <div className="usage-chart" data-kind={kind} style={{ '--usage-gap': `${gap}px`, '--usage-radius': `${radius}px`, '--usage-count': count } as Style}>
    <div className="usage-chart__plot tt-focusable" tabIndex={0} role="group" aria-label={`${label} Use Left and Right to read one day; Escape goes back to the whole range.`}
      aria-busy={waiting !== undefined || undefined} data-active={selected !== null || undefined} onPointerMove={point} onPointerLeave={() => onHover(null)} onClick={onPin} onKeyDown={onKey}>
      {drawing}
      {waiting !== undefined ? <div className="usage-chart__none">{waiting}</div> : none !== undefined ? <div className="usage-chart__none">{none}</div> : <>
        <div className="usage-chart__grid" style={{ top: 0 }}><span>{scale(top)}</span></div>
        <div className="usage-chart__grid" style={{ top: '50%' }}><span>{scale(top / 2)}</span></div>
      </>}
    </div>
    <div className="usage-chart__axis" aria-hidden="true">{marks.map((at, place) => {
      const day = days[at]!
      const text = day === today ? 'Today' : count <= 7 ? `${WEEKDAYS_SHORT[weekdayOf(day)]} ${Number(day.slice(8, 10))}` : shortDay(day)
      const edge = count > 7 && (place === 0 || place === marks.length - 1)
      const left = edge ? (place === 0 ? 0 : 100) : (at + 0.5) / count * 100
      return <span key={day} className={count > 7 && place === 0 ? 'usage-chart__tick--start' : count > 7 && place === marks.length - 1 ? 'usage-chart__tick--end' : undefined} style={{ left: `${left.toFixed(2)}%` }}>{text}</span>
    })}</div>
  </div>
}

/**
 * The value list above a split chart: every series with its range figure, or its figure on the day being read. A
 * figure no record reports is a dash read as "Not reported"; one some records leave out says "at least".
 */
export function SeriesValues({ plan, dayIndex, metric, kind, ready, label }: {
  readonly plan: ChartPlan
  readonly dayIndex: number | null
  readonly metric: ChartMetric
  readonly kind: ChartKind
  readonly ready: boolean
  readonly label: string
}): ReactNode {
  return <ul className="usage-values" data-kind={kind} aria-label={label} aria-busy={!ready || undefined}>
    {seriesValues(plan, ready ? dayIndex : null).map(row => <li key={row.key} title={row.title}>
      <i data-tone={row.tone} aria-hidden="true" />
      <span>{row.name}</span>
      <b>{ready ? <Figure of={row.figure} format={metric === 'prompts' ? fmtInt : fmtTok} /> : null}</b>
    </li>)}
  </ul>
}

/** Seven rows of 24 hours, Monday first. One keyboard stop; the arrows move a cell and Escape lets go. */
export function HourGrid({ grid, cell, onCell, onKey, label }: {
  readonly grid: readonly (readonly number[])[]
  readonly cell: { readonly weekday: number; readonly hour: number } | null
  readonly onCell: (cell: { weekday: number; hour: number }) => void
  readonly onKey: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly label: string
}): ReactNode {
  const maximum = Math.max(1, ...grid.flat())
  return <div className="usage-hours tt-focusable" tabIndex={0} role="group" aria-label={label} onKeyDown={onKey}>
    {grid.map((row, weekday) => <React.Fragment key={weekday}>
      <span className="usage-hours__day" aria-hidden="true">{WEEKDAYS_SHORT[weekday]}</span>
      {row.map((count, hour) => <span key={hour} className="usage-hours__cell" data-on={cell?.weekday === weekday && cell.hour === hour || undefined}
        style={{ '--usage-a': count > 0 ? (0.12 + 0.88 * count / maximum).toFixed(3) : 0 } as Style} onPointerEnter={() => onCell({ weekday, hour })} />)}
    </React.Fragment>)}
    <div className="usage-hours__axis" aria-hidden="true">{[0, 6, 12, 18].map(hour => <span key={hour} style={{ left: `${(hour / 24 * 100).toFixed(2)}%` }}>{hourLabel(hour)}</span>)}</div>
  </div>
}

/** One figure as reported: a dash when no row reports it, "at least" when some rows leave it out. */
function Figure({ of, format = fmtTok }: { readonly of: TokenFigure; readonly format?: (value: number) => string }): ReactNode {
  return of.known ? <>{of.partial ? <small>at least </small> : null}{format(of.value)}</> : <Dash />
}
const figureWords = (of: TokenFigure): string => of.known ? `${of.partial ? 'at least ' : ''}${fmtTok(of.value)}` : 'an unreported number of'


/** The coloured pieces of input and output, each as wide as its amount. */
function kindSegments(parts: ReturnType<typeof tokenParts>, className = ''): Record<'read' | 'write' | 'new' | 'out', ReactNode> {
  const segment = (kind: string, amount: number): ReactNode => amount > 0 ? <i className={`${className}usage-kind--${kind}`} style={{ flexGrow: amount }} /> : null
  return { read: segment('read', parts.read.value), write: segment('write', parts.write.value), new: segment('new', parts.uncached.value), out: segment('out', parts.output.value) }
}

export function TokenBar({ tokens, large = false, children }: { readonly tokens: UsageTokenTotals; readonly large?: boolean; readonly children?: ReactNode }): ReactNode {
  const parts = tokenParts(tokens)
  const pieces = kindSegments(parts, 'usage-tokens__segment ')
  return <div className={`usage-tokens${large ? ' usage-tokens--large' : ''}`}>
    <div className="usage-tokens__brackets" aria-hidden="true">
      <span className="usage-tokens__bracket" style={{ flexGrow: Math.max(1, parts.input.value) }}><span><b><Figure of={parts.input} /></b>input</span></span>
      <span className="usage-tokens__bracket usage-tokens__bracket--output" style={{ flexGrow: Math.max(1, parts.output.value) }}><span><b><Figure of={parts.output} /></b>output</span></span>
    </div>
    <div className="usage-tokens__bar usage-grow" role="img" aria-label={`${figureWords(parts.input)} input tokens, including ${figureWords(parts.read)} cache read and ${figureWords(parts.write)} cache write, then ${figureWords(parts.output)} output tokens.`}>
      <span className="usage-tokens__group" style={{ flexGrow: Math.max(1, parts.input.value) }}>{pieces.read}{pieces.write}{pieces.new}</span>
      <span className="usage-tokens__group" style={{ flexGrow: Math.max(1, parts.output.value) }}>{pieces.out}</span>
    </div>
    <dl className="usage-tokens__legend">
      <div><dt><i className="usage-kind--read" />Cache read</dt><dd><Figure of={parts.read} /></dd></div>
      <div><dt><i className="usage-kind--write" />Cache write</dt><dd><Figure of={parts.write} /></dd></div>
      <div><dt><i className="usage-kind--new" />Uncached input</dt><dd><Figure of={parts.uncached} /></dd></div>
      <div><dt><i className="usage-kind--out" />Output</dt><dd><Figure of={parts.output} /></dd></div>
    </dl>
    {children}
  </div>
}

/** One model's tokens by kind, as wide as its share of the largest model's. */
export function CompositionBar({ tokens, maximum, reported }: { readonly tokens: UsageTokenTotals; readonly maximum: number; readonly reported: boolean }): ReactNode {
  if (!reported) return <span className="usage-composition usage-composition--unknown" aria-hidden="true" />
  const parts = tokenParts(tokens)
  const pieces = kindSegments(parts)
  return <span className="usage-composition usage-grow" style={{ '--usage-w': ((parts.input.value + parts.output.value) / Math.max(1, maximum)).toFixed(3) } as Style} aria-hidden="true">
    {pieces.read}{pieces.write}{pieces.new}{pieces.out}
  </span>
}

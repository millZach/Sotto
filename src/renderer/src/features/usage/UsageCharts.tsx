import React, { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { UsageTokenTotals } from '../../../../shared/usageDashboard'
import { fmtInt, fmtTok, hourLabel, shortDay, WEEKDAYS_SHORT, weekdayOf, LOW_LEFT } from './usagePresentation'

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

export interface DayValue { readonly day: string; readonly prompts: number; readonly input: number; readonly output: number }

/**
 * Bars per day with two gridlines. The plot is one keyboard stop: Left and Right read a day, Home and End the ends,
 * Escape goes back to the whole range. The stage above it says what the selected day holds.
 */
export function DailyChart({ series, metric, label, today, selected, onHover, onPin, onKey }: {
  readonly series: readonly DayValue[]
  readonly metric: 'prompts' | 'tokens'
  readonly label: string
  readonly today: string
  readonly selected: string | null
  readonly onHover: (day: string | null) => void
  readonly onPin: () => void
  readonly onKey: (event: KeyboardEvent<HTMLDivElement>) => void
}): ReactNode {
  const count = series.length
  const value = (row: DayValue): number => metric === 'prompts' ? row.prompts : row.input + row.output
  const peak = Math.max(0, ...series.map(value))
  const top = niceMax(Math.max(metric === 'prompts' ? 10 : 1e5, peak))
  const gap = count <= 7 ? 18 : count <= 45 ? 4 : count <= 100 ? 2 : 1
  const radius = count > 60 ? 1 : count > 20 ? 3 : 5
  const none = metric === 'tokens' && peak === 0
  const scale = (amount: number): string => metric === 'prompts' ? fmtInt(amount) : fmtTok(amount)
  const point = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const index = Math.max(0, Math.min(count - 1, Math.floor((event.clientX - rect.left) / rect.width * count)))
    onHover(series[index]?.day ?? null)
  }
  const marks = count <= 7 ? series.map((_, index) => index) : [0, Math.round((count - 1) / 2), count - 1]
  return <div className="usage-chart" style={{ '--usage-gap': `${gap}px`, '--usage-radius': `${radius}px`, '--usage-count': count } as Style}>
    <div className="usage-chart__plot tt-focusable" tabIndex={0} role="group" aria-label={`${label} Use Left and Right to read one day; Escape goes back to the whole range.`}
      data-active={selected !== null || undefined} onPointerMove={point} onPointerLeave={() => onHover(null)} onClick={onPin} onKeyDown={onKey}>
      <div className="usage-chart__columns">
        {series.map((row, index) => <span key={row.day} className="usage-chart__column" data-on={row.day === selected || undefined}>
          {metric === 'prompts'
            ? <i className="usage-chart__bar" style={{ '--usage-h': (row.prompts / top).toFixed(4), '--usage-i': index } as Style} />
            : <><i className="usage-chart__bar usage-chart__bar--input" style={{ '--usage-h': (row.input / top).toFixed(4), '--usage-i': index } as Style} />
              <i className="usage-chart__bar usage-chart__bar--output" style={{ '--usage-h': (row.output / top).toFixed(4), '--usage-i': index } as Style} /></>}
        </span>)}
      </div>
      {none ? <div className="usage-chart__none">No token counts in this range</div> : <>
        <div className="usage-chart__grid" style={{ top: 0 }}><span>{scale(top)}</span></div>
        <div className="usage-chart__grid" style={{ top: '50%' }}><span>{scale(top / 2)}</span></div>
      </>}
    </div>
    <div className="usage-chart__axis" aria-hidden="true">{marks.map((index, place) => {
      const day = series[index]!.day
      const text = day === today ? 'Today' : count <= 7 ? `${WEEKDAYS_SHORT[weekdayOf(day)]} ${Number(day.slice(8, 10))}` : shortDay(day)
      const edge = count > 7 && (place === 0 || place === marks.length - 1)
      const left = edge ? (place === 0 ? 0 : 100) : (index + 0.5) / count * 100
      return <span key={day} className={count > 7 && place === 0 ? 'usage-chart__tick--start' : count > 7 && place === marks.length - 1 ? 'usage-chart__tick--end' : undefined} style={{ left: `${left.toFixed(2)}%` }}>{text}</span>
    })}</div>
  </div>
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

/** Input, split into cache read, cache write and uncached input, beside output. Reads are part of input. */
export function tokenParts(tokens: UsageTokenTotals): { input: number; output: number; read: number; write: number; uncached: number; writeKnown: boolean; writePartial: boolean } {
  const input = tokens.input.value ?? 0, output = tokens.output.value ?? 0, read = tokens.cached.value ?? 0, write = tokens.cacheWrite.value ?? 0
  return { input, output, read, write, uncached: Math.max(0, input - read - write), writeKnown: tokens.cacheWrite.value !== undefined, writePartial: tokens.cacheWrite.partial }
}

export function TokenBar({ tokens, large = false, children }: { readonly tokens: UsageTokenTotals; readonly large?: boolean; readonly children?: ReactNode }): ReactNode {
  const parts = tokenParts(tokens)
  const segment = (kind: string, amount: number): ReactNode => amount > 0 ? <i className={`usage-tokens__segment usage-kind--${kind}`} style={{ flexGrow: amount }} /> : null
  const write = !parts.writeKnown ? <Dash /> : <>{parts.writePartial ? <small>at least </small> : null}{fmtTok(parts.write)}</>
  const writeWords = `${parts.writePartial ? 'at least ' : ''}${parts.writeKnown ? fmtTok(parts.write) : 'an unreported number of'}`
  return <div className={`usage-tokens${large ? ' usage-tokens--large' : ''}`}>
    <div className="usage-tokens__brackets" aria-hidden="true">
      <span className="usage-tokens__bracket" style={{ flexGrow: Math.max(1, parts.input) }}><span><b>{fmtTok(parts.input)}</b>input</span></span>
      <span className="usage-tokens__bracket usage-tokens__bracket--output" style={{ flexGrow: Math.max(1, parts.output) }}><span><b>{fmtTok(parts.output)}</b>output</span></span>
    </div>
    <div className="usage-tokens__bar usage-grow" role="img" aria-label={`${fmtTok(parts.input)} input tokens, including ${fmtTok(parts.read)} cache read and ${writeWords} cache write, then ${fmtTok(parts.output)} output tokens.`}>
      <span className="usage-tokens__group" style={{ flexGrow: Math.max(1, parts.input) }}>{segment('read', parts.read)}{segment('write', parts.write)}{segment('new', parts.uncached)}</span>
      <span className="usage-tokens__group" style={{ flexGrow: Math.max(1, parts.output) }}>{segment('out', parts.output)}</span>
    </div>
    <dl className="usage-tokens__legend">
      <div><dt><i className="usage-kind--read" />Cache read</dt><dd>{fmtTok(parts.read)}</dd></div>
      <div><dt><i className="usage-kind--write" />Cache write</dt><dd>{write}</dd></div>
      <div><dt><i className="usage-kind--new" />Uncached input</dt><dd>{fmtTok(parts.uncached)}</dd></div>
      <div><dt><i className="usage-kind--out" />Output</dt><dd>{fmtTok(parts.output)}</dd></div>
    </dl>
    {children}
  </div>
}

/** One model's tokens by kind, as wide as its share of the largest model's. */
export function CompositionBar({ tokens, maximum, reported }: { readonly tokens: UsageTokenTotals; readonly maximum: number; readonly reported: boolean }): ReactNode {
  if (!reported) return <span className="usage-composition usage-composition--unknown" aria-hidden="true" />
  const parts = tokenParts(tokens)
  const segment = (kind: string, amount: number): ReactNode => amount > 0 ? <i className={`usage-kind--${kind}`} style={{ flexGrow: amount }} /> : null
  return <span className="usage-composition usage-grow" style={{ '--usage-w': ((parts.input + parts.output) / Math.max(1, maximum)).toFixed(3) } as Style} aria-hidden="true">
    {segment('read', parts.read)}{segment('write', parts.write)}{segment('new', parts.uncached)}{segment('out', parts.output)}
  </span>
}

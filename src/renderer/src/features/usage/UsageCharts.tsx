import React, { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { UsageDailyAggregate, UsageHourlyAggregate, UsageTokenTotals } from '../../../../shared/usageDashboard'
import { formatCount, formatField } from './usagePresentation'

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const hourLabel = (hour: number): string => `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`
export function dismissDisclosure(event: KeyboardEvent<HTMLDetailsElement>): void {
  if (event.key !== 'Escape' || !event.currentTarget.open) return
  event.preventDefault(); event.currentTarget.open = false
  event.currentTarget.querySelector<HTMLElement>('summary')?.focus()
}

export function Ring({ percent, size = 100 }: { readonly percent: number | undefined; readonly size?: number }): ReactNode {
  const radius = 42
  const circumference = 2 * Math.PI * radius
  return <svg className="usage-ring" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-unknown={percent === undefined || undefined}>
    <circle className="usage-ring__track" cx="50" cy="50" r={radius} />
    {percent === undefined ? null : <circle className="usage-ring__arc" cx="50" cy="50" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, percent)) / 100)} />}
  </svg>
}

export function TokenBreakdown({ tokens }: { readonly tokens: UsageTokenTotals }): ReactNode {
  const fields = [['input', 'Input'], ['output', 'Output'], ['cached', 'Cache read'], ['cacheWrite', 'Cache write'], ['cacheWrite5m', 'Cache write · 5 minutes'], ['cacheWrite1h', 'Cache write · 1 hour']] as const
  const total = (tokens.input.value ?? 0) + (tokens.output.value ?? 0)
  return <>
    <p className="usage-total">{formatField(tokens.total, true)}<span>tokens reported</span></p>
    {total > 0 ? <div className="usage-token-bar" aria-hidden="true"><i className="usage-token-bar__input" style={{ flexGrow: tokens.input.value ?? 0 }} /><i className="usage-token-bar__output" style={{ flexGrow: tokens.output.value ?? 0 }} /></div> : null}
    <dl className="usage-token-facts">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{formatField(tokens[key], true)}</dd></div>)}</dl>
    <p className="usage-note">Total is input plus output. Cache reads and writes are already part of input. A dash means a count is unavailable; ≥ marks a lower bound.</p>
  </>
}

/** A single keyboard stop reads each day; a text table gives the chart a complete alternative. */
export function DailyChart({ rows, metric, complete, from, to }: {
  readonly rows: UsageDailyAggregate[]; readonly metric: 'prompts' | 'tokens'; readonly complete: boolean
  readonly from?: string | undefined; readonly to?: string | undefined
}): ReactNode {
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const description = useId()
  if (!complete) return <p className="usage-note">Choose a date range of up to one year to see the daily chart. The totals still include the full selected range.</p>
  const byDay = new Map(rows.map(row => [row.day, row]))
  const days: string[] = []
  const start = from ?? rows[0]?.day
  const finish = to ?? rows.at(-1)?.day
  if (start !== undefined && finish !== undefined) {
    const cursor = new Date(`${start}T12:00:00Z`)
    while (cursor.toISOString().slice(0, 10) <= finish && days.length < 366) { days.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1) }
  }
  const value = (day: string): number => metric === 'prompts' ? byDay.get(day)?.prompts.user ?? 0 : byDay.get(day)?.tokens.total.value ?? 0
  const maximum = Math.max(1, ...days.map(value))
  const selected = selectedDay !== null && days.includes(selectedDay) ? selectedDay : null
  const facts = (day: string): string => {
    const row = byDay.get(day)
    return metric === 'prompts' ? `${day}: ${formatCount(row?.prompts.user ?? 0)} prompts from you`
      : `${day}: ${row === undefined || row.tokenRecords === 0 ? 'no token records' : `${formatField(row.tokens.total)} tokens`}`
  }
  if (days.length === 0) return <p className="usage-note">No dated activity in this range.</p>
  return <div className="usage-chart">
    <p id={description} className="usage-chart__caption" aria-live="polite">{selected === null ? 'Point to a day, or use the arrow keys to read it.' : facts(selected)}</p>
    <div className="usage-chart__plot tt-focusable" data-dense={days.length > 90 || undefined} tabIndex={0} role="group" aria-label={`${metric === 'prompts' ? 'Your prompts' : 'Reported tokens'} per day`} aria-describedby={description}
      onMouseLeave={() => setSelectedDay(null)} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setSelectedDay(null); return }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = selected === null ? -1 : days.indexOf(selected)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : Math.max(0, Math.min(days.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))
        setSelectedDay(days[next]!)
      }}>
      {days.map(day => <div key={day} className="usage-chart__column" data-selected={day === selected || undefined} onMouseEnter={() => setSelectedDay(day)} title={facts(day)}>
        <i style={{ height: `${value(day) / maximum * 100}%` }} />
      </div>)}
    </div>
    <div className="usage-chart__axis" aria-hidden="true"><span>{days[0]}</span><span>{days.at(-1)}</span></div>
    <details className="usage-chart__table" onKeyDown={dismissDisclosure}><summary>Read daily counts</summary><table><thead><tr><th scope="col">Day</th><th scope="col">Your prompts</th><th scope="col">Tokens</th></tr></thead><tbody>{days.map(day => <tr key={day}><th scope="row">{day}</th><td>{formatCount(byDay.get(day)?.prompts.user ?? 0)}</td><td>{byDay.has(day) ? formatField(byDay.get(day)!.tokens.total) : '—'}</td></tr>)}</tbody></table></details>
  </div>
}

export function HourlyChart({ rows, timeZone }: { readonly rows: UsageHourlyAggregate[]; readonly timeZone: string }): ReactNode {
  const [selected, setSelected] = useState(0)
  const description = useId()
  const cells = new Map(rows.map(row => [row.weekday * 24 + row.hour, row.prompts.user]))
  const maximum = Math.max(1, ...cells.values())
  const facts = (index: number): string => `${WEEKDAYS[Math.floor(index / 24)]}, ${hourLabel(index % 24)}: ${formatCount(cells.get(index) ?? 0)} prompts from you`
  return <>
    <p id={description} className="usage-note" aria-live="polite">{facts(selected)} · {timeZone}</p>
    <div className="usage-hours tt-focusable" tabIndex={0} role="group" aria-label="Your prompts by weekday and hour" aria-describedby={description} onKeyDown={event => {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0
      if (step === 0 && !['Home', 'End'].includes(event.key)) return
      event.preventDefault(); setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? 167 : (selected + step + 168) % 168)
    }}>
      {WEEKDAYS.map((day, weekday) => <React.Fragment key={day}><span className="usage-hours__day">{day}</span>{Array.from({ length: 24 }, (_, hour) => {
        const index = weekday * 24 + hour
        return <span key={hour} className="usage-hours__cell" data-selected={selected === index || undefined} style={{ '--usage-intensity': (cells.get(index) ?? 0) / maximum } as CSSProperties} onMouseEnter={() => setSelected(index)} title={facts(index)} />
      })}</React.Fragment>)}
      <div className="usage-hours__axis" aria-hidden="true">{[0, 6, 12, 18].map(hour => <span key={hour}>{hourLabel(hour)}</span>)}</div>
    </div>
    <details className="usage-chart__table" onKeyDown={dismissDisclosure}><summary>Read hourly counts</summary><table><thead><tr><th scope="col">Weekday</th><th scope="col">Hour</th><th scope="col">Your prompts</th></tr></thead><tbody>{rows.filter(row => row.prompts.user > 0).sort((a, b) => a.weekday - b.weekday || a.hour - b.hour).map(row => <tr key={`${row.weekday}:${row.hour}`}><th scope="row">{WEEKDAYS[row.weekday]}</th><td>{hourLabel(row.hour)}</td><td>{formatCount(row.prompts.user)}</td></tr>)}</tbody></table></details>
  </>
}

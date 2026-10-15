import React, { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { USAGE_TOKEN_FIELDS, type UsageModelAggregate, type UsageProviderId } from '../../../../shared/usageDashboard'
import { ProviderMark } from '../../agents/ProviderMark'
import { roomKeyTarget } from '../../components/AppShell'
import { DailyChart, Dash, HourGrid, Ring, Spark, TokenBar, dismissDisclosure, type DayValue } from './UsageCharts'
import type { UsagePage } from './usagePage'
import {
  PROVIDER_ORDER, LOW_LEFT, NO_TOKENS, cacheShare, nounFor, PROVIDER_NAMES, CLIENT_NAMES, fieldShare, fieldTokens, fieldValue, fmtInt, fmtTok, hourLabel, joinNames, longDay, midSentence, pct, readAge, resetLong, resetShort, sentFrom, share,
  shortDay, usagePlaces, WEEKDAYS_PLURAL, WEEKDAYS_SHORT, type UsageProviderLimits,
} from './usagePresentation'

const FOCUS = ['room', 'prompts', 'tokens', 'where', 'cache', 'models', 'rhythm'] as const
type Focus = typeof FOCUS[number]
const FOCUS_NAMES: Record<Focus, string> = { room: 'Room left', prompts: 'Prompts', tokens: 'Tokens', where: 'Where', cache: 'From cache', models: 'Most used model', rhythm: 'Busiest hour' }
type Cell = { weekday: number; hour: number }

/** The served model a prompt landed on, unless it went unmatched. */
const named = (row: UsageModelAggregate): boolean => row.modelId !== 'unknown' && row.prompts.total > 0

function ProviderMarks({ providers }: { readonly providers: readonly UsageProviderId[] }): ReactNode {
  if (providers.length === 0) return null
  return <span className="usage-marks">{providers.map(id => <ProviderMark key={id} provider={id} name={PROVIDER_NAMES[id]} size={14} />)}</span>
}

export function Overview({ page }: { readonly page: UsagePage }): ReactNode {
  const [focus, setFocus] = useState<Focus>('prompts')
  const [hover, setHover] = useState<string | null>(null)
  const [pin, setPin] = useState<string | null>(null)
  const [cell, setCell] = useState<Cell | null>(null)
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('vertical')
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const { summary, limits } = page
  const totals = summary.totals

  useLayoutEffect(() => {
    const element = list.current?.parentElement
    if (!element) return
    const measure = (): void => { const width = element.getBoundingClientRect().width; if (width > 0) setOrientation(width <= 780 ? 'horizontal' : 'vertical') }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])

  const choose = (value: Focus): void => { setFocus(value); setHover(null); setPin(null); setCell(null) }
  const onIndexKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = roomKeyTarget(event.key, index, FOCUS.length)
    if (target === null) return
    event.preventDefault(); choose(FOCUS[target]!)
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus()
  }
  const reveal = (button: HTMLButtonElement): void => {
    const strip = button.parentElement
    if (strip !== null && strip.scrollWidth > strip.clientWidth) button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }

  // Index values.
  const readable = limits.filter(item => item.primary.tightest !== undefined)
  const lowest = readable.reduce<UsageProviderLimits | undefined>((best, item) => best === undefined || item.primary.tightest!.left! < best.primary.tightest!.left! ? item : best, undefined)
  const prompts = totals.prompts.total
  const tokenTotal = fieldValue(totals.tokens.total)
  const topModel = summary.modelsTruncated ? undefined : summary.models.filter(named)[0]
  const busiest = summary.busiest
  const series = daySeries(page)
  const sottoShare = fieldShare(summary.sottoField, totals.tokens.total) ?? '—'
  const items: Record<Focus, { value: ReactNode; text: string; note: string; viz?: ReactNode; low?: boolean; words?: boolean }> = {
    room: {
      value: lowest === undefined ? '—' : `${lowest.primary.tightest!.left}%`, text: lowest === undefined ? '—' : `${lowest.primary.tightest!.left}%`,
      note: lowest === undefined ? 'No limits read' : `Lowest: ${PROVIDER_NAMES[lowest.providerId]}, ${lowest.primary.tightest!.label.toLowerCase()}`,
      viz: limits.length === 0 ? undefined : <span className="usage-mini-rings">{limits.map(item => <Ring key={item.providerId} size={14} parts={[{ left: item.primary.tightest?.left, width: 2.5, inset: 0 }]} stale={item.primary.stale} />)}</span>,
      low: lowest !== undefined && lowest.primary.tightest!.left! <= LOW_LEFT,
    },
    prompts: { value: fmtInt(prompts), text: fmtInt(prompts), note: page.rangeLabel, viz: series === null ? undefined : <Spark values={series.map(row => row.prompts)} /> },
    tokens: { value: fieldTokens(totals.tokens.total), text: fieldTokens(totals.tokens.total), note: 'input + output' },
    where: tokenTotal > 0
      ? { value: <>{sottoShare}<span className="usage-index__unit">in Sotto</span></>, text: `${sottoShare} in Sotto`,
        note: `of tokens · ${share(summary.sottoPrompts, prompts)} of prompts`,
        viz: <span className="usage-mini-split" aria-hidden="true"><i className="usage-where--sotto" style={{ flexGrow: summary.sottoTokens }} /><i className="usage-where--outside" style={{ flexGrow: Math.max(0, tokenTotal - summary.sottoTokens) }} /></span> }
      : { value: '—', text: '—', note: 'No tokens in this range' },
    cache: { value: summary.cacheShare === undefined ? '—' : pct(summary.cacheShare), text: summary.cacheShare === undefined ? '—' : pct(summary.cacheShare), note: 'of input tokens' },
    models: {
      value: topModel === undefined ? '—' : page.modelName(topModel), text: topModel === undefined ? '—' : page.modelName(topModel), words: true,
      note: summary.modelsTruncated ? 'Ranking is incomplete' : topModel !== undefined ? `${share(topModel.prompts.total, prompts)} of prompts` : prompts > 0 ? 'Not matched for these prompts' : 'No prompts yet',
    },
    rhythm: { value: busiest === undefined ? '—' : `${WEEKDAYS_SHORT[busiest.weekday]} ${hourLabel(busiest.hour)}`, text: busiest === undefined ? '—' : `${WEEKDAYS_SHORT[busiest.weekday]} ${hourLabel(busiest.hour)}`, note: 'when you send the most', words: true },
  }

  const selected = hover ?? pin
  const day = selected !== null && series?.some(row => row.day === selected) ? selected : null
  const onChartKey = (metric: 'prompts' | 'tokens') => (event: KeyboardEvent<HTMLDivElement>): void => {
    if (series === null || series.length === 0) return
    const index = (value: string | null): number => value === null ? -1 : series.findIndex(row => row.day === value)
    let current = pin ?? hover
    const last = series.length - 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') current = current === null ? series[last]!.day : series[Math.max(0, Math.min(last, index(current) + (event.key === 'ArrowRight' ? 1 : -1)))]!.day
    else if (event.key === 'Home') current = series[0]!.day
    else if (event.key === 'End') current = series[last]!.day
    else if (event.key === 'Escape' && pin !== null) current = null
    else return
    event.preventDefault(); event.stopPropagation(); setHover(null); setPin(current)
    const row = current === null ? undefined : series.find(item => item.day === current)
    const amount = current === null ? (metric === 'tokens' ? fieldTokens(totals.tokens.total) : fmtInt(prompts)) : (metric === 'tokens' ? dayTokens(row!) : fmtInt(row!.prompts))
    page.announce(`${current === null ? 'Whole range' : longDay(current, page.today)}: ${amount} ${metric === 'tokens' ? 'tokens' : 'prompts'}`)
  }
  const chart = (metric: 'prompts' | 'tokens', label: string): ReactNode => series === null
    ? <p className="usage-none">Choose a range of a year or less to see each day. The totals still cover the whole range.</p>
    : series.length === 0 ? <p className="usage-none">No dated activity in this range.</p>
      : <DailyChart series={series} metric={metric} label={label} today={page.today} selected={day}
        onHover={setHover} onPin={() => { setPin(hover === null || pin === hover ? null : hover); setHover(null) }} onKey={onChartKey(metric)} />
  const head = (title: string, right: ReactNode = page.rangeLabel): ReactNode => <div className="usage-stage__head"><h2>{title}</h2>{typeof right === 'string' ? <span>{right}</span> : right}</div>
  const placesNote = page.withoutPlacesNote === null ? null : <p className="usage-note">{page.withoutPlacesNote}</p>

  let stage: ReactNode
  switch (focus) {
    case 'room':
      stage = <>
        {head('Room left', <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('subscriptions')}>Subscriptions</button>)}
        <p className="usage-when">Account-wide, as each provider reports it.</p>
        {limits.length === 0 ? <p className="usage-none">No subscription readings on the selected computers.</p> : <div className="usage-rings">{limits.map(item => <RingCard key={item.providerId} limits={item} page={page} />)}</div>}
      </>
      break
    case 'tokens': {
      const devin = summary.providers.filter(row => NO_TOKENS.has(row.providerId) && row.prompts.total > 0)
      stage = <>
        {head('Tokens')}
        {totals.tokens.input.value === undefined && totals.tokens.output.value === undefined
          ? <p className="usage-none">{devin.length > 0 ? "Devin doesn't report tokens. Prompts are still counted." : 'No tokens in this range.'}</p>
          : <TokenBar tokens={totals.tokens} large>
            {page.placesKnown ? <p className="usage-note">Subagents: <b>{fmtTok(summary.subAgentTokens)}</b> of these tokens.</p> : null}
            {devin.length > 0 ? <p className="usage-note">Devin doesn't report tokens, so its <b>{fmtInt(devin.reduce((sum, row) => sum + row.prompts.total, 0))}</b> {nounFor(devin.reduce((sum, row) => sum + row.prompts.total, 0), 'prompt')} aren't in these totals.</p> : null}
          </TokenBar>}
        <div className="usage-stage__sub">
          <div className="usage-chart-head"><h3>Per day</h3><span className="usage-legend"><span><i className="usage-kind--input" />Input</span><span><i className="usage-kind--out" />Output</span></span></div>
          <p className="usage-when">{day !== null ? (() => { const row = series!.find(item => item.day === day)!; return <><b>{longDay(day, page.today)}</b> · {!row.tokensKnown ? 'tokens not reported' : row.input + row.output > 0 || row.tokensPartial ? `${row.tokensPartial ? 'at least ' : ''}${fmtTok(row.input)} input, ${fmtTok(row.output)} output` : 'no tokens'}</> })()
            : prompts > 0 && tokenTotal > 0 ? <>{totals.tokens.total.partial ? 'At least' : 'About'} <b>{fmtTok(tokenTotal / prompts)}</b> tokens per prompt</> : null}</p>
          {chart('tokens', `Tokens per day, ${page.rangeLabel}.`)}
        </div>
      </>
      break
    }
    case 'where': {
      const places = usagePlaces(summary.clients)
      const top = Math.max(1, ...places.map(place => place.tokens))
      const only = page.provider === 'all' ? undefined : page.provider
      const marks = (place: (typeof places)[number]): UsageProviderId[] => only !== undefined ? [only] : place.provider !== undefined ? [place.provider]
        : place.providers.length > 0 ? [...place.providers].sort((a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b))
        : place.inSotto && page.where === 'sotto' ? summary.providers.filter(row => row.prompts.total > 0 || fieldValue(row.tokens.total) > 0).map(row => row.providerId) : []
      stage = <>
        {head('Where you work')}
        <p className="usage-when">{tokenTotal > 0 ? <><b>{sottoShare}</b> of tokens and <b>{share(summary.sottoPrompts, prompts)}</b> of prompts were in Sotto.</> : 'No tokens in this range.'}</p>
        {places.length === 0 ? <p className="usage-none">Nothing in this range.</p> : <ol className="usage-shares usage-shares--where">{places.map(place => {
          const line = place.subAgent ? 'No prompts of their own. Your Sotto threads started them.'
            : `${fmtInt(place.prompts)} prompt${place.prompts === 1 ? '' : 's'}${place.wakeUps > 0 ? `, ${fmtInt(place.wakeUps)} of them wake-ups` : ''}${place.subAgentTokens > 0 ? ` · ${fieldTokens(place.subAgentField)} of the tokens from subagents` : ''}`
          return <li key={place.key} className="usage-share">
            <span className="usage-share__name"><ProviderMarks providers={marks(place)} /><span>{place.name}</span></span>
            <span className="usage-share__value">{fieldShare(place.tokenField, totals.tokens.total) ?? <Dash />}<small>{fieldTokens(place.tokenField)} tokens</small></span>
            <span className="usage-share__bar"><i className={`usage-grow${place.inSotto ? '' : ' usage-share__fill--outside'}`} style={{ '--usage-w': (place.tokens / top).toFixed(3) } as React.CSSProperties} /></span>
            <span className="usage-share__note">{line}</span>
          </li>
        })}</ol>}
        <p className="usage-legend usage-legend--below"><span><i className="usage-where--sotto" />In Sotto</span><span><i className="usage-where--outside" />Outside Sotto</span></p>
        {placesNote}
      </>
      break
    }
    case 'cache': {
      const reported = summary.models.filter(row => !NO_TOKENS.has(row.providerId) && fieldValue(row.tokens.input) > 0 && cacheShare(row.tokens) !== undefined)
      const shown = [...reported].sort((a, b) => fieldValue(b.tokens.input) - fieldValue(a.tokens.input)).slice(0, 8)
        .sort((a, b) => fieldValue(b.tokens.cached) / fieldValue(b.tokens.input) - fieldValue(a.tokens.cached) / fieldValue(a.tokens.input))
      const rest = reported.length - shown.length
      const { input } = totals.tokens
      const unshared = USAGE_TOKEN_FIELDS.every(name => totals.tokens[name].value === undefined) ? 'No token counts in this range.'
        : input.value === undefined ? "Input tokens weren't reported in this range, so the share from cache can't be worked out."
          : input.value === 0 && !input.partial ? 'No input tokens in this range, so none came from cache.'
            : "Some token counts in this range weren't reported in full, so the share from cache can't be worked out."
      stage = summary.cacheShare === undefined ? <>{head('Cache reads')}<p className="usage-none">{unshared}</p></> : <>
        {head('Cache reads')}
        <div className="usage-cache">
          <div className="usage-ring-figure usage-ring-figure--large"><Ring size={156} parts={[{ left: summary.cacheShare * 100, width: 10, inset: 0 }]} lowAware={false} /><span><b>{pct(summary.cacheShare)}</b><small>of input</small></span></div>
          <div>
            <p className="usage-lead">{fieldTokens(totals.tokens.cached)} of {fieldTokens(totals.tokens.input)} input tokens were read from cache. They count as input, not on top of it.</p>
            <ol className="usage-shares">{shown.map(row => {
              const fraction = fieldValue(row.tokens.cached) / fieldValue(row.tokens.input)
              return <li key={`${row.providerId}:${row.modelId}`} className="usage-share">
                <span className="usage-share__name"><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={14} /><span>{page.modelName(row)}</span></span>
                <span className="usage-share__value">{pct(fraction)}<small>{fieldTokens(row.tokens.input)} input</small></span>
                <span className="usage-share__bar"><i className="usage-grow" style={{ '--usage-w': fraction.toFixed(3) } as React.CSSProperties} /></span>
              </li>
            })}</ol>
            {rest > 0 ? <p className="usage-more-line">{rest} more in <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('models')}>Models</button></p> : null}
          </div>
        </div>
      </>
      break
    }
    case 'models': {
      const ranked = summary.models.filter(row => row.prompts.total > 0)
      const top = Math.max(1, ranked[0]?.prompts.total ?? 1)
      const shown = ranked.slice(0, 8)
      stage = <>
        {head('Models', <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('models')}>All model details</button>)}
        {shown.length === 0 || prompts === 0 ? <p className="usage-none">No prompts in this range.</p> : <ol className="usage-shares">{shown.map(row => {
          const tokens = fieldValue(row.tokens.total)
          const detail = NO_TOKENS.has(row.providerId) || row.tokens.total.value === undefined ? 'Tokens not reported' : tokens > 0 ? `${fieldTokens(row.tokens.total)} tokens · ${cacheShare(row.tokens) ?? 'an unreported share'} from cache` : 'No tokens of its own'
          return <li key={`${row.providerId}:${row.modelId}`} className="usage-share">
            <span className="usage-share__name"><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={14} /><span>{page.modelName(row)}</span></span>
            <span className="usage-share__value">{share(row.prompts.total, prompts)}<small>{fmtInt(row.prompts.total)}</small></span>
            <span className="usage-share__bar"><i className="usage-grow" style={{ '--usage-w': (row.prompts.total / top).toFixed(3) } as React.CSSProperties} /></span>
            <span className="usage-share__note">{detail} · {fmtInt(row.activeThreads)} provider session{row.activeThreads === 1 ? '' : 's'}</span>
          </li>
        })}</ol>}
        {ranked.length > shown.length ? <p className="usage-more-line">{ranked.length - shown.length} more in <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('models')}>Models</button></p> : null}
      </>
      break
    }
    case 'rhythm': {
      const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
      for (const row of summary.hourly) { const day = grid[row.weekday]!; day[row.hour] = (day[row.hour] ?? 0) + row.prompts.user }
      const when = cell !== null
        ? <><b>{WEEKDAYS_PLURAL[cell.weekday]}, {hourLabel(cell.hour)} to {hourLabel(cell.hour + 1)}</b> · {fmtInt(grid[cell.weekday]![cell.hour]!)} prompt{grid[cell.weekday]![cell.hour] === 1 ? '' : 's'} in this range</>
        : busiest !== undefined ? <>Busiest: <b>{WEEKDAYS_PLURAL[busiest.weekday]} around {hourLabel(busiest.hour)}</b>, {fmtInt(busiest.prompts.user)} {nounFor(busiest.prompts.user, 'prompt')} in this range</> : 'No prompts in this range.'
      const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
        let { weekday, hour } = cell ?? { weekday: 0, hour: 9 }
        if (event.key === 'ArrowLeft') hour = Math.max(0, hour - 1)
        else if (event.key === 'ArrowRight') hour = Math.min(23, hour + 1)
        else if (event.key === 'ArrowUp') weekday = Math.max(0, weekday - 1)
        else if (event.key === 'ArrowDown') weekday = Math.min(6, weekday + 1)
        else if (event.key === 'Home') hour = 0
        else if (event.key === 'End') hour = 23
        else if (event.key === 'Escape' && cell !== null) { event.preventDefault(); event.stopPropagation(); setCell(null); return }
        else return
        event.preventDefault(); setCell({ weekday, hour })
        const count = grid[weekday]![hour]!
        page.announce(`${WEEKDAYS_PLURAL[weekday]}, ${hourLabel(hour)} to ${hourLabel(hour + 1)}: ${fmtInt(count)} prompt${count === 1 ? '' : 's'}`)
      }
      stage = <>
        {head('When you work')}
        <p className="usage-when">{when}</p>
        <div onPointerLeave={event => { if (document.activeElement !== event.currentTarget.firstElementChild) setCell(null) }}>
          <HourGrid grid={grid} cell={cell} onCell={setCell} onKey={onKey} label="Prompts you sent, by weekday and hour. Use the arrow keys to read one hour." />
        </div>
      </>
      break
    }
    default: {
      const byProvider = summary.providers.filter(row => row.prompts.total > 0)
      const clients = sentFrom(summary.clients)
      const peak = series?.reduce<DayValue | undefined>((best, row) => best === undefined || row.prompts > best.prompts ? row : best, undefined)
      const when = day !== null ? (() => { const row = series!.find(item => item.day === day)!; return <><b>{longDay(day, page.today)}</b> · {fmtInt(row.prompts)} prompt{row.prompts === 1 ? '' : 's'}</> })()
        : peak !== undefined && peak.prompts > 0 ? <>{prompts / series!.length < 0.5 ? <>Under <b>1</b> a day</> : <>About <b>{fmtInt(prompts / series!.length)}</b> a day</>} · most on {shortDay(peak.day)}, <b>{fmtInt(peak.prompts)}</b></> : 'No prompts in this range.'
      stage = <>
        {head('Prompts')}
        <p className="usage-when">{when}</p>
        {chart('prompts', `Prompts per day, ${page.rangeLabel}.`)}
        {byProvider.length > 0 ? <div className="usage-split-block"><p className="usage-split-caption">By provider</p><div className="usage-split">{byProvider.map(row => <div key={row.providerId} className="usage-split__item">
          <span><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={14} />{PROVIDER_NAMES[row.providerId]}</span><b>{fmtInt(row.prompts.total)}</b>
        </div>)}</div></div> : null}
        {prompts > 0 ? <div className="usage-split-block"><p className="usage-split-caption">Sent from</p>
          {clients.length > 0 ? <div className="usage-split usage-split--small">{clients.map(row => <div key={row.clientId} className="usage-split__item"><span>{CLIENT_NAMES[row.clientId]}</span><b>{fmtInt(row.prompts)}</b></div>)}</div> : null}
          {placesNote}
        </div> : null}
        <p className="usage-origin">You sent <b>{fmtInt(totals.prompts.user)}</b>, Watcher <b>{fmtInt(totals.prompts.watcher)}</b> and wake-ups <b>{fmtInt(totals.prompts.wakeUp)}</b>.</p>
      </>
    }
  }

  return <>
    <div className="usage-focus">
      <div ref={list} className="usage-index" role="tablist" aria-label="Usage measures" aria-orientation={orientation}>
        {FOCUS.map((value, index) => {
          const item = items[value]
          return <button key={value} type="button" role="tab" id={`${id}-${value}`} className="usage-index__item tt-focusable" aria-selected={focus === value} tabIndex={focus === value ? 0 : -1}
            aria-controls={`${id}-stage`} aria-label={`${FOCUS_NAMES[value]} ${item.text} ${item.note}`}
            onClick={() => choose(value)} onFocus={event => reveal(event.currentTarget)} onKeyDown={event => onIndexKey(event, index)}>
            <span className="usage-index__label">{FOCUS_NAMES[value]}</span>
            <span className="usage-index__value" data-words={item.words || undefined} data-low={item.low || undefined} title={typeof item.value === 'string' ? item.value : undefined}>{item.value}</span>
            <span className="usage-index__viz">{item.viz}</span>
            <span className="usage-index__note" title={item.note}>{item.note}</span>
          </button>
        })}
      </div>
      <section key={focus} className="usage-stage usage-enter" id={`${id}-stage`} role="tabpanel" aria-labelledby={`${id}-${focus}`}>{stage}</section>
    </div>
    <About page={page} />
  </>
}

/** A day's tokens in words, keeping what was not reported. */
const dayTokens = (row: DayValue): string => !row.tokensKnown ? 'not reported,' : `${row.tokensPartial ? 'at least ' : ''}${fmtTok(row.input + row.output)}`

/** The days a chart draws: the chosen range, or from the first day with activity for All time. Null when the host left days out. */
export function daySeries(page: UsagePage): DayValue[] | null {
  if (!page.summary.dailyComplete) return null
  const rows = new Map(page.summary.daily.map(row => [row.day, row]))
  const days = page.days
  return days.map(day => {
    const row = rows.get(day)
    return { day, prompts: row?.prompts.total ?? 0, input: row?.tokens.input.value ?? 0, output: row?.tokens.output.value ?? 0,
      tokensKnown: row === undefined || row.tokenRecords === 0 || row.tokens.total.value !== undefined, tokensPartial: row?.tokens.total.partial ?? false }
  })
}

function RingCard({ limits, page }: { readonly limits: UsageProviderLimits; readonly page: UsagePage }): ReactNode {
  const { primary, providerId } = limits
  const windows = primary.windows
  const longest = primary.longest, shortest = primary.shortest
  const parts = windows.length > 0 && longest !== undefined
    ? [{ left: longest.left, width: 8, inset: 0 }, ...(windows.length > 1 && shortest !== undefined ? [{ left: shortest.left, width: 6, inset: 13, inner: true }] : [])]
    : [{ left: undefined, width: 6, inset: 0 }]
  const tightest = primary.tightest
  const rows = windows.length > 0 && longest !== undefined ? [longest, ...(windows.length > 1 && shortest !== undefined ? [shortest] : [])] : []
  return <div className="usage-ring-card">
    <div className="usage-ring-figure"><Ring size={116} parts={parts} stale={primary.stale} />
      <span>{tightest !== undefined ? <><b data-low={tightest.left! <= LOW_LEFT || undefined}>{tightest.left}%</b><small>left</small></> : <b className="usage-dash" aria-hidden="true">—</b>}</span>
    </div>
    <div className="usage-ring-card__name"><ProviderMark provider={providerId} name={PROVIDER_NAMES[providerId]} size={15} />{PROVIDER_NAMES[providerId]}</div>
    <ul className="usage-ring-card__rows">
      {rows.length > 0 ? rows.map((window, index) => <li key={window.id}><i className={`usage-dot${index > 0 ? ' usage-dot--inner' : ''}`} />{window.label} {window.left === undefined ? <Dash /> : <b data-low={window.left <= LOW_LEFT || undefined}>{window.left}%</b>}{window.resetsAt === undefined ? null : ` · ${resetShort(window.resetsAt, page.now, page.timeZone)}`}</li>)
        : <li>{providerId === 'devin' || primary.quota.reason === 'unsupported' ? "Sotto can't read these limits yet" : `No reading from ${midSentence(page.hostName(primary.hostId))}`}</li>}
      {rows.length > 0 ? <li className="usage-ring-card__fresh">{tightest !== undefined ? readAge(primary.observedAt, page.now) : 'Use not reported'}</li> : null}
    </ul>
  </div>
}

/** Room left as small gauges, for pages that have no history to show. */
export function Glance({ page }: { readonly page: UsagePage }): ReactNode {
  if (page.limits.length === 0) return null
  return <section className="usage-glance" aria-label="Room left on each subscription">{page.limits.map(item => {
    const { primary, providerId } = item
    const name = PROVIDER_NAMES[providerId]
    const tight = primary.tightest, longest = primary.longest
    let sub: ReactNode, label: string
    if (tight !== undefined) {
      sub = <><b data-low={tight.left! <= LOW_LEFT || undefined}>{tight.left}%</b> left · {primary.stale ? readAge(primary.observedAt, page.now).toLowerCase() : tight.resetsAt === undefined ? tight.label.toLowerCase() : `resets ${resetShort(tight.resetsAt, page.now, page.timeZone)}`}</>
      label = `${name}: ${tight.left}% left in the ${tight.noun}${tight.resetsAt === undefined ? '' : `, resets ${resetLong(tight.resetsAt, page.now, page.timeZone)}`}`
    } else if (longest?.resetsAt !== undefined) {
      sub = `Use not reported · resets ${resetShort(longest.resetsAt, page.now, page.timeZone)}`
      label = `${name}: use not reported, the ${longest.noun} resets ${resetLong(longest.resetsAt, page.now, page.timeZone)}`
    } else if (providerId === 'devin' || primary.quota.reason === 'unsupported') { sub = "Can't read limits"; label = `${name}: limits can't be read yet` }
    else { const from = midSentence(page.hostName(primary.hostId)); sub = `No reading from ${from}`; label = `${name}: no reading from ${from}` }
    return <button key={providerId} type="button" className="usage-gauge tt-focusable" aria-label={`${label}. Open Subscriptions`} onClick={() => page.openProvider(providerId)}>
      <Ring size={34} parts={[{ left: tight?.left, width: 3.5, inset: 0 }]} stale={primary.stale} />
      <span><span className="usage-gauge__name">{name}</span><span className="usage-gauge__sub">{sub}</span></span>
    </button>
  })}</section>
}

/** The page with nothing to draw: a few empty bars, what is missing and what brings it back. */
export function EmptyUsage({ title, detail, bars = [8, 14, 10, 22, 16, 6, 18] }: { readonly title: string; readonly detail: string; readonly bars?: readonly number[] }): ReactNode {
  return <div className="usage-empty">
    <div className="usage-empty__art" aria-hidden="true">{bars.map((height, index) => <i key={index} style={{ height: height * 2 }} />)}</div>
    <h2>{title}</h2>
    <p>{detail}</p>
  </div>
}

export function NoHistory({ names }: { readonly names: readonly string[] }): ReactNode {
  const name = joinNames(names)
  return <EmptyUsage title={`No history from ${joinNames(names.map(midSentence))} yet`} detail={`${name}'s history appears after its Owl host update.`} />
}

export function About({ page }: { readonly page: UsagePage }): ReactNode {
  return <details className="usage-about" onKeyDown={dismissDisclosure}>
    <summary className="tt-focusable"><ChevronRight size={14} aria-hidden="true" />About these numbers</summary>
    <ul>
      <li>Limits come from each provider and count all use of the account, in Sotto or anywhere else. Two computers' readings are shown side by side, never added.</li>
      <li>Activity counts the work on each computer: Sotto threads, the subagents they start, and Claude Code and Codex used outside Sotto. Grok Build and Devin are counted in Sotto only.</li>
      <li>Prompts are what you, Watcher and wake-ups sent. Subagents add tokens but no prompts. A prompt counts under the model that served it.</li>
      <li>Total tokens are input plus output. Cache reads and writes are part of input, not extra.</li>
      <li>A dash means the provider didn't report that number. It isn't zero. A ≥ means some records left a number out, so the figure is at least that.</li>
      <li>Usage keeps only numbers, dates, model names and app names. Deleting a thread or turning History off leaves it as it is; Clear usage removes it.</li>
      <li>Dates and hours use this computer's time zone, {page.timeZone.replace(/_/gu, ' ')}.</li>
    </ul>
  </details>
}


import React, { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { USAGE_TOKEN_FIELDS, type UsageModelAggregate, type UsageProviderId } from '../../../../shared/usageDashboard'
import { ProviderMark } from '../../agents/ProviderMark'
import { roomKeyTarget } from '../../components/AppShell'
import { Dash, HourGrid, Ring, Spark, TokenBar, dismissDisclosure, type DayValue } from './UsageCharts'
import { PerDay, useChartChoice } from './UsagePerDay'
import type { UsagePage } from './usagePage'
import {
  PROVIDER_ORDER, LOW_LEFT, NO_TOKENS, cacheShare, PROVIDER_NAMES, clientName, fieldShare, fieldTokens, fieldValue, fmtInt, fmtTok, hourLabel, joinNames, longDay, midSentence, pct, readAge, readAgePhrase, resetLong, resetShort, sentFrom, share,
  shortDay, usagePlaces, WEEKDAYS_PLURAL, WEEKDAYS_SHORT, type UsageProviderLimits,
} from './usagePresentation'

const FOCUS = ['room', 'prompts', 'tokens', 'where', 'cache', 'models', 'rhythm'] as const
type Focus = typeof FOCUS[number]
const FOCUS_NAMES: Record<Focus, MessageDescriptor> = {
  room: msg`Room left`, prompts: msg`Prompts`, tokens: msg`Tokens`, where: msg`Where`, cache: msg`From cache`, models: msg`Most used model`, rhythm: msg`Busiest hour`,
}
type Cell = { weekday: number; hour: number }

/** The served model a prompt landed on, unless it went unmatched. */
const named = (row: UsageModelAggregate): boolean => row.modelId !== 'unknown' && row.prompts.total > 0

function ProviderMarks({ providers }: { readonly providers: readonly UsageProviderId[] }): ReactNode {
  if (providers.length === 0) return null
  return <span className="usage-marks">{providers.map(id => <ProviderMark key={id} provider={id} name={PROVIDER_NAMES[id]} size={14} />)}</span>
}

export function Overview({ page }: { readonly page: UsagePage }): ReactNode {
  const { t, i18n } = useLingui()
  const [focus, setFocus] = useState<Focus>('prompts')
  const [hover, setHover] = useState<string | null>(null)
  const [pin, setPin] = useState<string | null>(null)
  const [cell, setCell] = useState<Cell | null>(null)
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('vertical')
  const [chartChoice, setChartChoice] = useChartChoice()
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

  // Index values.
  const readable = limits.filter(item => item.primary.tightest !== undefined)
  const lowest = readable.reduce<UsageProviderLimits | undefined>((best, item) => best === undefined || item.primary.tightest!.left! < best.primary.tightest!.left! ? item : best, undefined)
  const prompts = totals.prompts.total
  const tokenTotal = fieldValue(totals.tokens.total)
  const topModel = summary.modelsTruncated ? undefined : summary.models.filter(named)[0]
  const busiest = summary.busiest
  const series = daySeries(page)
  const sottoShare = fieldShare(summary.sottoField, totals.tokens.total) ?? '—'
  const sottoPromptShare = share(summary.sottoPrompts, prompts)
  const lowestName = lowest === undefined ? '' : PROVIDER_NAMES[lowest.providerId]
  const lowestWindow = lowest?.primary.tightest?.phrase ?? ''
  const topShare = topModel === undefined ? '' : share(topModel.prompts.total, prompts)
  const items: Record<Focus, { value: ReactNode; text: string; note: string; viz?: ReactNode; low?: boolean; words?: boolean }> = {
    room: {
      value: lowest === undefined ? '—' : `${lowest.primary.tightest!.left}%`, text: lowest === undefined ? '—' : `${lowest.primary.tightest!.left}%`,
      note: lowest === undefined ? t`No limits read` : t`Lowest: ${lowestName}, ${lowestWindow}`,
      viz: limits.length === 0 ? undefined : <span className="usage-mini-rings">{limits.map(item => <Ring key={item.providerId} size={14} parts={[{ left: item.primary.tightest?.left, width: 2.5, inset: 0 }]} stale={item.primary.stale} />)}</span>,
      low: lowest !== undefined && lowest.primary.tightest!.left! <= LOW_LEFT,
    },
    prompts: { value: fmtInt(prompts), text: fmtInt(prompts), note: page.rangeLabel, viz: series === null ? undefined : <Spark values={series.map(row => row.prompts)} /> },
    tokens: { value: fieldTokens(totals.tokens.total), text: fieldTokens(totals.tokens.total), note: t`input + output` },
    where: tokenTotal > 0
      ? { value: <>{sottoShare}<span className="usage-index__unit"><Trans>in Sotto</Trans></span></>, text: t`${sottoShare} in Sotto`,
        note: t`of tokens · ${sottoPromptShare} of prompts`,
        viz: <span className="usage-mini-split" aria-hidden="true"><i className="usage-where--sotto" style={{ flexGrow: summary.sottoTokens }} /><i className="usage-where--outside" style={{ flexGrow: Math.max(0, tokenTotal - summary.sottoTokens) }} /></span> }
      : { value: '—', text: '—', note: t`No tokens in this range` },
    cache: { value: summary.cacheShare === undefined ? '—' : pct(summary.cacheShare), text: summary.cacheShare === undefined ? '—' : pct(summary.cacheShare), note: t`of input tokens` },
    models: {
      value: topModel === undefined ? '—' : page.modelName(topModel), text: topModel === undefined ? '—' : page.modelName(topModel), words: true,
      note: summary.modelsTruncated ? t`Ranking is incomplete` : topModel !== undefined ? t`${topShare} of prompts` : prompts > 0 ? t`Not matched for these prompts` : t`No prompts yet`,
    },
    rhythm: { value: busiest === undefined ? '—' : `${WEEKDAYS_SHORT[busiest.weekday]} ${hourLabel(busiest.hour)}`, text: busiest === undefined ? '—' : `${WEEKDAYS_SHORT[busiest.weekday]} ${hourLabel(busiest.hour)}`, note: t`when you send the most`, words: true },
  }

  const selected = hover ?? pin
  const day = selected !== null && series?.some(row => row.day === selected) ? selected : null
  const split = chartChoice.show !== 'total'
  /** The Per day block, or why there is none: the controls appear only when there are days to draw. */
  const perDay = (metric: 'prompts' | 'tokens', when?: ReactNode): ReactNode => series === null
    ? <p className="usage-none tt-paragraph"><Trans>Choose a range of a year or less to see each day. The totals still cover the whole range.</Trans></p>
    : series.length === 0 ? <p className="usage-none tt-paragraph"><Trans>No dated activity in this range.</Trans></p>
      : <PerDay page={page} metric={metric} rows={series} choice={chartChoice} onChoose={setChartChoice} selected={day} hover={hover} pin={pin} setHover={setHover} setPin={setPin}>{when}</PerDay>
  const head = (title: string, right: ReactNode = page.rangeLabel): ReactNode => <div className="usage-stage__head"><h2>{title}</h2>{typeof right === 'string' ? <span>{right}</span> : right}</div>
  const placesNote = page.withoutPlacesNote === null ? null : <p className="usage-note tt-paragraph">{page.withoutPlacesNote}</p>

  let stage: ReactNode
  switch (focus) {
    case 'room':
      stage = <>
        {head(t`Room left`, <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('subscriptions')}><Trans>Subscriptions</Trans></button>)}
        <p className="usage-when tt-paragraph"><Trans>Account-wide, as each provider reports it.</Trans></p>
        {limits.length === 0 ? <p className="usage-none tt-paragraph"><Trans>No subscription readings on the selected computers.</Trans></p> : <div className="usage-rings">{limits.map(item => <RingCard key={item.providerId} limits={item} page={page} />)}</div>}
      </>
      break
    case 'tokens': {
      const devin = summary.providers.filter(row => NO_TOKENS.has(row.providerId) && row.prompts.total > 0)
      const subAgentTokens = fmtTok(summary.subAgentTokens)
      const devinPrompts = devin.reduce((sum, row) => sum + row.prompts.total, 0)
      const devinShown = fmtInt(devinPrompts)
      const perPrompt = prompts > 0 ? fmtTok(tokenTotal / prompts) : ''
      stage = <>
        {head(t`Tokens`)}
        {totals.tokens.input.value === undefined && totals.tokens.output.value === undefined
          ? <p className="usage-none tt-paragraph">{devin.length > 0 ? t`Devin doesn't report tokens. Prompts are still counted.` : t`No tokens in this range.`}</p>
          : <TokenBar tokens={totals.tokens} large>
            {page.placesKnown ? <p className="usage-note tt-paragraph"><Trans>Subagents: <b>{subAgentTokens}</b> of these tokens.</Trans></p> : null}
            {devin.length > 0 ? <p className="usage-note tt-paragraph"><Trans>Devin doesn't report tokens, so its <b>{devinShown}</b> <Plural value={devinPrompts} one="prompt" other="prompts" /> aren't in these totals.</Trans></p> : null}
          </TokenBar>}
        {(() => {
          const when = <p className="usage-when tt-paragraph">{day !== null ? (() => {
            const row = series!.find(item => item.day === day)!
            const all = fmtTok(row.input + row.output), input = fmtTok(row.input), output = fmtTok(row.output)
            const counted = split
              ? row.tokensPartial ? t`at least ${all} tokens in all` : t`${all} tokens in all`
              : row.tokensPartial ? t`at least ${input} input, ${output} output` : t`${input} input, ${output} output`
            return <><b>{longDay(day, page.today)}</b> · {!row.tokensKnown ? t`tokens not reported` : row.input + row.output > 0 || row.tokensPartial
              ? counted : t`no tokens`}</>
          })() : prompts > 0 && tokenTotal > 0 ? totals.tokens.total.partial
            ? <Trans>At least <b>{perPrompt}</b> tokens per prompt</Trans>
            : <Trans>About <b>{perPrompt}</b> tokens per prompt</Trans> : null}</p>
          return series === null || series.length === 0
            ? <div className="usage-stage__sub"><div className="usage-chart-head"><h3><Trans>Per day</Trans></h3></div>{when}{perDay('tokens')}</div>
            : perDay('tokens', when)
        })()}
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
        {head(t`Where you work`)}
        <p className="usage-when tt-paragraph">{tokenTotal > 0 ? <Trans><b>{sottoShare}</b> of tokens and <b>{sottoPromptShare}</b> of prompts were in Sotto.</Trans> : t`No tokens in this range.`}</p>
        {places.length === 0 ? <p className="usage-none tt-paragraph"><Trans>Nothing in this range.</Trans></p> : <ol className="usage-shares usage-shares--where">{places.map(place => {
          const placePrompts = fmtInt(place.prompts), wakeUps = fmtInt(place.wakeUps), fromSubagents = fieldTokens(place.subAgentField)
          // The prompts, then each fact that applies, joined as the English list joins them.
          const placePromptCount = place.prompts
          let line = plural(placePromptCount, { one: `${placePrompts} prompt`, other: `${placePrompts} prompts` })
          if (place.wakeUps > 0) line = t({ message: `${line}, ${wakeUps} of them wake-ups`, comment: '{line} is "12 prompts" on the Usage page\'s Where you work' })
          if (place.subAgentTokens > 0) line = t({ message: `${line} · ${fromSubagents} of the tokens from subagents`, comment: '{line} is "12 prompts" or "12 prompts, 3 of them wake-ups"' })
          if (place.subAgent) line = t`No prompts of their own. Your Sotto threads started them.`
          const placeTokens = fieldTokens(place.tokenField)
          return <li key={place.key} className="usage-share">
            <span className="usage-share__name"><ProviderMarks providers={marks(place)} /><span>{place.name}</span></span>
            <span className="usage-share__value">{fieldShare(place.tokenField, totals.tokens.total) ?? <Dash />}<small>{t`${placeTokens} tokens`}</small></span>
            <span className="usage-share__bar"><i className={`usage-grow${place.inSotto ? '' : ' usage-share__fill--outside'}`} style={{ '--usage-w': (place.tokens / top).toFixed(3) } as React.CSSProperties} /></span>
            <span className="usage-share__note">{line}</span>
          </li>
        })}</ol>}
        <p className="usage-legend usage-legend--below"><span><i className="usage-where--sotto" /><Trans>In Sotto</Trans></span><span><i className="usage-where--outside" /><Trans>Outside Sotto</Trans></span></p>
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
      const unshared = USAGE_TOKEN_FIELDS.every(name => totals.tokens[name].value === undefined) ? t`No token counts in this range.`
        : input.value === undefined ? t`Input tokens weren't reported in this range, so the share from cache can't be worked out.`
          : input.value === 0 && !input.partial ? t`No input tokens in this range, so none came from cache.`
            : t`Some token counts in this range weren't reported in full, so the share from cache can't be worked out.`
      const cachedTokens = fieldTokens(totals.tokens.cached), inputTokens = fieldTokens(totals.tokens.input)
      stage = summary.cacheShare === undefined ? <>{head(t`Cache reads`)}<p className="usage-none tt-paragraph">{unshared}</p></> : <>
        {head(t`Cache reads`)}
        <div className="usage-cache">
          <div className="usage-ring-figure usage-ring-figure--large"><Ring size={156} parts={[{ left: summary.cacheShare * 100, width: 10, inset: 0 }]} lowAware={false} /><span><b>{pct(summary.cacheShare)}</b><small><Trans>of input</Trans></small></span></div>
          <div>
            <p className="usage-lead tt-paragraph"><Trans>{cachedTokens} of {inputTokens} input tokens were read from cache. They count as input, not on top of it.</Trans></p>
            <ol className="usage-shares">{shown.map(row => {
              const fraction = fieldValue(row.tokens.cached) / fieldValue(row.tokens.input)
              const rowInput = fieldTokens(row.tokens.input)
              return <li key={`${row.providerId}:${row.modelId}`} className="usage-share">
                <span className="usage-share__name"><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={14} /><span>{page.modelName(row)}</span></span>
                <span className="usage-share__value">{pct(fraction)}<small>{t`${rowInput} input`}</small></span>
                <span className="usage-share__bar"><i className="usage-grow" style={{ '--usage-w': fraction.toFixed(3) } as React.CSSProperties} /></span>
              </li>
            })}</ol>
            {rest > 0 ? <p className="usage-more-line tt-paragraph"><Trans>{rest} more in <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('models')}>Models</button></Trans></p> : null}
          </div>
        </div>
      </>
      break
    }
    case 'models': {
      const ranked = summary.models.filter(row => row.prompts.total > 0)
      const top = Math.max(1, ranked[0]?.prompts.total ?? 1)
      const shown = ranked.slice(0, 8)
      const more = ranked.length - shown.length
      stage = <>
        {head(t`Models`, <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('models')}><Trans>All model details</Trans></button>)}
        {shown.length === 0 || prompts === 0 ? <p className="usage-none tt-paragraph"><Trans>No prompts in this range.</Trans></p> : <ol className="usage-shares">{shown.map(row => {
          const tokens = fieldValue(row.tokens.total)
          const rowTokens = fieldTokens(row.tokens.total), rowCache = cacheShare(row.tokens) ?? t`an unreported share`
          const detail = NO_TOKENS.has(row.providerId) || row.tokens.total.value === undefined ? t`Tokens not reported` : tokens > 0 ? t`${rowTokens} tokens · ${rowCache} from cache` : t`No tokens of its own`
          const sessions = fmtInt(row.activeThreads), activeThreads = row.activeThreads
          return <li key={`${row.providerId}:${row.modelId}`} className="usage-share">
            <span className="usage-share__name"><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={14} /><span>{page.modelName(row)}</span></span>
            <span className="usage-share__value">{share(row.prompts.total, prompts)}<small>{fmtInt(row.prompts.total)}</small></span>
            <span className="usage-share__bar"><i className="usage-grow" style={{ '--usage-w': (row.prompts.total / top).toFixed(3) } as React.CSSProperties} /></span>
            <span className="usage-share__note">{plural(activeThreads, { one: `${detail} · ${sessions} provider session`, other: `${detail} · ${sessions} provider sessions` })}</span>
          </li>
        })}</ol>}
        {ranked.length > shown.length ? <p className="usage-more-line tt-paragraph"><Trans>{more} more in <button type="button" className="usage-link tt-focusable" onClick={() => page.openTab('models')}>Models</button></Trans></p> : null}
      </>
      break
    }
    case 'rhythm': {
      const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
      for (const row of summary.hourly) { const day = grid[row.weekday]!; day[row.hour] = (day[row.hour] ?? 0) + row.prompts.user }
      /** "Mondays, 9 AM to 10 AM". */
      const hours = (weekday: number, hour: number): string => {
        const days = WEEKDAYS_PLURAL[weekday], from = hourLabel(hour), to = hourLabel(hour + 1)
        return t`${days}, ${from} to ${to}`
      }
      let when: ReactNode = t`No prompts in this range.`
      if (cell !== null) {
        const count = grid[cell.weekday]![cell.hour]!, shown = fmtInt(count)
        when = <><b>{hours(cell.weekday, cell.hour)}</b> · {plural(count, { one: `${shown} prompt in this range`, other: `${shown} prompts in this range` })}</>
      } else if (busiest !== undefined) {
        const busiestDays = WEEKDAYS_PLURAL[busiest.weekday], busiestHour = hourLabel(busiest.hour), shown = fmtInt(busiest.prompts.user)
        const busiestCount = busiest.prompts.user
        const busiestPrompts = plural(busiestCount, { one: `${shown} prompt`, other: `${shown} prompts` })
        when = <Trans>Busiest: <b>{busiestDays} around {busiestHour}</b>, {busiestPrompts} in this range</Trans>
      }
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
        const count = grid[weekday]![hour]!, range = hours(weekday, hour), shown = fmtInt(count)
        page.announce(plural(count, { one: `${range}: ${shown} prompt`, other: `${range}: ${shown} prompts` }))
      }
      stage = <>
        {head(t`When you work`)}
        <p className="usage-when tt-paragraph">{when}</p>
        <div onPointerLeave={event => { if (document.activeElement !== event.currentTarget.firstElementChild) setCell(null) }}>
          <HourGrid grid={grid} cell={cell} onCell={setCell} onKey={onKey} label={t`Prompts you sent, by weekday and hour. Use the arrow keys to read one hour.`} />
        </div>
      </>
      break
    }
    default: {
      const byProvider = summary.providers.filter(row => row.prompts.total > 0)
      const clients = sentFrom(summary.clients)
      const peak = series?.reduce<DayValue | undefined>((best, row) => best === undefined || row.prompts > best.prompts ? row : best, undefined)
      const when = day !== null ? (() => {
        const row = series!.find(item => item.day === day)!, shown = fmtInt(row.prompts), dayPrompts = row.prompts
        return <><b>{longDay(day, page.today)}</b> · {split
          ? plural(dayPrompts, { one: `${shown} prompt in all`, other: `${shown} prompts in all` })
          : plural(dayPrompts, { one: `${shown} prompt`, other: `${shown} prompts` })}</>
      })()
        : peak !== undefined && peak.prompts > 0 ? (() => {
          const average = fmtInt(prompts / series!.length), peakDay = shortDay(peak.day), peakCount = fmtInt(peak.prompts)
          return <>{prompts / series!.length < 0.5 ? <Trans>Under <b>1</b> a day</Trans> : <Trans>About <b>{average}</b> a day</Trans>} · <Trans>most on {peakDay}, <b>{peakCount}</b></Trans></>
        })() : t`No prompts in this range.`
      const sent = fmtInt(totals.prompts.user), watcher = fmtInt(totals.prompts.watcher), wakeUps = fmtInt(totals.prompts.wakeUp)
      stage = <>
        {head(t`Prompts`)}
        <p className="usage-when tt-paragraph">{when}</p>
        {perDay('prompts')}
        {byProvider.length > 0 ? <div className="usage-split-block"><p className="usage-split-caption"><Trans>By provider</Trans></p><div className="usage-split">{byProvider.map(row => <div key={row.providerId} className="usage-split__item">
          <span><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={14} />{PROVIDER_NAMES[row.providerId]}</span><b>{fmtInt(row.prompts.total)}</b>
        </div>)}</div></div> : null}
        {prompts > 0 ? <div className="usage-split-block"><p className="usage-split-caption"><Trans>Sent from</Trans></p>
          {clients.length > 0 ? <div className="usage-split usage-split--small">{clients.map(row => <div key={row.clientId} className="usage-split__item"><span>{clientName(row.clientId)}</span><b>{fmtInt(row.prompts)}</b></div>)}</div> : null}
          {placesNote}
        </div> : null}
        <p className="usage-origin tt-paragraph"><Trans>You sent <b>{sent}</b>, Watcher <b>{watcher}</b> and wake-ups <b>{wakeUps}</b>.</Trans></p>
      </>
    }
  }

  return <>
    <div className="usage-focus">
      <div ref={list} className="usage-index" role="tablist" aria-label={t`Usage measures`} aria-orientation={orientation}>
        {FOCUS.map((value, index) => {
          const item = items[value]
          const name = i18n._(FOCUS_NAMES[value])
          return <button key={value} type="button" role="tab" id={`${id}-${value}`} className="usage-index__item tt-focusable" aria-selected={focus === value} tabIndex={focus === value ? 0 : -1}
            aria-controls={`${id}-stage`} aria-label={`${name} ${item.text} ${item.note}`}
            onClick={() => choose(value)} onKeyDown={event => onIndexKey(event, index)}>
            <span className="usage-index__label">{name}</span>
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
  const { t } = useLingui()
  const { primary, providerId } = limits
  const windows = primary.windows
  const longest = primary.longest, shortest = primary.shortest
  const parts = windows.length > 0 && longest !== undefined
    ? [{ left: longest.left, width: 8, inset: 0 }, ...(windows.length > 1 && shortest !== undefined ? [{ left: shortest.left, width: 6, inset: 13, inner: true }] : [])]
    : [{ left: undefined, width: 6, inset: 0 }]
  const tightest = primary.tightest
  const rows = windows.length > 0 && longest !== undefined ? [longest, ...(windows.length > 1 && shortest !== undefined ? [shortest] : [])] : []
  const from = midSentence(page.hostName(primary.hostId))
  return <div className="usage-ring-card">
    <div className="usage-ring-figure"><Ring size={116} parts={parts} stale={primary.stale} />
      <span>{tightest !== undefined ? <><b data-low={tightest.left! <= LOW_LEFT || undefined}>{tightest.left}%</b><small><Trans comment="What is left of a subscription's limit, under its percentage">left</Trans></small></> : <b className="usage-dash" aria-hidden="true">—</b>}</span>
    </div>
    <div className="usage-ring-card__name"><ProviderMark provider={providerId} name={PROVIDER_NAMES[providerId]} size={15} />{PROVIDER_NAMES[providerId]}</div>
    <ul className="usage-ring-card__rows">
      {rows.length > 0 ? rows.map((window, index) => <li key={window.id}><i className={`usage-dot${index > 0 ? ' usage-dot--inner' : ''}`} />{window.label} {window.left === undefined ? <Dash /> : <b data-low={window.left <= LOW_LEFT || undefined}>{window.left}%</b>}{window.resetsAt === undefined ? null : ` · ${resetShort(window.resetsAt, page.now, page.timeZone)}`}</li>)
        : <li>{providerId === 'devin' || primary.quota.reason === 'unsupported' ? t`Sotto can't read these limits yet` : t`No reading from ${from}`}</li>}
      {rows.length > 0 ? <li className="usage-ring-card__fresh">{tightest !== undefined ? readAge(primary.observedAt, page.now) : t`Use not reported`}</li> : null}
    </ul>
  </div>
}

/** Room left as small gauges, for pages that have no history to show. */
export function Glance({ page }: { readonly page: UsagePage }): ReactNode {
  const { t } = useLingui()
  if (page.limits.length === 0) return null
  return <section className="usage-glance" aria-label={t`Room left on each subscription`}>{page.limits.map(item => {
    const { primary, providerId } = item
    const name = PROVIDER_NAMES[providerId]
    const tight = primary.tightest, longest = primary.longest
    let sub: ReactNode, label: string
    if (tight !== undefined) {
      const left = tight.left, noun = tight.noun
      let resets = ''
      if (tight.resetsAt !== undefined) resets = resetShort(tight.resetsAt, page.now, page.timeZone)
      sub = <><Trans><b data-low={tight.left! <= LOW_LEFT || undefined}>{left}%</b> left</Trans> · {primary.stale ? readAgePhrase(primary.observedAt, page.now) : tight.resetsAt === undefined ? tight.phrase : t`resets ${resets}`}</>
      if (tight.resetsAt === undefined) label = t`${name}: ${left}% left in the ${noun}`
      else {
        const resetsLong = resetLong(tight.resetsAt, page.now, page.timeZone)
        label = t`${name}: ${left}% left in the ${noun}, resets ${resetsLong}`
      }
    } else if (longest?.resetsAt !== undefined) {
      const resets = resetShort(longest.resetsAt, page.now, page.timeZone), resetsLong = resetLong(longest.resetsAt, page.now, page.timeZone), noun = longest.noun
      sub = t`Use not reported · resets ${resets}`
      label = t`${name}: use not reported, the ${noun} resets ${resetsLong}`
    } else if (providerId === 'devin' || primary.quota.reason === 'unsupported') { sub = t`Can't read limits`; label = t`${name}: limits can't be read yet` }
    else { const from = midSentence(page.hostName(primary.hostId)); sub = t`No reading from ${from}`; label = t`${name}: no reading from ${from}` }
    return <button key={providerId} type="button" className="usage-gauge tt-focusable" aria-label={t`${label}. Open Subscriptions`} onClick={() => page.openProvider(providerId)}>
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
    <p className="tt-paragraph">{detail}</p>
  </div>
}

export function NoHistory({ names }: { readonly names: readonly string[] }): ReactNode {
  const { t } = useLingui()
  const name = joinNames(names)
  const from = joinNames(names.map(midSentence))
  return <EmptyUsage title={t`No history from ${from} yet`} detail={t`${name}'s history appears after its host update.`} />
}

export function About({ page }: { readonly page: UsagePage }): ReactNode {
  const zone = page.timeZone.replace(/_/gu, ' ')
  return <details className="usage-about" onKeyDown={dismissDisclosure}>
    <summary className="tt-focusable"><ChevronRight size={14} aria-hidden="true" /><Trans>About these numbers</Trans></summary>
    <ul>
      <li><Trans>Limits come from each provider and count all use of the account, in Sotto or anywhere else. Two computers' readings are shown side by side, never added. OpenCode doesn't report account limits, so it isn't on Subscriptions.</Trans></li>
      <li><Trans>Activity counts the work on each computer: Sotto threads, the subagents they start, and Claude Code and Codex used outside Sotto. Grok Build, Devin, Muse and OpenCode are counted in Sotto only.</Trans></li>
      <li><Trans>Prompts are what you, Watcher and wake-ups sent. Subagents add tokens but no prompts. A prompt counts under the model that served it.</Trans></li>
      <li><Trans>Total tokens are input plus output. Cache reads and writes are part of input, not extra.</Trans></li>
      <li><Trans>A dash means the provider didn't report that number. It isn't zero. A ≥ means some records left a number out, so the figure is at least that.</Trans></li>
      <li><Trans>Usage keeps only numbers, dates, model names and app names. Deleting a thread or turning History off leaves it as it is; Clear usage removes it.</Trans></li>
      <li><Trans>Dates and hours use this computer's time zone, {zone}.</Trans></li>
    </ul>
  </details>
}


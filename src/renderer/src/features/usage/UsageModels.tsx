import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { UsageDailyAggregate, UsageModelAggregate } from '../../../../shared/usageDashboard'
import { ProviderMark } from '../../agents/ProviderMark'
import { roomKeyTarget } from '../../components/AppShell'
import { CompositionBar, Dash, Spark } from './UsageCharts'
import { About, EmptyUsage } from './UsageOverview'
import type { UsagePage } from './usagePage'
import { NO_TOKENS, nounFor, PROVIDER_NAMES, fieldValue, fmtInt, fmtTok, isEmptyActivity, pct, relativeDay, share, sumActivity } from './usagePresentation'

const SORTS = [['prompts', 'Prompts'], ['tokens', 'Tokens'], ['cache', 'Cache']] as const
type Sort = typeof SORTS[number][0]
const keyOf = (row: Pick<UsageModelAggregate, 'providerId' | 'modelId'>): string => `${row.providerId}:${row.modelId}`
const reported = (row: UsageModelAggregate): boolean => !NO_TOKENS.has(row.providerId) && fieldValue(row.tokens.total) > 0
const cacheOf = (row: UsageModelAggregate): number => fieldValue(row.tokens.input) > 0 ? fieldValue(row.tokens.cached) / fieldValue(row.tokens.input) : -1

export function Models({ page }: { readonly page: UsagePage }): ReactNode {
  const [sort, setSort] = useState<Sort>('prompts')
  const [opened, setOpened] = useState<string | null>(null)
  const sorts = useRef<HTMLDivElement>(null)
  const label = useId()
  const { summary } = page
  const rows = [...summary.models]
  const value = (row: UsageModelAggregate): number => sort === 'prompts' ? row.prompts.total : sort === 'tokens' ? (reported(row) ? fieldValue(row.tokens.total) : -1) : (reported(row) ? cacheOf(row) : -1)
  rows.sort((a, b) => value(b) - value(a) || fieldValue(b.tokens.total) - fieldValue(a.tokens.total) || a.modelId.localeCompare(b.modelId))
  const openRow = rows.find(row => keyOf(row) === opened)
  const daily = useModelDaily(page, openRow)
  if (rows.length === 0) {
    return <><EmptyUsage bars={[8, 14, 10, 22, 16]} {...(page.cleared
      ? { title: 'No models recorded yet', detail: 'Models appear here after your next prompt.' }
      : { title: 'No models in this range', detail: 'Try a longer range or another provider.' })} /><About page={page} /></>
  }
  const maximum = Math.max(1, ...rows.filter(reported).map(row => fieldValue(row.tokens.total)))
  const totals = summary.totals
  const tokenTotal = totals.tokens.total.value
  const onSortKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = roomKeyTarget(event.key, index, SORTS.length)
    if (target === null) return
    event.preventDefault(); setSort(SORTS[target]![0])
    sorts.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
  }
  return <>
    <div className="usage-models-head">
      <p className="usage-models-summary"><b>{fmtInt(rows.length)}</b> model{rows.length === 1 ? '' : 's'} · <b>{fmtInt(totals.prompts.total)}</b> {nounFor(totals.prompts.total, 'prompt')} · <b>{tokenTotal === undefined ? '—' : fmtTok(tokenTotal)}</b> tokens · {page.rangeLabel}</p>
      <div className="usage-sort"><span id={label}>Sort by</span>
        <div ref={sorts} className="usage-seg usage-seg--small" role="radiogroup" aria-labelledby={label}>{SORTS.map(([key, name], index) => <button key={key} type="button" role="radio" className="tt-focusable"
          aria-checked={sort === key} tabIndex={sort === key ? 0 : -1} onClick={() => setSort(key)} onKeyDown={event => onSortKey(event, index)}>{name}</button>)}</div>
      </div>
    </div>
    {summary.modelsTruncated ? <p className="usage-note">Some computers have more models than one read returns. The table shows the models returned; the totals still count every model.</p> : null}
    <div className="usage-table">
      <div className="usage-table__columns" aria-hidden="true"><span>Model</span><span>Tokens by kind</span><span>Prompts</span><span>Tokens</span><span>From cache</span></div>
      <ul className="usage-table__rows">{rows.map(row => {
        const key = keyOf(row)
        const open = opened === key
        const name = page.modelName(row)
        const has = reported(row)
        const detail = `usage-model-${key.replace(/[^a-z0-9]+/giu, '-')}`
        const words = `${name}, ${PROVIDER_NAMES[row.providerId]}: ${fmtInt(row.prompts.total)} ${nounFor(row.prompts.total, 'prompt')}${has ? `, ${fmtTok(fieldValue(row.tokens.total))} tokens, ${share(fieldValue(row.tokens.cached), fieldValue(row.tokens.input))} from cache` : ', tokens not reported'}`
        return <li key={key} className="usage-row" data-open={open || undefined} onKeyDown={event => {
          if (event.key !== 'Escape' || !open) return
          event.preventDefault(); event.stopPropagation(); setOpened(null)
          event.currentTarget.querySelector<HTMLButtonElement>('.usage-row__main')?.focus()
        }}>
          <button type="button" className="usage-row__main tt-focusable" aria-expanded={open} aria-controls={open ? detail : undefined} aria-label={words} onClick={() => setOpened(open ? null : key)}>
            <span className="usage-row__name"><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={18} /><span><span className="usage-row__model" title={name}>{name}</span><span className="usage-row__provider">{PROVIDER_NAMES[row.providerId]}</span></span></span>
            <span className="usage-row__bar"><CompositionBar tokens={row.tokens} maximum={maximum} reported={has} /></span>
            <span className="usage-row__n">{fmtInt(row.prompts.total)}</span>
            <span className="usage-row__n">{has ? fmtTok(fieldValue(row.tokens.total)) : <Dash />}</span>
            <span className="usage-row__n usage-row__cache">{has ? share(fieldValue(row.tokens.cached), fieldValue(row.tokens.input)) : <Dash />}</span>
          </button>
          {open ? <ModelDetail id={detail} row={row} page={page} daily={daily} /> : null}
        </li>
      })}</ul>
      <div className="usage-table__total"><span>All models</span><span className="usage-row__bar" /><span className="usage-row__n">{fmtInt(totals.prompts.total)}</span>
        <span className="usage-row__n">{tokenTotal === undefined ? <Dash /> : fmtTok(tokenTotal)}</span><span className="usage-row__n usage-row__cache">{summary.cacheShare === undefined ? <Dash /> : pct(summary.cacheShare)}</span></div>
    </div>
    <p className="usage-legend usage-legend--table"><span><i className="usage-kind--read" />Cache read</span><span><i className="usage-kind--write" />Cache write</span><span><i className="usage-kind--new" />Uncached input</span><span><i className="usage-kind--out" />Output</span><span>— not reported</span></p>
    <About page={page} />
  </>
}

/** The open model's days, from a read for that model alone across the chosen computers. */
function useModelDaily(page: UsagePage, row: UsageModelAggregate | undefined): UsageDailyAggregate[] | undefined {
  const [found, setFound] = useState<{ key: string; daily: UsageDailyAggregate[] } | undefined>(undefined)
  const { bridge, query, hostIds } = page
  const key = row === undefined ? null : JSON.stringify([keyOf(row), query, hostIds])
  useEffect(() => {
    if (bridge === undefined || row === undefined || key === null) return
    let current = true
    bridge.read({ ...query, includeDaily: true, providerIds: [row.providerId], modelIds: [row.modelId], ...(hostIds.length > 0 ? { hostIds: [...hostIds] } : {}) }).then(result => {
      if (!current) return
      const rows = result.hosts.flatMap(host => host.status === 'ready' ? host.activity?.daily ?? [] : [])
      const days = new Map<string, UsageDailyAggregate[]>()
      for (const item of rows) days.set(item.day, [...(days.get(item.day) ?? []), item])
      setFound({ key, daily: [...days.entries()].map(([day, items]) => ({ ...sumActivity(items), day })).sort((a, b) => a.day.localeCompare(b.day)) })
    }, () => undefined)
    return () => { current = false }
    // The row object changes on every read; its key says when the question changed.
  }, [bridge, key])
  return found !== undefined && found.key === key ? found.daily : undefined
}

function ModelDetail({ id, row, page, daily }: { readonly id: string; readonly row: UsageModelAggregate; readonly page: UsagePage; readonly daily: UsageDailyAggregate[] | undefined }): ReactNode {
  const has = reported(row)
  const prompts = row.prompts.total
  const byDay = new Map((daily ?? []).map(item => [item.day, item]))
  const usePrompts = prompts > 0
  const values = page.days.map(day => { const item = byDay.get(day); return item === undefined ? 0 : usePrompts ? item.prompts.total : fieldValue(item.tokens.total) })
  const daysUsed = daily === undefined ? row.activeDays : daily.filter(item => !isEmptyActivity(item)).length
  const last = row.lastDay ?? daily?.filter(item => !isEmptyActivity(item)).at(-1)?.day
  const tokens = (field: keyof UsageModelAggregate['tokens']): ReactNode => !has || row.tokens[field].value === undefined ? <Dash /> : <>{row.tokens[field].partial ? '≥ ' : ''}{fmtTok(row.tokens[field].value!)}</>
  const notes: string[] = []
  if (row.modelId === 'unknown') notes.push("This work wasn't matched to a model.")
  if (NO_TOKENS.has(row.providerId)) notes.push(`${PROVIDER_NAMES[row.providerId]} doesn't report tokens.`)
  if (prompts === 0 && has) notes.push('Subagent and review work: tokens, but no prompts of its own.')
  const fact = (label: string, value: ReactNode): ReactNode => <div><dt>{label}</dt><dd>{value}</dd></div>
  return <div className="usage-detail" id={id}>
    <dl className="usage-detail__facts">
      {fact('Input', tokens('input'))}{fact('Cache read', tokens('cached'))}{fact('Cache write', tokens('cacheWrite'))}{fact('Output', tokens('output'))}
      {fact('Tokens per prompt', has && prompts > 0 ? fmtTok(fieldValue(row.tokens.total) / prompts) : <Dash />)}
      {fact('Provider sessions', fmtInt(row.activeThreads))}{fact('Days used', fmtInt(daysUsed))}{fact('Last used', last === undefined ? <Dash /> : relativeDay(last, page.today))}
    </dl>
    <div className="usage-detail__spark">{daily === undefined ? <span className="usage-detail__wait" aria-hidden="true" /> : <Spark values={values} width={220} height={40} />}<p>{usePrompts ? 'Prompts' : 'Tokens'} per day</p></div>
    {notes.length > 0 ? <p className="usage-detail__note">{notes.join(' ')}</p> : null}
  </div>
}

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import type { ProviderId } from '../../../../shared/agents'
import type { UsageBridge, UsageDashboardRead, UsageModelAggregate, UsageQuery } from '../../../../shared/usageDashboard'
import { USAGE_MODEL_ROWS_MAX } from '../../../../shared/usageDashboard'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ProviderMark } from '../../agents/ProviderMark'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { roomKeyTarget } from '../../components/AppShell'
import { DailyChart, HourlyChart, Ring, TokenBreakdown, WEEKDAYS, dismissDisclosure, hourLabel } from './UsageCharts'
import { UsageSubscriptions, quotaWindows } from './UsageSubscriptions'
import { PROVIDER_NAMES, calendarDay, formatCompact, formatCount, formatField, presentUsage, rangeBounds, usageModelName } from './usagePresentation'
import './usage.css'

const TABS = ['overview', 'subscriptions', 'models'] as const
const FOCUS = ['room', 'prompts', 'tokens', 'cache', 'models', 'rhythm'] as const
type Tab = typeof TABS[number]
type Focus = typeof FOCUS[number]
const TAB_NAMES: Record<Tab, string> = { overview: 'Overview', subscriptions: 'Subscriptions', models: 'Models' }
const FOCUS_NAMES: Record<Focus, string> = { room: 'Room left', prompts: 'Prompts', tokens: 'Tokens', cache: 'From cache', models: 'Most used model', rhythm: 'Busiest hour' }
const EMPTY: UsageDashboardRead = { hosts: [] }
const QUOTA_FRESH_MS = 60_000
const currentDate = (): Date => new Date()

export interface UsageViewProps {
  readonly bridge?: UsageBridge | undefined
  readonly computers?: ReadonlyArray<{ hostId: string; name: string }> | undefined
  readonly now?: (() => Date) | undefined
  readonly timeZone?: string | undefined
}

export function UsageView({ bridge = window.sotto?.usage, computers, now = currentDate, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }: UsageViewProps): ReactNode {
  const agents = useOptionalAgents()
  const names = computers ?? agents?.state?.connections ?? []
  const [tab, setTab] = useState<Tab>('overview')
  const [focus, setFocus] = useState<Focus>('prompts')
  const [range, setRange] = useState('30')
  const [hostId, setHostId] = useState('all')
  const [providerId, setProviderId] = useState('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [today, setToday] = useState(() => calendarDay(now(), timeZone))
  const [read, setRead] = useState<UsageDashboardRead | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [clearRead, setClearRead] = useState<UsageDashboardRead | null>(null)
  const clearButton = useRef<HTMLButtonElement>(null)
  const page = useRef<HTMLElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const [indexOrientation, setIndexOrientation] = useState<'horizontal' | 'vertical'>('vertical')
  const generation = useRef(0)
  const mounted = useRef(true)
  const refreshedOnOpen = useRef<UsageBridge | undefined>(undefined)
  const id = useId()
  const query = useMemo<UsageQuery>(() => ({
    timeZone, includeDaily: true,
    ...(range !== 'all' && range !== 'custom' ? rangeBounds(Number(range), now(), timeZone) : {}),
    ...(range === 'custom' && customFrom !== '' ? { from: customFrom } : {}),
    ...(range === 'custom' && customTo !== '' ? { to: customTo } : {}),
    ...(hostId !== 'all' ? { hostIds: [hostId] } : {}),
    ...(providerId !== 'all' ? { providerIds: [providerId as ProviderId] } : {}),
  }), [range, hostId, providerId, customFrom, customTo, timeZone, now, today])
  const queryRef = useRef(query)
  queryRef.current = query
  const invalidRange = query.from !== undefined && query.to !== undefined && query.from > query.to
  const load = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    if (bridge === undefined) { setLoading(false); setFailure('Usage is not available in this build.'); return }
    if (invalidRange) { setLoading(false); return }
    setLoading(true)
    try {
      const result = await bridge.read(query)
      if (mounted.current && request === generation.current) { setRead(result); setFailure(null) }
    } catch {
      if (mounted.current && request === generation.current) setFailure('Usage could not be read. Your saved figures were not changed. Try again.')
    } finally { if (mounted.current && request === generation.current) setLoading(false) }
  }, [bridge, query, invalidRange])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current } }, [])
  useLayoutEffect(() => {
    const element = page.current
    if (element === null) return
    const measure = (): void => { const width = element.getBoundingClientRect().width; if (width > 0) setIndexOrientation(width <= 900 ? 'horizontal' : 'vertical') }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])
  useEffect(() => { setRead(null); void load() }, [load])
  // Reuse recent native metadata across page opens. The button still asks for a fresh reading.
  useEffect(() => {
    if (bridge === undefined || read === null || refreshedOnOpen.current === bridge) return
    refreshedOnOpen.current = bridge
    const stamp = now().getTime()
    const requests = read.hosts.filter(host => host.status === 'ready').map(host => ({
      hostIds: [host.hostId],
      providerIds: host.quotas.filter(quota => {
        if (!quota.refreshable) return false
        const observed = Date.parse(quota.observedAt ?? '')
        return !Number.isFinite(observed) || Math.abs(stamp - observed) >= QUOTA_FRESH_MS
      }).map(quota => quota.providerId),
    })).filter(request => request.providerIds.length > 0)
    if (requests.length === 0) return
    let current = true
    void Promise.all(requests.map(request => bridge.refresh(request))).then(() => { if (current) void loadRef.current() }).catch(() => {
      if (current) setNotice('Subscription limits could not be refreshed. Saved activity is still available.')
    })
    return () => { current = false }
  }, [bridge, read, now])
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden' || clearRead !== null) return
      const currentDay = calendarDay(now(), timeZone)
      if (currentDay !== today) setToday(currentDay)
      else void loadRef.current()
    }, 30_000)
    return () => clearInterval(interval)
  }, [clearRead, now, timeZone, today])

  const data = read ?? EMPTY
  const summary = useMemo(() => presentUsage(data), [data])
  const clock = now().getTime()
  const availableHosts = read?.hosts.filter(host => host.activity !== undefined && host.status === 'ready') ?? []
  const hostName = (value: string): string => names.find(item => item.hostId === value)?.name ?? (value === agents?.state?.hostId ? 'This computer' : `Computer ${Math.max(1, data.hosts.findIndex(host => host.hostId === value) + 1)}`)
  const modelName = (row: UsageModelAggregate): string => {
    const owners = data.hosts.filter(host => host.activity?.models.some(item => item.modelId === row.modelId && item.providerId === row.providerId))
    const catalog = owners.flatMap(host => agents?.state?.host.clientHosts?.find(item => item.hostId === host.hostId)?.models ?? (host.hostId === agents?.state?.hostId || host.hostId === agents?.state?.host.hostId ? agents?.state?.host.models ?? [] : []))
    return usageModelName(row.modelId, row.providerId, catalog)
  }
  const computerList = [...new Map([...names.map(item => [item.hostId, item.name] as const), ...data.hosts.map(host => [host.hostId, hostName(host.hostId)] as const)]).entries()]
  const windows = quotaWindows(data, clock).filter(item => item.left !== undefined && item.quota.status === 'available')
  const lowest = windows.sort((a, b) => a.left! - b.left!)[0]
  const model = summary.modelsTruncated ? undefined : summary.models.find(row => row.prompts.user > 0)
  const metricValues: Record<Focus, string> = {
    room: lowest === undefined ? '—' : `${Math.round(lowest.left!)}%`, prompts: availableHosts.length === 0 ? '—' : formatCompact(summary.totals.prompts.user),
    tokens: formatField(summary.totals.tokens.total, true), cache: summary.cacheShare === undefined ? '—' : `${Math.round(summary.cacheShare * 100)}%`,
    models: model === undefined ? '—' : modelName(model), rhythm: summary.busiest === undefined ? '—' : `${WEEKDAYS[summary.busiest.weekday]} ${hourLabel(summary.busiest.hour)}`,
  }
  const metricNotes: Record<Focus, string> = {
    room: lowest === undefined ? 'No current percentage read' : `${PROVIDER_NAMES[lowest.quota.providerId]} · ${hostName(lowest.hostId)}`,
    prompts: 'accepted prompts from you', tokens: 'input + output', cache: 'of reported input tokens',
    models: summary.modelsTruncated ? 'Ranking is incomplete' : model === undefined ? 'No prompts recorded yet' : `${formatCount(model.prompts.user)} ${model.prompts.user === 1 ? 'prompt' : 'prompts'} at send`, rhythm: 'when you send the most',
  }

  const selectByKey = <T extends string>(event: KeyboardEvent<HTMLButtonElement>, values: readonly T[], index: number, select: (value: T) => void): void => {
    const target = roomKeyTarget(event.key, index, values.length)
    if (target === null) return
    event.preventDefault(); select(values[target]!)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus()
  }
  const revealMeasure = (button: HTMLButtonElement): void => {
    const strip = button.parentElement
    if (strip !== null && strip.scrollWidth > strip.clientWidth) button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }
  const openTab = (value: Tab): void => { setTab(value); tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[TABS.indexOf(value)]?.focus() }
  const refresh = async (): Promise<void> => {
    if (bridge === undefined || refreshing) return
    setRefreshing(true); setNotice(null)
    try {
      await bridge.refresh({ ...(queryRef.current.hostIds === undefined ? {} : { hostIds: queryRef.current.hostIds }), ...(queryRef.current.providerIds === undefined ? {} : { providerIds: queryRef.current.providerIds }) })
      if (mounted.current) await loadRef.current()
    } catch { if (mounted.current) setNotice('Subscription limits could not be refreshed. Saved activity is still available.') }
    finally { if (mounted.current) setRefreshing(false) }
  }
  const clear = async (): Promise<boolean> => {
    if (bridge === undefined || clearRead === null) return false
    const hosts = clearRead.hosts.flatMap(host => host.status === 'ready' && host.activity !== undefined ? [{ hostId: host.hostId, expectedRevision: host.activity.metadata.revision }] : [])
    try {
      const result = await bridge.clear({ hosts })
      if (!mounted.current) return true
      const complete = result.length === hosts.length && hosts.every(host => result.filter(item => item.hostId === host.hostId && item.status === 'cleared').length === 1)
      if (!complete) {
        setClearRead(null)
        const prefix = result.some(item => item.status === 'cleared') ? 'Some usage figures were cleared. ' : ''
        setNotice(`${prefix}${result.some(item => item.status === 'stale') ? 'Usage changed while the question was open. Review the current figures, then choose Clear usage again.' : 'Some computers could not confirm that usage was cleared. Review the current figures before trying again.'}`)
        await loadRef.current()
        return true
      }
      setNotice('Saved usage figures were cleared on the selected computers.'); await loadRef.current(); return true
    } catch { return false }
  }

  const chart = (metric: 'prompts' | 'tokens'): ReactNode => availableHosts.length === 0 ? <p className="usage-note">Activity could not be read from the selected computers.</p> : <DailyChart key={`${metric}:${JSON.stringify(query)}`} rows={summary.daily} metric={metric} complete={summary.dailyComplete} from={query.from} to={query.to} />
  let stage: ReactNode
  switch (focus) {
    case 'room': stage = <><div className="usage-stage__head"><h2>Room left</h2><button className="usage-link tt-focusable" onClick={() => openTab('subscriptions')}>Subscriptions</button></div><p className="usage-note">Account-wide, as each provider reports it. Computers may share the same account.</p><UsageSubscriptions read={data} hostName={hostName} now={clock} compact /></>; break
    case 'tokens': stage = <><h2>Tokens</h2><TokenBreakdown tokens={summary.totals.tokens} /><h3 className="usage-subhead">Per day</h3>{chart('tokens')}</>; break
    case 'cache': stage = <><h2>Cache reads</h2><div className="usage-cache"><div className="usage-cache__ring"><Ring percent={summary.cacheShare === undefined ? undefined : summary.cacheShare * 100} size={156} /><span><b>{metricValues.cache}</b><small>of input</small></span></div><div><p className="usage-note">{formatField(summary.totals.tokens.cached)} of {formatField(summary.totals.tokens.input)} input tokens were read from cache. They count as input.</p><ModelRanking modelName={modelName} rows={summary.models.filter(row => row.tokens.cached.value !== undefined && row.tokens.input.value !== undefined && !row.tokens.cached.partial && !row.tokens.input.partial && row.tokens.input.value > 0).sort((a, b) => b.tokens.cached.value! / b.tokens.input.value! - a.tokens.cached.value! / a.tokens.input.value!)} cache /></div></div></>; break
    case 'models': stage = <><div className="usage-stage__head"><h2>Models</h2><button className="usage-link tt-focusable" onClick={() => openTab('models')}>All model details</button></div><ModelRanking modelName={modelName} rows={summary.models.slice(0, 8)} /><p className="usage-note">Prompt counts use your model selection at send. Token counts use the model reported by the provider.</p></>; break
    case 'rhythm': stage = <><h2>When you work</h2><HourlyChart rows={summary.hourly} timeZone={timeZone} /></>; break
    default: stage = <><h2>Prompts</h2>{chart('prompts')}<div className="usage-provider-split">{summary.providers.map(row => <div key={row.providerId}><span><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} />{PROVIDER_NAMES[row.providerId]}</span><b>{formatCount(row.prompts.user)}</b></div>)}</div><p className="usage-note">You sent <b>{formatCount(summary.totals.prompts.user)}</b>, Watcher <b>{formatCount(summary.totals.prompts.watcher)}</b> and wake-ups <b>{formatCount(summary.totals.prompts.wakeUp)}</b>. The <b>{formatCount(summary.totals.prompts.steered)}</b> steered prompts are included once. Side calls for titles, branch names and drafts are outside these counts.</p></>
  }

  return <section ref={page} className="usage-view" aria-label="Usage"><div className="usage-scroll">
    <header className="usage-header"><div><h1>Usage</h1><p>Subscriptions and the work you do in Sotto.</p></div><div className="usage-header__actions"><Button variant="ghost" disabled={bridge === undefined || refreshing} onClick={() => void refresh()} aria-label="Refresh subscription limits"><RefreshCw size={15} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh'}</Button><Button ref={clearButton} variant="ghost" iconOnly disabled={availableHosts.length === 0 || loading} onClick={() => { setNotice(null); setClearRead(read) }} aria-label="Clear usage"><Trash2 size={15} aria-hidden="true" /></Button></div></header>
    <div className="usage-controls"><div ref={tabs} className="usage-tabs" role="tablist" aria-label="Usage views">{TABS.map((value, index) => <button key={value} type="button" className="tt-focusable" role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => selectByKey(event, TABS, index, setTab)}>{TAB_NAMES[value]}</button>)}</div><div className="usage-filters">
      <label><span className="tt-visually-hidden">Date range</span><select aria-label="Date range" value={range} onChange={event => setRange(event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="all">All time</option><option value="custom">Choose dates</option></select></label>
      <label><span className="tt-visually-hidden">Computer</span><select aria-label="Computer" value={hostId} onChange={event => setHostId(event.target.value)}><option value="all">All computers</option>{computerList.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label><span className="tt-visually-hidden">Provider</span><select aria-label="Provider" value={providerId} onChange={event => setProviderId(event.target.value)}><option value="all">All providers</option>{Object.entries(PROVIDER_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
    </div></div>
    {range === 'custom' ? <div className="usage-dates"><label>From<input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} /></label><label>Through<input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} /></label></div> : null}
    {invalidRange ? <p className="usage-notice" role="alert">Choose an end date on or after the start date.</p> : null}
    {notice !== null ? <p className="usage-notice" role="status">{notice}</p> : null}
    {failure !== null ? <p className="usage-notice" role="alert">{failure} <button className="usage-link tt-focusable" onClick={() => void load()}>Try again</button></p> : null}
    {data.hosts.some(host => host.persistence === 'failed') ? <p className="usage-notice" role="alert">Some recent usage could not be saved. Provider work continues; repair local storage, then restart Sotto.</p> : null}
    {data.hosts.filter(host => host.status !== 'ready').map(host => <p key={host.hostId} className="usage-notice">{hostName(host.hostId)}: {host.status === 'unsupported' ? 'usage needs an Owl host update.' : host.status === 'offline' ? 'offline. Reconnect to read its saved figures.' : 'usage could not be read. Try again.'}</p>)}
    {loading && read === null ? <p className="usage-empty" role="status">Reading usage…</p> : read !== null && !invalidRange ? <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={loading || undefined}>
      {tab === 'overview' ? <div className="usage-focus"><div className="usage-index" role="tablist" aria-label="Usage measures" aria-orientation={indexOrientation}>{FOCUS.map((value, index) => <button key={value} type="button" role="tab" id={`${id}-focus-${value}`} className="usage-index__item tt-focusable" aria-label={`${FOCUS_NAMES[value]} ${metricValues[value]} ${metricNotes[value]}`} aria-controls={`${id}-stage`} aria-selected={focus === value} tabIndex={focus === value ? 0 : -1} onClick={() => setFocus(value)} onFocus={event => revealMeasure(event.currentTarget)} onKeyDown={event => selectByKey(event, FOCUS, index, setFocus)}><span className="usage-index__label">{FOCUS_NAMES[value]}</span><span className={`usage-index__value${value === 'models' || value === 'rhythm' ? ' usage-index__value--text' : ''}`} title={value === 'models' ? model?.modelId : metricValues[value]}>{metricValues[value]}</span><span className="usage-index__note" title={metricNotes[value]}>{metricNotes[value]}</span></button>)}</div><section className="usage-stage" id={`${id}-stage`} role="tabpanel" aria-labelledby={`${id}-focus-${focus}`}>{stage}</section></div> : tab === 'subscriptions' ? <><p className="usage-note">These are native account limits. They include activity outside Sotto and are shown separately for each computer. Refresh reads supported metadata; Claude Code reports its limits during work.</p><UsageSubscriptions read={data} hostName={hostName} now={clock} /></> : <Models modelName={modelName} rows={summary.models} truncated={summary.modelsTruncated} />}
      <details className="usage-about" onKeyDown={dismissDisclosure}><summary>About these figures</summary><p>Usage keeps numeric counts, dates and model names on each computer. It keeps no prompt or reply text, and survives deleting threads or turning local history off. Clear usage removes these figures separately.</p><p>Prompts count only accepted Sotto messages recorded since tracking began. Tokens come from native provider reports and can include older tracked work. Undated older tokens appear only in All time. Devin tokens and unsupported subscription limits remain unknown.</p><p>{formatCount(summary.totals.tokenRecords)} token records; {formatCount(summary.totals.partialTokenRecords)} partial and {formatCount(summary.totals.undatedTokenRecords)} undated in this range. {formatCount(summary.totals.activeThreads)} active threads across computers. Dates and hours use {timeZone}.</p>{summary.modelsTruncated ? <p>Some computers have more than 200 model rows. Rankings show the rows returned; overall totals still include every model.</p> : null}</details>
      {summary.totals.prompts.total === 0 && summary.totals.tokenRecords === 0 && tab !== 'subscriptions' ? <p className="usage-note">No recorded activity in this range. New accepted prompts will appear here as you work.</p> : null}
    </div> : null}
  </div>{clearRead !== null ? <ConfirmationDialog title="Clear saved usage?" description={<><p>Remove numeric usage figures from {clearRead.hosts.filter(host => host.status === 'ready' && host.activity !== undefined).map(host => hostName(host.hostId)).join(', ')}?</p><p>This clears all dates, providers and models on those computers, including figures outside the current filters. Subscription limits and thread history stay as they are.</p><p>Already-running and cleared turns will not refill these figures. New turns count afterward.</p></>} confirmLabel="Clear saved usage" cancelLabel="Keep usage" onConfirm={clear} onCancel={() => setClearRead(null)} failureMessage="Usage could not be cleared. Your saved figures may remain. Try again." fallbackFocusRef={clearButton} /> : null}</section>
}

function ModelRanking({ rows, modelName, cache = false }: { readonly rows: UsageModelAggregate[]; readonly modelName: (row: UsageModelAggregate) => string; readonly cache?: boolean }): ReactNode {
  const ranked = cache ? rows : rows.filter(row => row.prompts.user > 0)
  const maximum = Math.max(1, ...ranked.map(row => row.prompts.user))
  if (ranked.length === 0) return <p className="usage-note">No model counts in this range.</p>
  return <ol className="usage-ranking">{ranked.slice(0, 8).map(row => {
    const share = cache ? row.tokens.cached.value! / row.tokens.input.value! : row.prompts.user / maximum
    return <li key={`${row.providerId}:${row.modelId}`}><span><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} /><span title={row.modelId}>{modelName(row)}<small>{PROVIDER_NAMES[row.providerId]}</small></span></span><b>{cache ? `${Math.round(share * 100)}%` : formatCount(row.prompts.user)}</b><i aria-hidden="true"><i style={{ width: `${Math.min(1, share) * 100}%` }} /></i></li>
  })}</ol>
}

function Models({ rows, modelName, truncated }: { readonly rows: UsageModelAggregate[]; readonly modelName: (row: UsageModelAggregate) => string; readonly truncated: boolean }): ReactNode {
  const [sort, setSort] = useState('prompts')
  const [opened, setOpened] = useState<string | null>(null)
  const sorted = [...rows].sort((a, b) => sort === 'tokens' ? (b.tokens.total.value ?? -1) - (a.tokens.total.value ?? -1) : b.prompts.user - a.prompts.user).slice(0, USAGE_MODEL_ROWS_MAX)
  return <><div className="usage-model-head"><p className="usage-note">Model selected at send for prompts; model reported by the provider for tokens.</p><label>Sort by <select aria-label="Sort models by" value={sort} onChange={event => setSort(event.target.value)}><option value="prompts">Your prompts</option><option value="tokens">Tokens</option></select></label></div>{truncated || rows.length > USAGE_MODEL_ROWS_MAX ? <p className="usage-note">Showing up to 200 model rows. Rankings are limited to returned rows; overall totals include every model.</p> : null}<div className="usage-models"><div className="usage-models__columns" aria-hidden="true"><span>Model</span><span>Your prompts</span><span>Tokens</span></div>{sorted.map(row => {
    const key = JSON.stringify([row.providerId, row.modelId])
    return <section key={key} className="usage-model" data-open={opened === key || undefined} onKeyDown={event => { if (event.key === 'Escape' && opened === key) { event.preventDefault(); setOpened(null); event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus() } }}><button className="usage-model__main tt-focusable" type="button" aria-label={`${opened === key ? 'Hide' : 'Show'} usage for ${modelName(row)} on ${PROVIDER_NAMES[row.providerId]}, ${formatCount(row.prompts.user)} prompts, ${formatField(row.tokens.total)} tokens`} aria-expanded={opened === key} onClick={() => setOpened(opened === key ? null : key)}><span className="usage-model__name"><ProviderMark provider={row.providerId} name={PROVIDER_NAMES[row.providerId]} size={18} /><span title={row.modelId}>{modelName(row)}<small>{PROVIDER_NAMES[row.providerId]}</small></span></span><span>{formatCount(row.prompts.user)}</span><span>{formatField(row.tokens.total, true)}</span></button>{opened === key ? <div className="usage-model__detail"><p className="usage-model__id">Model ID: {row.modelId}</p><TokenBreakdown tokens={row.tokens} /><p className="usage-note">Watcher: {formatCount(row.prompts.watcher)} · Wake-ups: {formatCount(row.prompts.wakeUp)} · Steered: {formatCount(row.prompts.steered)} included in these prompt counts.</p></div> : null}</section>
  })}</div>{rows.length === 0 ? <p className="usage-empty">No models recorded in this range.</p> : null}</>
}

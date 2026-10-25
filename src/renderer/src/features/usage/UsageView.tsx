import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { servedModelName } from '../../../../shared/modelCatalog'
import type { UsageBridge, UsageDashboardRead, UsageHostRead, UsageLimitProviderId, UsageProviderId, UsageQuery, UsageSource } from '../../../../shared/usageDashboard'
import { useOptionalAgents } from '../../agents/AgentContext'
import { roomKeyTarget } from '../../components/AppShell'
import { useHeldProviders } from '../../state/owlFeature'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { ActionMenu, ChoiceMenu, type ChoiceOption } from './UsageMenu'
import { Models } from './UsageModels'
import { EmptyUsage, Glance, NoHistory, Overview } from './UsageOverview'
import { Subscriptions } from './UsageSubscriptions'
import type { UsagePage, UsageTab, UsageWhere } from './usagePage'
import {
  PROVIDER_ACCOUNTS, PROVIDER_NAMES, USAGE_PROVIDERS, addDays, calendarDay, daysBetween, isEmptyActivity, predatesHistory, presentUsage, providerLimits,
  joinNames, midSentence, rangeBounds, rangeLabel, scopeHost,
} from './usagePresentation'
import { EVERY_HOST, useUsageRead } from './useUsageRead'
import './usage.css'

const TABS: readonly UsageTab[] = ['overview', 'subscriptions', 'models']
const TAB_NAMES: Record<UsageTab, string> = { overview: 'Overview', subscriptions: 'Subscriptions', models: 'Models' }
type Range = '7' | '30' | '90' | 'all' | 'custom'
const RANGES: readonly ChoiceOption<Range>[] = [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: 'all', label: 'All time' }, { value: 'custom', label: 'Choose dates' }]
const PLACES: readonly ChoiceOption<UsageWhere>[] = [{ value: 'all', label: 'Everywhere' }, { value: 'sotto', label: 'In Sotto' }, { value: 'outside', label: 'Outside Sotto' }]
const QUOTA_FRESH_MS = 60_000
const DAYS_MAX = 366
const currentDate = (): Date => new Date()

export interface UsageComputer { readonly hostId: string; readonly name: string; readonly kind?: 'local' | 'remote'; readonly connected?: boolean }
export interface UsageViewProps {
  readonly bridge?: UsageBridge | undefined
  readonly computers?: readonly UsageComputer[] | undefined
  readonly now?: (() => Date) | undefined
  readonly timeZone?: string | undefined
}

/** A computer with nothing Usage can show: no Usage on its host, or a host from before history with nothing in it. */
const withoutHistory = (host: UsageHostRead): boolean => host.status === 'unsupported'
  || (host.status === 'ready' && (host.activity === undefined || (predatesHistory(host.activity) && host.activity.metadata.history === undefined && isEmptyActivity(host.activity.totals) && host.activity.metadata.clearedAt === undefined)))


export function UsageView({ bridge = window.sotto?.usage, computers, now = currentDate, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }: UsageViewProps): ReactNode {
  const agents = useOptionalAgents()
  const state = agents?.state
  const connections: readonly UsageComputer[] = computers ?? state?.connections ?? []
  const [tab, setTab] = useState<UsageTab>('overview')
  const [range, setRange] = useState<Range>('30')
  const [hostId, setHostId] = useState('all')
  const [provider, setProvider] = useState<UsageProviderId | 'all'>('all')
  const [where, setWhere] = useState<UsageWhere>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [today, setToday] = useState(() => calendarDay(now(), timeZone))
  const [notice, setNotice] = useState<string | null>(null)
  const [clearRead, setClearRead] = useState<UsageDashboardRead | null>(null)
  const [refreshing, setRefreshing] = useState<ReadonlySet<UsageProviderId>>(() => new Set())
  const [announcement, setAnnouncement] = useState('')
  const moreButton = useRef<HTMLButtonElement | null>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const pendingFocus = useRef<{ tab?: UsageTab; provider?: UsageProviderId } | null>(null)
  const refreshedOnOpen = useRef(new Set<string>())
  const id = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // The filters a tab shows are the ones it reads with: limits are account-wide, so Subscriptions reads every provider.
  const activityFilters = tab !== 'subscriptions'
  const bounds = range === '7' || range === '30' || range === '90' ? rangeBounds(Number(range), now(), timeZone) : range === 'custom'
    ? { ...(customFrom === '' ? {} : { from: customFrom }), ...(customTo === '' ? {} : { to: customTo }) } : {}
  const invalidRange = bounds.from !== undefined && bounds.to !== undefined && bounds.from > bounds.to
  const sources: UsageSource[] | undefined = activityFilters && where !== 'all' ? [where] : undefined
  const queryKey = JSON.stringify([bounds, activityFilters ? provider : 'all', sources, timeZone, today])
  const query = useMemo<UsageQuery | null>(() => invalidRange ? null : {
    timeZone, includeDaily: true, ...bounds,
    ...(activityFilters && provider !== 'all' ? { providerIds: [provider] } : {}),
    ...(sources === undefined ? {} : { sources }),
    // The key names every input; the objects it is built from are new on each render.
  }, [queryKey, invalidRange])
  const targetKey = hostId === 'all' ? connections.map(item => item.hostId).join('\n') : hostId
  const targets = useMemo(() => targetKey === '' ? [] : targetKey.split('\n'), [targetKey])
  const connectionKey = connections.map(item => `${item.hostId}:${item.connected !== false}`).join(',')
  const usage = useUsageRead(bridge, targets, query, connectionKey)
  const reloadRef = useRef(usage.reload)
  reloadRef.current = usage.reload

  const raw = usage.read
  const read = useMemo<UsageDashboardRead>(() => ({ hosts: (raw?.hosts ?? []).map(host => scopeHost(host, sources)) }), [raw, sources])
  const summary = useMemo(() => presentUsage(read), [read])
  // A provider held to Owl has no usage on this run (ADR-0072), so the menu does not offer it.
  const held = useHeldProviders()
  const providerChoices = useMemo<readonly ChoiceOption<UsageProviderId | 'all'>[]>(() => [{ value: 'all', label: 'All providers' },
    ...USAGE_PROVIDERS.filter(id => !held.has(id)).map(id => ({ value: id, label: PROVIDER_NAMES[id] }))], [held])
  const clock = now().getTime()
  const limits = providerLimits(read, clock)

  const localId = connections.find(item => item.kind === 'local')?.hostId ?? state?.hostId
  const hostName = useCallback((value: string): string => {
    if (value === localId || value === state?.host.hostId) return 'This computer'
    const named = connections.find(item => item.hostId === value)?.name
    if (named !== undefined) return named
    const index = read.hosts.findIndex(host => host.hostId === value)
    return `Computer ${Math.max(1, index + 1)}`
  }, [connections, localId, read, state?.host.hostId])
  // One name per served model on every computer, online or not: a client catalog's names differ between versions and hosts.
  const modelName = (row: { modelId: string; providerId: UsageProviderId }): string => servedModelName(row.providerId, row.modelId)
  const providerAccount = (providerId: UsageLimitProviderId, owner: string): string => {
    const statuses = state?.host.clientHosts?.find(item => item.hostId === owner)?.providers ?? (owner === localId || owner === state?.host.hostId ? state?.host.providers : undefined)
    return statuses?.find(item => item.id === providerId)?.account ?? PROVIDER_ACCOUNTS[providerId]
  }

  const announce = useCallback((text: string): void => { setAnnouncement(''); setTimeout(() => { if (mounted.current) setAnnouncement(text) }, 30) }, [])
  const openTab = useCallback((value: UsageTab): void => { pendingFocus.current = { tab: value }; setTab(value) }, [])
  const openProvider = useCallback((providerId: UsageProviderId): void => { pendingFocus.current = { provider: providerId }; setTab('subscriptions') }, [])
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    if (target.tab !== undefined) tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[TABS.indexOf(target.tab)]?.focus()
    if (target.provider !== undefined) {
      const section = scroll.current?.querySelector<HTMLElement>(`#usage-sub-${target.provider}`)
      section?.scrollIntoView?.({ block: 'start' })
      section?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
    }
  }, [tab])

  // Limits older than a minute are read again once each computer first answers; Read again asks at any time.
  useEffect(() => {
    if (bridge === undefined || raw === null) return
    for (const host of raw.hosts) {
      if (host.status !== 'ready' || refreshedOnOpen.current.has(host.hostId)) continue
      refreshedOnOpen.current.add(host.hostId)
      const providerIds = host.quotas.filter(quota => {
        if (!quota.refreshable) return false
        // Claude Code's passive events can carry a status and no share; a recent one of those is read again too.
        if (quota.providerId === 'claude' && (quota.status !== 'available' || quota.windows.some(window => window.usedPercent === undefined))) return true
        const observed = Date.parse(quota.observedAt ?? '')
        return !Number.isFinite(observed) || Math.abs(clock - observed) >= QUOTA_FRESH_MS
      }).map(quota => quota.providerId)
      if (providerIds.length === 0) continue
      // Made on its own, so a provider whose read is costly may answer from a recent reading (#1456); Read again never is.
      void bridge.refresh({ hostIds: [host.hostId], providerIds, background: true }).then(result => {
        if (!mounted.current) return
        usage.applyQuotas(result, providerIds); reloadRef.current([host.hostId])
      }, () => { if (mounted.current) setNotice('Subscription limits could not be read again. Your saved figures are still here.') })
    }
  }, [bridge, raw, clock, usage.applyQuotas])

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden' || clearRead !== null) return
      const day = calendarDay(now(), timeZone)
      if (day !== today) setToday(day)
      else reloadRef.current()
    }, 30_000)
    return () => clearInterval(interval)
  }, [clearRead, now, timeZone, today])

  const readAgain = async (providerId: UsageProviderId): Promise<void> => {
    if (bridge === undefined || refreshing.has(providerId)) return
    const hostIds = read.hosts.filter(host => host.quotas.some(quota => quota.providerId === providerId && quota.refreshable)).map(host => host.hostId)
    if (hostIds.length === 0) return
    setRefreshing(value => new Set(value).add(providerId)); setNotice(null)
    try {
      const result = await bridge.refresh({ hostIds, providerIds: [providerId] })
      if (!mounted.current) return
      usage.applyQuotas(result, [providerId])
      announce(`${PROVIDER_NAMES[providerId]} limits read just now`)
    } catch {
      if (mounted.current) setNotice(`${PROVIDER_NAMES[providerId]}'s limits could not be read again. The last reading is still shown. Try Read again.`)
    } finally {
      if (mounted.current) setRefreshing(value => { const next = new Set(value); next.delete(providerId); return next })
    }
  }

  const clearable = read.hosts.filter(host => host.status === 'ready' && host.activity !== undefined)
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
        reloadRef.current()
        return true
      }
      setNotice('Saved usage figures were cleared on the selected computers.'); reloadRef.current(); return true
    } catch { return false }
  }

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = roomKeyTarget(event.key, index, TABS.length)
    if (target === null) return
    event.preventDefault(); setTab(TABS[target]!)
    tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus()
  }

  // The days the charts draw. All time starts at the first day with any activity.
  const firstActive = summary.daily.find(row => !isEmptyActivity(row))?.day
  const from = bounds.from ?? firstActive, to = bounds.to ?? today
  const days = useMemo(() => {
    if (from === undefined || from > to) return []
    const count = Math.min(DAYS_MAX, daysBetween(from, to) + 1)
    return Array.from({ length: count }, (_, index) => addDays(from, index))
  }, [from, to])
  const label = rangeLabel(bounds.from, bounds.to, range === 'all' ? firstActive : undefined)

  const ready = read.hosts.filter(host => host.status === 'ready' && host.activity !== undefined && !withoutHistory(host))
  const old = summary.withoutPlaces.map(hostName)
  const withoutPlacesNote = old.length === 0 ? null : old.length === 1
    ? `${old[0]} counts only its Sotto threads until its host update.` : `${joinNames(old)} count only their Sotto threads until their hosts update.`
  const page: UsagePage = {
    bridge, read, summary, limits, query: query ?? { timeZone }, hostIds: targets, now: clock, today, timeZone, rangeLabel: label, days,
    provider: activityFilters ? provider : 'all', where: activityFilters ? where : 'all',
    placesKnown: ready.some(host => !predatesHistory(host.activity!)), withoutPlacesNote,
    cleared: ready.some(host => host.activity?.metadata.clearedAt !== undefined),
    hostName, modelName, providerAccount, announce, openTab, openProvider,
  }

  const noHistory = read.hosts.length > 0 && read.hosts.every(withoutHistory)
  const computerChoices: ChoiceOption<string>[] = [{ value: 'all', label: 'All computers' },
    ...[...new Set([...connections.map(item => item.hostId), ...read.hosts.map(host => host.hostId)])].map(value => ({ value, label: hostName(value) }))]
  const pendingNames = usage.read === null ? [] : usage.pending.filter(item => item !== EVERY_HOST && !read.hosts.some(host => host.hostId === item)).map(hostName)
  const scanning = read.hosts.filter(host => host.activity?.metadata.history?.status === 'scanning').map(host => hostName(host.hostId))

  let body: ReactNode
  if (bridge === undefined) body = <p className="usage-none" role="alert">Usage is not available in this build.</p>
  else if (usage.read === null && usage.failed.length > 0 && !usage.loading) body = null
  else if (usage.read === null) body = <p className="usage-loading" role="status">Reading usage…</p>
  else if (invalidRange) body = null
  else if (tab === 'subscriptions') body = <Subscriptions page={page} refreshing={refreshing} onReadAgain={providerId => void readAgain(providerId)} />
  else if (noHistory) body = <>{tab === 'overview' ? <Glance page={page} /> : null}<NoHistory names={read.hosts.map(host => hostName(host.hostId))} /></>
  else if (tab === 'models') body = <Models page={page} />
  // As the approved design has it, a cleared computer with nothing new replaces the index; an empty range keeps it.
  else if (page.cleared && isEmptyActivity(summary.totals)) body = <><Glance page={page} /><EmptyUsage title="Nothing recorded yet" detail="Usage starts counting again with your next prompt." /></>
  else body = <Overview page={page} />

  return <section className="usage-view" aria-label="Usage"><div ref={scroll} className="usage-scroll"><div className="usage-page">
    <header className="usage-header">
      <div className="usage-title">
        <h1>Usage</h1>
        <ActionMenu ref={moreButton} label="More usage actions" items={[{ id: 'clear', label: 'Clear usage…', tone: 'danger', disabled: clearable.length === 0,
          ...(clearable.length === 0 ? { hint: 'Nothing on the selected computers can be cleared.' } : {}), run: () => { setNotice(null); setClearRead(read) } }]} />
      </div>
      <p className="usage-subtitle">Your subscriptions, and the work on each computer, in Sotto and outside it.</p>
      <div className="usage-bar">
        <div ref={tabs} className="usage-seg" role="tablist" aria-label="Usage views">{TABS.map((value, index) => <button key={value} type="button" role="tab" className="tt-focusable"
          id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
          onClick={() => setTab(value)} onKeyDown={event => onTabKey(event, index)}>{TAB_NAMES[value]}</button>)}</div>
        <div className="usage-filters">
          {activityFilters ? <ChoiceMenu name="Date range" value={range} options={RANGES} onChoose={setRange} /> : null}
          {activityFilters ? <ChoiceMenu name="Provider" value={provider} options={providerChoices} onChoose={setProvider} /> : null}
          <ChoiceMenu name="Computer" value={hostId} options={computerChoices} onChoose={setHostId} />
          {activityFilters ? <ChoiceMenu name="Where" value={where} options={PLACES} onChoose={setWhere} /> : null}
        </div>
      </div>
      {range === 'custom' && activityFilters ? <div className="usage-dates">
        <label>From<input className="tt-focusable" type="date" value={customFrom} max={today} onChange={event => setCustomFrom(event.target.value)} /></label>
        <label>Through<input className="tt-focusable" type="date" value={customTo} max={today} onChange={event => setCustomTo(event.target.value)} /></label>
      </div> : null}
    </header>
    <div className="usage-notices">
      {invalidRange && activityFilters ? <p className="usage-notice" role="alert">Choose an end date on or after the start date.</p> : null}
      {notice !== null ? <p className="usage-notice" role="status">{notice}</p> : null}
      {usage.failed.map(item => <p key={item} className="usage-notice" role="alert">{item === EVERY_HOST ? 'Usage could not be read.' : `Usage could not be read from ${midSentence(hostName(item))}.`} Your saved figures were not changed. <button type="button" className="usage-link tt-focusable" onClick={() => usage.reload([item])}>Try again</button></p>)}
      {read.hosts.some(host => host.persistence === 'failed') ? <p className="usage-notice" role="alert">Some recent usage could not be saved. Provider work goes on; repair local storage, then restart Sotto.</p> : null}
      {read.hosts.filter(host => host.status !== 'ready' || withoutHistory(host)).filter(host => !(noHistory && withoutHistory(host))).map(host => <p key={host.hostId} className="usage-notice usage-notice--quiet">{
        withoutHistory(host) ? `${hostName(host.hostId)}'s history appears after its host update.`
          : host.status === 'offline' ? `${hostName(host.hostId)} is offline. Its figures appear when it reconnects.`
            : `Usage could not be read from ${midSentence(hostName(host.hostId))}. Nothing was changed. Try again in a moment.`}</p>)}
      {pendingNames.length > 0 ? <p className="usage-notice usage-notice--quiet" role="status">Still reading {joinNames(pendingNames.map(midSentence))}…</p> : null}
      {scanning.length > 0 && tab !== 'subscriptions' ? <p className="usage-notice usage-notice--quiet">Still reading {joinNames(scanning.map(name => `${midSentence(name)}'s`))} history. The figures fill in as it reads.</p> : null}
    </div>
    <div id={`${id}-panel`} className="usage-panel" role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={usage.loading || undefined}>
      <div key={tab} className="usage-enter">{body}</div>
    </div>
    <p className="tt-visually-hidden" aria-live="polite">{announcement}</p>
  </div></div>
  {clearRead !== null ? <ConfirmationDialog title="Clear saved usage?" description={<>
    <p>Remove the usage figures saved on {joinNames(clearRead.hosts.filter(host => host.status === 'ready' && host.activity !== undefined).map(host => midSentence(hostName(host.hostId))))}?</p>
    <p>This clears every date, provider, model and app on those computers, including figures outside the current filters. Thread history, subscription limits and the clients' own records stay as they are.</p>
    <p>Records from before the clear never come back. New work counts afterward.</p>
  </>} confirmLabel="Clear saved usage" cancelLabel="Keep usage" onConfirm={clear} onCancel={() => setClearRead(null)} failureMessage="Usage could not be cleared. Your saved figures may remain. Try again." fallbackFocusRef={moreButton} /> : null}
  </section>
}

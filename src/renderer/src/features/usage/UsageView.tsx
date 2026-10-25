import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { i18n as interfaceI18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
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
const TAB_NAMES: Record<UsageTab, MessageDescriptor> = { overview: msg`Overview`, subscriptions: msg`Subscriptions`, models: msg`Models` }
type Range = '7' | '30' | '90' | 'all' | 'custom'
interface Choice<T extends string> { readonly value: T; readonly label: MessageDescriptor }
const RANGES: readonly Choice<Range>[] = [{ value: '7', label: msg`Last 7 days` }, { value: '30', label: msg`Last 30 days` }, { value: '90', label: msg`Last 90 days` }, { value: 'all', label: msg`All time` }, { value: 'custom', label: msg`Choose dates` }]
const PLACES: readonly Choice<UsageWhere>[] = [{ value: 'all', label: msg`Everywhere` }, { value: 'sotto', label: msg`In Sotto` }, { value: 'outside', label: msg`Outside Sotto` }]
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
  const { t, i18n } = useLingui()
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
  const providerChoices = useMemo<readonly ChoiceOption<UsageProviderId | 'all'>[]>(() => [{ value: 'all', label: t`All providers` },
    ...USAGE_PROVIDERS.filter(id => !held.has(id)).map(id => ({ value: id, label: PROVIDER_NAMES[id] }))], [held, t])
  const ranges = RANGES.map(option => ({ value: option.value, label: i18n._(option.label) }))
  const places = PLACES.map(option => ({ value: option.value, label: i18n._(option.label) }))
  const clock = now().getTime()
  const limits = providerLimits(read, clock)

  const localId = connections.find(item => item.kind === 'local')?.hostId ?? state?.hostId
  const hostName = useCallback((value: string): string => {
    if (value === localId || value === state?.host.hostId) return t`This computer`
    const named = connections.find(item => item.hostId === value)?.name
    if (named !== undefined) return named
    const number = Math.max(1, read.hosts.findIndex(host => host.hostId === value) + 1)
    return t`Computer ${number}`
  }, [connections, localId, read, state?.host.hostId, t])
  // One name per served model on every computer, online or not: a client catalog's names differ between versions and hosts.
  const modelName = (row: { modelId: string; providerId: UsageProviderId }): string => servedModelName(row.providerId, row.modelId)
  const providerAccount = (providerId: UsageLimitProviderId, owner: string): string => {
    const statuses = state?.host.clientHosts?.find(item => item.hostId === owner)?.providers ?? (owner === localId || owner === state?.host.hostId ? state?.host.providers : undefined)
    return statuses?.find(item => item.id === providerId)?.account ?? i18n._(PROVIDER_ACCOUNTS[providerId])
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
      }, () => { if (mounted.current) setNotice(interfaceI18n._(msg`Subscription limits could not be read again. Your saved figures are still here.`)) })
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
    const name = PROVIDER_NAMES[providerId]
    setRefreshing(value => new Set(value).add(providerId)); setNotice(null)
    try {
      const result = await bridge.refresh({ hostIds, providerIds: [providerId] })
      if (!mounted.current) return
      usage.applyQuotas(result, [providerId])
      announce(t`${name} limits read just now`)
    } catch {
      if (mounted.current) setNotice(t`${name}'s limits could not be read again. The last reading is still shown. Try Read again.`)
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
        const some = result.some(item => item.status === 'cleared')
        setNotice(result.some(item => item.status === 'stale')
          ? some
            ? t`Some usage figures were cleared. Usage changed while the question was open. Review the current figures, then choose Clear usage again.`
            : t`Usage changed while the question was open. Review the current figures, then choose Clear usage again.`
          : some
            ? t`Some usage figures were cleared. Some computers could not confirm that usage was cleared. Review the current figures before trying again.`
            : t`Some computers could not confirm that usage was cleared. Review the current figures before trying again.`)
        reloadRef.current()
        return true
      }
      setNotice(t`Saved usage figures were cleared on the selected computers.`); reloadRef.current(); return true
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
  const oldNames = joinNames(old), oldCount = old.length
  const withoutPlacesNote = oldCount === 0 ? null : plural(oldCount, {
    one: `${oldNames} counts only its Sotto threads until its host update.`,
    other: `${oldNames} count only their Sotto threads until their hosts update.`,
  })
  const page: UsagePage = {
    bridge, read, summary, limits, query: query ?? { timeZone }, hostIds: targets, now: clock, today, timeZone, rangeLabel: label, days,
    provider: activityFilters ? provider : 'all', where: activityFilters ? where : 'all',
    placesKnown: ready.some(host => !predatesHistory(host.activity!)), withoutPlacesNote,
    cleared: ready.some(host => host.activity?.metadata.clearedAt !== undefined),
    hostName, modelName, providerAccount, announce, openTab, openProvider,
  }

  const noHistory = read.hosts.length > 0 && read.hosts.every(withoutHistory)
  const computerChoices: ChoiceOption<string>[] = [{ value: 'all', label: t`All computers` },
    ...[...new Set([...connections.map(item => item.hostId), ...read.hosts.map(host => host.hostId)])].map(value => ({ value, label: hostName(value) }))]
  const pendingNames = usage.read === null ? [] : usage.pending.filter(item => item !== EVERY_HOST && !read.hosts.some(host => host.hostId === item)).map(hostName)
  const scanning = read.hosts.filter(host => host.activity?.metadata.history?.status === 'scanning').map(host => hostName(host.hostId))
  const pendingList = joinNames(pendingNames.map(midSentence))
  const scanningList = joinNames(scanning.map(name => {
    const whose = midSentence(name)
    return t({ message: `${whose}'s`, comment: 'A computer\'s, in "Still reading {scanningList} history"' })
  }))
  const clearingList = clearRead === null ? '' : joinNames(clearRead.hosts.filter(host => host.status === 'ready' && host.activity !== undefined).map(host => midSentence(hostName(host.hostId))))

  let body: ReactNode
  if (bridge === undefined) body = <p className="usage-none tt-paragraph" role="alert"><Trans>Usage is not available in this build.</Trans></p>
  else if (usage.read === null && usage.failed.length > 0 && !usage.loading) body = null
  else if (usage.read === null) body = <p className="usage-loading tt-paragraph" role="status"><Trans>Reading usage…</Trans></p>
  else if (invalidRange) body = null
  else if (tab === 'subscriptions') body = <Subscriptions page={page} refreshing={refreshing} onReadAgain={providerId => void readAgain(providerId)} />
  else if (noHistory) body = <>{tab === 'overview' ? <Glance page={page} /> : null}<NoHistory names={read.hosts.map(host => hostName(host.hostId))} /></>
  else if (tab === 'models') body = <Models page={page} />
  // As the approved design has it, a cleared computer with nothing new replaces the index; an empty range keeps it.
  else if (page.cleared && isEmptyActivity(summary.totals)) body = <><Glance page={page} /><EmptyUsage title={t`Nothing recorded yet`} detail={t`Usage starts counting again with your next prompt.`} /></>
  else body = <Overview page={page} />

  return <section className="usage-view" aria-label={t`Usage`}><div ref={scroll} className="usage-scroll"><div className="usage-page">
    <header className="usage-header">
      <div className="usage-title">
        <h1><Trans>Usage</Trans></h1>
        <ActionMenu ref={moreButton} label={t`More usage actions`} items={[{ id: 'clear', label: t`Clear usage…`, tone: 'danger', disabled: clearable.length === 0,
          ...(clearable.length === 0 ? { hint: t`Nothing on the selected computers can be cleared.` } : {}), run: () => { setNotice(null); setClearRead(read) } }]} />
      </div>
      <p className="usage-subtitle tt-paragraph"><Trans>Your subscriptions, and the work on each computer, in Sotto and outside it.</Trans></p>
      <div className="usage-bar">
        <div ref={tabs} className="usage-seg" role="tablist" aria-label={t`Usage views`}>{TABS.map((value, index) => <button key={value} type="button" role="tab" className="tt-focusable"
          id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
          onClick={() => setTab(value)} onKeyDown={event => onTabKey(event, index)}>{i18n._(TAB_NAMES[value])}</button>)}</div>
        <div className="usage-filters">
          {activityFilters ? <ChoiceMenu name={t`Date range`} value={range} options={ranges} onChoose={setRange} /> : null}
          {activityFilters ? <ChoiceMenu name={t`Provider`} value={provider} options={providerChoices} onChoose={setProvider} /> : null}
          <ChoiceMenu name={t`Computer`} value={hostId} options={computerChoices} onChoose={setHostId} />
          {activityFilters ? <ChoiceMenu name={t`Where`} value={where} options={places} onChoose={setWhere} /> : null}
        </div>
      </div>
      {range === 'custom' && activityFilters ? <div className="usage-dates">
        <label><Trans>From</Trans><input className="tt-focusable" type="date" value={customFrom} max={today} onChange={event => setCustomFrom(event.target.value)} /></label>
        <label><Trans>Through</Trans><input className="tt-focusable" type="date" value={customTo} max={today} onChange={event => setCustomTo(event.target.value)} /></label>
      </div> : null}
    </header>
    <div className="usage-notices">
      {invalidRange && activityFilters ? <p className="usage-notice tt-paragraph" role="alert"><Trans>Choose an end date on or after the start date.</Trans></p> : null}
      {notice !== null ? <p className="usage-notice tt-paragraph" role="status">{notice}</p> : null}
      {usage.failed.map(item => {
        const from = item === EVERY_HOST ? '' : midSentence(hostName(item))
        return <p key={item} className="usage-notice tt-paragraph" role="alert">{item === EVERY_HOST ? t`Usage could not be read. Your saved figures were not changed.` : t`Usage could not be read from ${from}. Your saved figures were not changed.`} <button type="button" className="usage-link tt-focusable" onClick={() => usage.reload([item])}><Trans>Try again</Trans></button></p>
      })}
      {read.hosts.some(host => host.persistence === 'failed') ? <p className="usage-notice tt-paragraph" role="alert"><Trans>Some recent usage could not be saved. Provider work goes on; repair local storage, then restart Sotto.</Trans></p> : null}
      {read.hosts.filter(host => host.status !== 'ready' || withoutHistory(host)).filter(host => !(noHistory && withoutHistory(host))).map(host => {
        const name = hostName(host.hostId), from = midSentence(name)
        return <p key={host.hostId} className="usage-notice usage-notice--quiet tt-paragraph">{
          withoutHistory(host) ? t`${name}'s history appears after its host update.`
            : host.status === 'offline' ? t`${name} is offline. Its figures appear when it reconnects.`
              : t`Usage could not be read from ${from}. Nothing was changed. Try again in a moment.`}</p>
      })}
      {pendingNames.length > 0 ? <p className="usage-notice usage-notice--quiet tt-paragraph" role="status"><Trans>Still reading {pendingList}…</Trans></p> : null}
      {scanning.length > 0 && tab !== 'subscriptions' ? <p className="usage-notice usage-notice--quiet tt-paragraph"><Trans>Still reading {scanningList} history. The figures fill in as it reads.</Trans></p> : null}
    </div>
    <div id={`${id}-panel`} className="usage-panel" role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={usage.loading || undefined}>
      <div key={tab} className="usage-enter">{body}</div>
    </div>
    <p className="tt-visually-hidden" aria-live="polite">{announcement}</p>
  </div></div>
  {clearRead !== null ? <ConfirmationDialog title={t`Clear saved usage?`} description={<>
    <p className="tt-paragraph"><Trans>Remove the usage figures saved on {clearingList}?</Trans></p>
    <p className="tt-paragraph"><Trans>This clears every date, provider, model and app on those computers, including figures outside the current filters. Thread history, subscription limits and the clients' own records stay as they are.</Trans></p>
    <p className="tt-paragraph"><Trans>Records from before the clear never come back. New work counts afterward.</Trans></p>
  </>} confirmLabel={t`Clear saved usage`} cancelLabel={t`Keep usage`} onConfirm={clear} onCancel={() => setClearRead(null)} failureMessage={t`Usage could not be cleared. Your saved figures may remain. Try again.`} fallbackFocusRef={moreButton} /> : null}
  </section>
}

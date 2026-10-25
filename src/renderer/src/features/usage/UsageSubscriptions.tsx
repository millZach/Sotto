import React, { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { UsageActivityAggregate, UsageFieldTotal, UsageProviderId } from '../../../../shared/usageDashboard'
import { ProviderMark } from '../../agents/ProviderMark'
import { Ring } from './UsageCharts'
import type { UsagePage } from './usagePage'
import {
  LOW_LEFT, PROVIDER_NAMES, READ_OUTSIDE_SOTTO, fieldTokens, sumFields, fmtInt, limitsMissing, midSentence, predatesHistory, readAge, readAgePhrase, resetLong,
  unknownUseNote, type UsageProviderLimits, type UsageWindowView,
} from './usagePresentation'

type Style = CSSProperties & Record<`--${string}`, string | number>
interface Since { readonly totals: UsageActivityAggregate; readonly sottoTokens: UsageFieldTotal }

export function Subscriptions({ page, refreshing, onReadAgain }: {
  readonly page: UsagePage
  readonly refreshing: ReadonlySet<UsageProviderId>
  readonly onReadAgain: (providerId: UsageProviderId) => void
}): ReactNode {
  const since = useWindowActivity(page)
  return <>
    <p className="usage-intro tt-paragraph"><Trans>Limits come from each provider and count all use of the account, in Sotto or anywhere else. The thin mark on each bar shows how much of that window's time is left.</Trans></p>
    {page.limits.length === 0 ? <p className="usage-none tt-paragraph"><Trans>No subscription readings on the selected computers.</Trans></p> : null}
    {page.limits.map(item => <Provider key={item.providerId} limits={item} page={page} busy={refreshing.has(item.providerId)} onReadAgain={onReadAgain} since={since.get(sinceKey(item))} />)}
  </>
}

const sinceKey = (item: UsageProviderLimits): string => `${item.primary.hostId}|${item.providerId}|${item.primary.longest?.startedAt ?? ''}`

/** What the computer behind each reading did since that provider's longest window began, from a `since` read. */
function useWindowActivity(page: UsagePage): ReadonlyMap<string, Since> {
  const [found, setFound] = useState<ReadonlyMap<string, Since>>(() => new Map())
  const wanted = page.limits.filter(item => {
    const host = page.read.hosts.find(entry => entry.hostId === item.primary.hostId)
    return item.primary.longest?.startedAt !== undefined && host?.status === 'ready' && host.activity !== undefined && !predatesHistory(host.activity)
  })
  const revision = (hostId: string): number => page.read.hosts.find(entry => entry.hostId === hostId)?.activity?.metadata.revision ?? -1
  const key = wanted.map(item => `${sinceKey(item)}|${revision(item.primary.hostId)}`).join('\n')
  const { bridge, timeZone } = page
  useEffect(() => {
    if (bridge === undefined || key === '') return
    let current = true
    for (const line of key.split('\n')) {
      const [hostId, providerId, startedAt] = line.split('|') as [string, UsageProviderId, string]
      bridge.read({ since: new Date(Number(startedAt)).toISOString(), providerIds: [providerId], hostIds: [hostId], timeZone }).then(result => {
        const activity = result.hosts.find(host => host.hostId === hostId)?.activity
        if (!current || activity === undefined) return
        const sottoTokens = sumFields((activity.clients ?? []).filter(row => row.source === 'sotto').map(row => row.tokens.total))
        setFound(value => new Map(value).set(`${hostId}|${providerId}|${startedAt}`, { totals: activity.totals, sottoTokens }))
      }, () => undefined)
    }
    return () => { current = false }
  }, [bridge, key, timeZone])
  return found
}

function Provider({ limits, page, busy, onReadAgain, since }: {
  readonly limits: UsageProviderLimits
  readonly page: UsagePage
  readonly busy: boolean
  readonly onReadAgain: (providerId: UsageProviderId) => void
  readonly since: Since | undefined
}): ReactNode {
  const { t } = useLingui()
  const { providerId, primary } = limits
  const name = PROVIDER_NAMES[providerId]
  const heading = useId()
  const read = primary.quota.status === 'available' || primary.observedAt !== undefined
  const refreshable = limits.readings.some(item => item.quota.refreshable)
  const sharedHosts = limits.readings.filter(item => item.windows.length > 0).length > 1
  const computer = midSentence(page.hostName(primary.hostId))
  let activity: ReactNode = null
  if (since !== undefined) {
    const prompts = since.totals.prompts.total
    const tokens = since.totals.tokens.total
    const shown = fmtInt(prompts), tokensShown = fieldTokens(tokens), sottoShown = fieldTokens(since.sottoTokens)
    if (!READ_OUTSIDE_SOTTO.has(providerId)) {
      activity = <p className="usage-sub__activity tt-paragraph">{prompts > 0
        ? <Trans>Since this window began: <b>{shown}</b> <Plural value={prompts} one="prompt" other="prompts" /> in Sotto.</Trans>
        : t`Since this window began: no prompts in Sotto.`} <Trans>Sotto doesn't read {name}'s use outside Sotto.</Trans></p>
    } else if (prompts === 0 && (tokens.rows === 0 || (tokens.value === 0 && !tokens.partial))) activity = <p className="usage-sub__activity tt-paragraph"><Trans>Since this window began: nothing on {computer}.</Trans></p>
    else activity = <p className="usage-sub__activity tt-paragraph"><Trans>Since this window began: <b>{shown}</b> <Plural value={prompts} one="prompt" other="prompts" /> and <b>{tokensShown}</b> tokens on {computer}, <b>{sottoShown}</b> of them in Sotto.</Trans></p>
  }
  return <section className="usage-sub" id={`usage-sub-${providerId}`} aria-labelledby={heading}>
    <div className="usage-sub__id">
      <div className="usage-sub__name"><ProviderMark provider={providerId} name={name} size={22} /><div><h2 id={heading} tabIndex={-1}>{name}</h2><p className="usage-sub__account">{page.providerAccount(providerId, primary.hostId)}</p></div></div>
      {read ? <span className="usage-sub__fresh" data-stale={primary.stale || undefined}><Clock size={13} aria-hidden="true" />{readAge(primary.observedAt, page.now)}{sharedHosts ? ` · ${page.hostName(primary.hostId)}` : ''}</span> : null}
      {refreshable ? <button type="button" className="usage-button tt-focusable" aria-disabled={busy || undefined} aria-label={busy ? t`Reading ${name} limits` : t`Read ${name} limits again`} onClick={() => { if (!busy) onReadAgain(providerId) }}>{busy ? t`Reading…` : t`Read again`}</button> : null}
      {limits.others.map(other => {
        const where = midSentence(page.hostName(other.hostId)), left = other.tightest!.left, windowName = other.tightest!.phrase, age = readAgePhrase(other.observedAt, page.now)
        return <p key={other.hostId} className="usage-sub__other tt-paragraph"><Trans>On {where}: <b>{left}%</b> left, {windowName} · {age}</Trans></p>
      })}
    </div>
    <div className="usage-sub__body">
      {primary.windows.length > 0
        ? primary.windows.map(window => <Window key={window.id} window={window} page={page} note={window.left === undefined && window.resetsAt !== undefined ? unknownUseNote(providerId) : undefined} />)
        : <div className="usage-sub__none"><Ring size={56} parts={[{ left: undefined, width: 4, inset: 0 }]} /><p className="tt-paragraph">{limitsMissing(limits, page.hostName, page.now, page.timeZone)}</p></div>}
      {activity}
    </div>
  </section>
}

function Window({ window, page, note }: { readonly window: UsageWindowView; readonly page: UsagePage; readonly note: string | undefined }): ReactNode {
  const { t } = useLingui()
  const timeLeft = window.timeLeft
  const mark = timeLeft === undefined ? null : <i className="usage-window__now" style={{ '--usage-x': `${timeLeft.toFixed(1)}%` } as Style} />
  const resets = window.resetsAt === undefined ? '' : resetLong(window.resetsAt, page.now, page.timeZone)
  const timePercent = timeLeft === undefined ? 0 : Math.round(timeLeft)
  const foot = <div className="usage-window__foot">
    <span>{window.resetsAt === undefined ? t`Reset time not reported` : t`Resets ${resets}`}</span>
    {timeLeft === undefined ? null : <span><Trans>{timePercent}% of the time left</Trans></span>}
  </div>
  const label = window.label
  if (window.left === undefined) {
    return <div className="usage-window">
      <div className="usage-window__top"><span className="usage-window__label">{window.label}</span><span className="usage-window__left"><b className="usage-dash" aria-hidden="true">—</b><Trans comment="What is left of a subscription's window, after its percentage">left</Trans></span></div>
      <div className="usage-window__track usage-window__track--unknown" role="img" aria-label={timeLeft === undefined ? t`${label}: use not reported` : t`${label}: use not reported, ${timePercent}% of the window's time left`}>{mark}</div>
      {foot}
      {note === undefined ? null : <p className="usage-window__note tt-paragraph">{note}</p>}
    </div>
  }
  const low = window.left <= LOW_LEFT
  const left = window.left
  const used = Math.round(window.usedPercent ?? 0)
  return <div className="usage-window">
    <div className="usage-window__top"><span className="usage-window__label">{window.label}</span><span className="usage-window__left"><b data-low={low || undefined}>{window.left}%</b><Trans comment="What is left of a subscription's window, after its percentage">left</Trans></span></div>
    <div className="usage-window__track" role="img" aria-label={timeLeft === undefined ? t`${label}: ${left}% of the allowance left` : t`${label}: ${left}% of the allowance left, ${timePercent}% of the window's time left`}>
      <i className="usage-window__fill usage-grow" data-low={low || undefined} style={{ '--usage-w': `${window.left}%` } as Style} />{mark}
    </div>
    {foot}
    {window.usedPercent !== undefined && window.usedPercent > 100 ? <p className="usage-window__note tt-paragraph"><Trans>{used}% used, past the allowance.</Trans></p> : null}
  </div>
}

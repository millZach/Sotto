import React, { type ReactNode } from 'react'
import type { UsageDashboardRead, UsageQuotaRead, UsageQuotaWindow } from '../../../../shared/usageDashboard'
import { ProviderMark } from '../../agents/ProviderMark'
import { Ring } from './UsageCharts'
import { PROVIDER_NAMES } from './usagePresentation'

export function quotaExpired(window: UsageQuotaWindow, now: number): boolean {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now
}

export function quotaAge(at: string | undefined, now: number): string {
  if (at === undefined) return 'Not read yet'
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000))
  if (minutes < 1) return 'Read just now'
  if (minutes < 60) return `Read ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `Read ${hours} hour${hours === 1 ? '' : 's'} ago` : `Read ${Math.floor(hours / 24)} days ago`
}

export function quotaUnavailable(quota: UsageQuotaRead): string {
  if (quota.status === 'error') return 'Limits could not be read. Refresh to try again.'
  switch (quota.reason) {
    case 'not-connected': return 'This provider is not connected on this computer.'
    case 'not-read': return 'Limits have not been read yet.'
    case 'refresh-unavailable': return 'Waiting for the provider to report limits.'
    case 'not-reported': return 'The provider has not reported a percentage.'
    case 'read-failed': return 'Limits could not be read. Refresh to try again.'
    default: return 'This provider does not expose subscription limits here.'
  }
}

export function quotaWindows(read: UsageDashboardRead, now: number) {
  return read.hosts.flatMap(host => host.quotas.flatMap(quota => quota.windows.map(window => ({ hostId: host.hostId, quota, window,
    left: window.usedPercent === undefined || quotaExpired(window, now) ? undefined : Math.max(0, 100 - window.usedPercent),
  }))))
}

function resetCopy(window: UsageQuotaWindow, now: number): string {
  if (window.resetsAt === undefined) return 'Reset time not reported'
  const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(window.resetsAt))
  return quotaExpired(window, now) ? `Reset was ${formatted}. Waiting for a new reading.` : `Resets ${formatted}`
}

export function UsageSubscriptions({ read, hostName, now, compact = false }: {
  readonly read: UsageDashboardRead; readonly hostName: (hostId: string) => string; readonly now: number; readonly compact?: boolean
}): ReactNode {
  const entries = read.hosts.flatMap(host => host.quotas.map(quota => ({ host, quota })))
  if (entries.length === 0) return <p className="usage-note">No subscription readings are available on the selected computers.</p>
  return <div className={compact ? 'usage-allowances' : 'usage-subscriptions'}>
    {entries.map(({ host, quota }) => {
      const known = (quota.status === 'available' ? quota.windows : []).filter(window => window.usedPercent !== undefined && !quotaExpired(window, now))
        .sort((a, b) => b.usedPercent! - a.usedPercent!)[0]
      const left = known === undefined ? undefined : Math.max(0, 100 - known.usedPercent!)
      const name = PROVIDER_NAMES[quota.providerId]
      return <section key={`${host.hostId}:${quota.providerId}`} className={compact ? 'usage-allowance' : 'usage-subscription'} aria-label={`${name} on ${hostName(host.hostId)}`}>
        <div className="usage-subscription__identity"><h3><ProviderMark provider={quota.providerId} name={name} size={20} />{name}</h3><p>{hostName(host.hostId)}</p>
          {compact ? <div className="usage-allowance__ring"><Ring percent={left} /><span><b>{left === undefined ? '—' : `${Math.round(left)}%`}</b><small>room left</small></span></div> : null}
          <p>{quotaAge(quota.observedAt, now)}</p>
          {quota.providerId === 'claude' ? <p>Updates when Claude Code reports limits.</p> : null}
        </div>
        {compact ? <><p className="usage-note">{known?.label ?? (quota.status === 'available' && quota.windows.length > 0 ? quota.windows.every(window => quotaExpired(window, now)) ? 'The previous reading expired.' : 'Percentage not reported.' : quotaUnavailable(quota))}</p>{quota.windows[0]?.resetsAt !== undefined ? <p className="usage-note">{resetCopy(known ?? quota.windows[0], now)}</p> : null}</> : <div className="usage-subscription__windows">
          {quota.status !== 'available' ? <p className="usage-note">{quotaUnavailable(quota)}{quota.windows.length > 0 ? ' The previous reading is shown below.' : ''}</p> : null}
          {quota.windows.length === 0 && quota.status === 'available' ? <p className="usage-note">The provider has not reported any limits.</p> : null}
          {quota.windows.map(window => {
            const expired = quotaExpired(window, now)
            const windowLeft = window.usedPercent === undefined ? undefined : Math.max(0, 100 - window.usedPercent)
            return <div className="usage-window" key={window.id} data-expired={expired || undefined}>
              <div className="usage-window__head"><span>{window.label}</span><span><b>{windowLeft === undefined ? '—' : `${Math.round(windowLeft)}%`}</b> {expired ? 'at last reading' : 'left'}</span></div>
              <div className="usage-window__track" aria-hidden="true"><i style={{ width: `${windowLeft ?? 0}%` }} /></div>
              <p>{resetCopy(window, now)}</p>
              <p>{window.usedPercent === undefined ? 'Percentage not reported. ' : window.usedPercent > 100 ? `${window.usedPercent}% used. ` : ''}{quotaAge(window.observedAt ?? quota.observedAt, now)}</p>
            </div>
          })}
        </div>}
      </section>
    })}
  </div>
}

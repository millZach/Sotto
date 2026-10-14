import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UsageBridge, UsageDashboardRead, UsageHostRead, UsageProviderId, UsageQuery } from '../../../../shared/usageDashboard'

/** Where no list of computers is known, one read stands for all of them. */
export const EVERY_HOST = '*'

export interface UsageReadState {
  /** Null until the first computer answers. */
  readonly read: UsageDashboardRead | null
  /** Computers still reading for the current filters. */
  readonly pending: readonly string[]
  /** Computers whose read failed in transit, by host ID ('*' when no list was known). */
  readonly failed: readonly string[]
  readonly loading: boolean
  /** Read these computers again, keeping what is on the page until they answer. */
  readonly reload: (hostIds?: readonly string[]) => void
  /** Put fresh limit readings in place without waiting for another read. */
  readonly applyQuotas: (result: UsageDashboardRead, providerIds: readonly UsageProviderId[]) => void
}

/**
 * Reads each computer on its own and paints it as it answers, so one slow computer never holds the others back.
 * New filters keep the old figures on the page until the first computer answers for the new ones, then start over;
 * a reload keeps every computer's figures until that computer answers again.
 */
export function useUsageRead(bridge: UsageBridge | undefined, targets: readonly string[], query: UsageQuery | null, connectionKey: string): UsageReadState {
  const [entries, setEntries] = useState<ReadonlyMap<string, UsageHostRead>>(() => new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [answered, setAnswered] = useState(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  const shownGeneration = useRef(-1)
  const latest = useRef(new Map<string, number>())
  const counter = useRef(0)
  const queryKey = query === null ? null : JSON.stringify(query)
  const context = useRef({ bridge, query, targets })
  context.current = { bridge, query, targets }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])

  const readOne = useCallback((target: string): void => {
    const { bridge: api, query: current } = context.current
    if (api === undefined || current === null) return
    const run = generation.current
    const token = ++counter.current
    latest.current.set(target, token)
    setPending(value => new Set(value).add(target))
    const fresh = (): boolean => mounted.current && run === generation.current && latest.current.get(target) === token
    const settle = (): void => setPending(value => { const next = new Set(value); next.delete(target); return next })
    // The first answer for new filters replaces what the old ones showed.
    const restart = (): boolean => { const first = shownGeneration.current !== run; shownGeneration.current = run; return first }
    api.read(target === EVERY_HOST ? current : { ...current, hostIds: [target] }).then(result => {
      if (!fresh()) return
      const first = restart()
      setEntries(value => {
        const next = new Map(first || target === EVERY_HOST ? [] : value)
        for (const host of result.hosts) next.set(host.hostId, host)
        return next
      })
      setFailed(value => { const next = new Set(value); next.delete(target); return next })
      setAnswered(true); settle()
    }, () => {
      if (!fresh()) return
      if (restart()) setEntries(new Map())
      setFailed(value => new Set(value).add(target)); settle()
    })
  }, [])

  const reload = useCallback((only?: readonly string[]): void => {
    const all = context.current.targets
    for (const target of only === undefined || all.includes(EVERY_HOST) ? all : only.filter(id => all.includes(id))) readOne(target)
  }, [readOne])

  const targetKey = targets.join('\n')
  // New filters or a new list of computers: read every one of them again.
  useEffect(() => {
    generation.current++
    latest.current.clear()
    setFailed(new Set()); setPending(new Set())
    if (queryKey === null || bridge === undefined) return
    for (const target of context.current.targets) readOne(target)
  }, [bridge, queryKey, targetKey, readOne])

  // A computer that reconnects is read again; nothing already shown is dropped.
  const seenConnections = useRef(connectionKey)
  useEffect(() => {
    if (seenConnections.current === connectionKey) return
    seenConnections.current = connectionKey
    reload()
  }, [connectionKey, reload])

  const applyQuotas = useCallback((result: UsageDashboardRead, providerIds: readonly UsageProviderId[]): void => {
    setEntries(value => {
      const next = new Map(value)
      for (const host of result.hosts) {
        const shown = next.get(host.hostId)
        if (shown === undefined) continue
        const fresh = host.quotas.filter(quota => providerIds.includes(quota.providerId))
        next.set(host.hostId, { ...shown, quotas: [...shown.quotas.filter(quota => !fresh.some(item => item.providerId === quota.providerId)), ...fresh] })
      }
      return next
    })
  }, [])

  const read = useMemo<UsageDashboardRead | null>(() => {
    if (!answered) return null
    const order = targetKey === EVERY_HOST ? [] : targetKey.split('\n')
    return { hosts: [...entries.values()].sort((a, b) => rank(order, a.hostId) - rank(order, b.hostId)) }
  }, [answered, entries, targetKey])

  return { read, pending: [...pending], failed: [...failed], loading: pending.size > 0, reload, applyQuotas }
}

const rank = (order: readonly string[], hostId: string): number => { const index = order.indexOf(hostId); return index < 0 ? order.length : index }

import { z } from 'zod'
import { hostForThread, isThreadProviderConnected, type AgentState, type AgentThread } from './agents'
import { isThreadClosed, isWorkspaceThreadSettled } from './threadActivity'

export const WATCHER_GROUPS = ['Needs you', 'Ready for review', 'Working', 'Landing', 'Quiet', 'Idle'] as const
export const watcherGroupSchema = z.enum(WATCHER_GROUPS)
export type WatcherGroup = z.infer<typeof watcherGroupSchema>
export const WATCHER_QUIET_MS = 20 * 60 * 1_000

/** Observation times belong to the observer, not to a provider's republished snapshot. */
export interface WatcherObservation {
  observedAt: string
  fresh: boolean
  /** Reset on reconnect; old progress alone cannot prove silence in a new session. */
  connectedAt?: string
  lastProgressAt?: string
  landing?: { source: 'user-landing-action' | 'github'; observedAt: string; fresh: boolean }
}
export interface WatcherOverviewRow {
  thread: AgentThread
  group: WatcherGroup
  available: boolean
  freshness: 'fresh' | 'stale' | 'unknown'
  observedAt?: string
}

/** The same projection can serve a roster and a sidebar without changing either reader's marks. */
export function watcherOverview(state: Pick<AgentState, 'host'>, now: number,
  observations: ReadonlyMap<string, WatcherObservation> = new Map()): WatcherOverviewRow[] {
  return state.host.threads.filter(thread => thread.kind !== 'watcher' && thread.kind !== 'watcher-history').map(thread => {
    const observation = observations.get(watcherObservationKey(thread))
    const available = thread.clientConnected !== false && hostForThread(state.host, thread).connected && isThreadProviderConnected(state.host, thread)
    const freshness = !available || observation?.fresh === false ? 'stale' : observation ? 'fresh' : 'unknown'
    let group: WatcherGroup = 'Idle'
    const project = state.host.projects.find(project => project.id === thread.projectId && project.hostId === thread.hostId)
    if (!isThreadClosed(thread)) {
      if (thread.requests.length || thread.status === 'error' || thread.lastTurn?.status === 'failed') group = 'Needs you'
      else if (!isWorkspaceThreadSettled(thread, project)) {
        const landingAt = Date.parse(observation?.landing?.observedAt ?? '')
        const landing = available && observation?.fresh && observation.landing?.fresh && Number.isFinite(landingAt) && landingAt <= now
        const openPr = thread.pullRequests?.some(pr => pr.state === 'open') || thread.worktree?.git?.pullRequest?.state === 'open'
        const active = thread.status === 'running' || Boolean(thread.backgroundWork?.length || thread.monitoring?.length)
        const connectedAt = Date.parse(observation?.connectedAt ?? '')
        const progressAt = Date.parse(observation?.lastProgressAt ?? '')
        const quietSince = Math.max(connectedAt, progressAt)
        if (landing) group = 'Landing'
        else if (openPr) group = 'Ready for review'
        else if (active && available && observation?.fresh && Number.isFinite(quietSince) && now - quietSince >= WATCHER_QUIET_MS) group = 'Quiet'
        else if (active) group = 'Working'
      }
    }
    return { thread, group, available, freshness, ...(observation ? { observedAt: observation.observedAt } : {}) }
  })
}

export function watcherObservationKey(thread: Pick<AgentThread, 'hostId' | 'id'>): string {
  return JSON.stringify([thread.hostId ?? null, thread.id])
}

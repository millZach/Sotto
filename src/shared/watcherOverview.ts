import { z } from 'zod'
import { hostForThread, isThreadProviderConnected, type AgentState, type AgentThread } from './agents'
import { isThreadClosed, isWorkspaceThreadSettled } from './threadActivity'

export const WATCHER_GROUPS = ['Needs you', 'Ready for review', 'Working', 'Landing', 'Quiet', 'Idle'] as const
export const watcherGroupSchema = z.enum(WATCHER_GROUPS)
export type WatcherGroup = z.infer<typeof watcherGroupSchema>
export const WATCHER_QUIET_MS = 20 * 60 * 1_000
/**
 * The idle clock (#1152, Zach's pick on November 13, 2026): how long a watched thread stays idle, its turn ended with its
 * work settled or waiting only on the user's card, before Watcher hears it is at rest. The same twenty minutes as quiet,
 * which is the working thread's. Each thread has its own clock, which starts when the thread goes idle and goes back to
 * zero when it works again.
 */
export const WATCHER_AT_REST_MS = WATCHER_QUIET_MS
/**
 * After the clock wakes Watcher, how long until it wakes it again for the same idle stretch: the clock starts again at
 * zero (Zach's pick on November 13, 2026, "Wake every 20 min while idle"). Null wakes it once per idle stretch.
 */
export const WATCHER_AT_REST_AGAIN_MS: number | null = WATCHER_AT_REST_MS

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

/**
 * Work that can go quiet: a running turn, provider-confirmed working sub-agents, background work or monitoring. Unknown
 * sub-agents keep a turn unsettled but do not alone prove work. The quiet wake and this grouping read the one rule.
 */
export function isWatcherWorkActive(thread: AgentThread): boolean {
  return thread.status === 'running' || thread.lastTurn?.status === 'running'
    || Boolean(thread.subagentSummary?.working || thread.backgroundWork?.length || thread.monitoring?.length)
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
      // A settled thread was put aside: only a question or permission still waits on the user there, not an error. A
      // prototype is never Needs you on its own (ADR-0108, November 6, 2026): the question card that links it asks the user.
      const settled = isWorkspaceThreadSettled(thread, project)
      if (thread.requests.length || !settled && (thread.status === 'error' || thread.lastTurn?.status === 'failed')) group = 'Needs you'
      else if (!settled) {
        const landingAt = Date.parse(observation?.landing?.observedAt ?? '')
        const landing = available && observation?.fresh && observation.landing?.fresh && Number.isFinite(landingAt) && landingAt <= now
        const openPr = thread.pullRequests?.some(pr => pr.state === 'open') || thread.worktree?.git?.pullRequest?.state === 'open'
        const active = isWatcherWorkActive(thread)
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

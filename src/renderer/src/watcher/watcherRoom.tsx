import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { parseHostEntityKey } from '../../../shared/clientIdentity'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../shared/watcherRoom'
import { useOptionalAgents } from '../agents/AgentContext'
import { useWatcherEnabled } from '../state/watcherFeature'

/** Why the room has no state to show: main has not answered yet, or this build offers no Watcher bridge. */
export type WatcherRoomStatus = 'loading' | 'ready' | 'unavailable'

/**
 * What the window knows of Watcher, read from main's projection: which thread is Watcher, which threads it
 * watches, and its limit. Thread IDs here are the window's own, so a row or a pane can ask by the ID it has.
 */
export interface WatcherRoom {
  readonly status: WatcherRoomStatus
  readonly state: WatcherRoomState | null
  /** Main's refusal or a failed read, in plain words; the room shows it where its content would be. */
  readonly error: string | null
  /** The thread that is the current Watcher, once main names it and the window has its row. */
  readonly currentThreadId: string | null
  readonly watchedThreadIds: ReadonlySet<string>
  readonly open: WatcherBridge['open'] | null
  readonly setLimit: WatcherBridge['setLimit'] | null
  /** Takes a result's state when main sent one and hands back the refusal's words, or null. */
  readonly settle: (result: WatcherRoomResult) => string | null
}

const WatcherRoomContext = createContext<WatcherRoom | null>(null)
const NONE: ReadonlySet<string> = new Set()
/** Apart from the room, so a memoised sidebar row re-renders only when who is watched changes. */
const WatchedThreadsContext = createContext<ReadonlySet<string>>(NONE)
const UNREADABLE = 'Sotto could not read Watcher. Nothing was changed. Reopen Sotto to try again.'

/** The window's row for a host's thread, whether this window keys threads by host or by their own IDs. */
export function threadForTarget(state: AgentState | null, target: WatcherThreadTarget): AgentThread | undefined {
  if (state === null) return undefined
  const localHostId = state.hostId ?? state.host.hostId
  return state.host.threads.find(thread => {
    const key = parseHostEntityKey(thread.id)
    if (key !== null) return key.hostId === target.hostId && key.id === target.threadId
    return thread.id === target.threadId && (thread.hostId ?? localHostId ?? target.hostId) === target.hostId
  })
}

/** A thread is watched while it takes part in an active Watcher request and the user has not taken it over. */
export function watchedTargets(room: WatcherRoomState): WatcherThreadTarget[] {
  const active = new Map(room.requests.map(request => [request.id, request.state === 'active'] as const))
  return room.watchedThreads.filter(entry => entry.participation.some(part => part.state === 'participating' && active.get(part.requestId) !== false))
    .map(entry => entry.target)
}

/** The newer of two projections; an answer to `get` can arrive after a change main published later. */
function newer(current: WatcherRoomState | null, next: WatcherRoomState): WatcherRoomState {
  return current !== null && Date.parse(current.observedAt) > Date.parse(next.observedAt) ? current : next
}

/**
 * Reads Watcher's projection from main while the Watcher gate is on, and nothing at all while it is off: no
 * read, no subscription, and every consumer sees `null`. `bridge` is the preload's, or a test's stand-in.
 */
export function WatcherRoomProvider({ bridge, children }: { readonly bridge?: WatcherBridge | undefined; readonly children: ReactNode }): ReactNode {
  const enabled = useWatcherEnabled()
  const agents = useOptionalAgents()
  const agentState = agents?.state ?? null
  const [state, setState] = useState<WatcherRoomState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const live = enabled && bridge !== undefined
  useEffect(() => {
    if (!live) return
    let active = true
    const unsubscribe = bridge.onChanged(next => { if (active) { setState(current => newer(current, next)); setError(null); setAnswered(true) } })
    void bridge.get().then(result => {
      if (!active) return
      setAnswered(true)
      if (result.status === 'ok') { setState(current => newer(current, result.state)); setError(null) } else setError(result.message)
    }, () => { if (active) { setAnswered(true); setError(UNREADABLE) } })
    return () => { active = false; unsubscribe() }
  }, [live, bridge])
  const settle = useCallback((result: WatcherRoomResult): string | null => {
    if (result.status === 'ok') { setState(current => newer(current, result.state)); setError(null); return null }
    return result.message
  }, [])
  const current = state?.current ?? null
  const currentThreadId = current === null ? null : threadForTarget(agentState, current.target)?.id ?? null
  const watchedKey = state === null || agentState === null ? '' : JSON.stringify(watchedTargets(state).map(target => threadForTarget(agentState, target)?.id).filter(Boolean))
  const watchedThreadIds = useMemo<ReadonlySet<string>>(() => watchedKey === '' ? NONE : new Set(JSON.parse(watchedKey) as string[]), [watchedKey])
  const value = useMemo<WatcherRoom | null>(() => !enabled ? null : {
    status: !live ? 'unavailable' : answered ? 'ready' : 'loading',
    state, error, currentThreadId, watchedThreadIds, settle,
    open: live ? request => bridge.open(request) : null,
    setLimit: live ? request => bridge.setLimit(request) : null,
  }, [enabled, live, answered, state, error, currentThreadId, watchedThreadIds, settle, bridge])
  return <WatcherRoomContext.Provider value={value}>
    <WatchedThreadsContext.Provider value={enabled ? watchedThreadIds : NONE}>{children}</WatchedThreadsContext.Provider>
  </WatcherRoomContext.Provider>
}

/** Watcher's room state, or null while the gate is off. */
export function useWatcherRoom(): WatcherRoom | null {
  return useContext(WatcherRoomContext)
}

/** Whether Watcher watches this thread right now. Always false with the gate off. */
export function useWatchedThread(threadId: string): boolean {
  return useContext(WatchedThreadsContext).has(threadId)
}

/** The window's ID for the current Watcher, which the Threads page leaves to Watcher's room. */
export function useRoomWatcherThreadId(): string | null {
  return useContext(WatcherRoomContext)?.currentThreadId ?? null
}

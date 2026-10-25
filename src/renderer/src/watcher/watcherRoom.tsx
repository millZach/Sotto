import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { parseHostEntityKey } from '../../../shared/clientIdentity'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import { isWatchedRow, newerWatcherRoom, type WatcherBridge, type WatcherContinueHandoverRequest, type WatcherHandoverRead, type WatcherMergeTurnsRead, type WatcherRoomResult, type WatcherRoomState } from '../../../shared/watcherRoom'
import { useOptionalAgents } from '../agents/AgentContext'
import type { LaterWords } from '../features/settings/laterWords'
import { useWatcherEnabled } from '../state/watcherFeature'
import { firstMessage, useFirstMessageDelivery } from './watcherFirstMessage'
import { watchNotices } from './watchNotice'

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
  readonly error: LaterWords | null
  /** The thread that is the current Watcher, once main names it and the window has its row. */
  readonly currentThreadId: string | null
  readonly watchedThreadIds: ReadonlySet<string>
  readonly open: WatcherBridge['open'] | null
  /** What Watcher may do without asking; null where the bridge cannot change it, and the room says it as a fact. */
  readonly setPermission: NonNullable<WatcherBridge['setPermission']> | null
  /** Watch and Stop watching; null where the bridge offers neither, and no thread offers the owl as a control. */
  readonly watchThread: NonNullable<WatcherBridge['watchThread']> | null
  readonly unwatchThread: NonNullable<WatcherBridge['unwatchThread']> | null
  /** The handover after a provider change or New Watcher (ADR-0073): read it, continue with it, or put it away. Null where the bridge offers none. */
  readonly handover: WatcherHandoverCalls | null
  /** New Watcher: a new Watcher on the current one's own choices, with the last one's handover offered. Null where the bridge offers none. */
  readonly startNew: (() => Promise<WatcherRoomResult>) | null
  /** Takes a result's state when main sent one and hands back the refusal's words, or null. */
  readonly settle: (result: WatcherRoomResult) => string | null
  /** Stop all: main's preview of what it would stop, then the stop that preview confirms. Null without a bridge. */
  readonly stopAll: { readonly prepare: WatcherBridge['prepareStopAll']; readonly stop: WatcherBridge['stopAll'] } | null
  /** The merge queue and merge turns for Watcher's picture (#1339), read only while it shows. Null where the bridge offers none. */
  readonly readMergeTurns: (() => Promise<WatcherMergeTurnsRead>) | null
}

/** The bridge's three handover calls, together or not at all. */
export interface WatcherHandoverCalls {
  readonly read: () => Promise<WatcherHandoverRead>
  readonly continueWith: (request: WatcherContinueHandoverRequest) => Promise<WatcherRoomResult>
  readonly dismiss: () => Promise<WatcherRoomResult>
}

/**
 * Watch and Stop watching (Zach's pick on October 13, 2026, watch B): a press acts at once, asks nothing first, and the
 * toast says what it did, with Undo, or main's refusal in its own words. Stable for the room's life, so the memoised
 * sidebar rows that hold the owl toggle do not redraw when anything else in the room changes.
 */
export interface WatchActions {
  /** By the owning host's address, for a watched thread this window may not list. */
  readonly set: (target: WatcherThreadTarget, title: string, watched: boolean) => Promise<void>
  /** By this window's thread ID. */
  readonly setThread: (threadId: string, watched: boolean) => Promise<void>
}

const WatcherRoomContext = createContext<WatcherRoom | null>(null)
const NONE: ReadonlySet<string> = new Set()
/** Apart from the room, so a memoised sidebar row re-renders only when who is watched changes. */
const WatchedThreadsContext = createContext<ReadonlySet<string>>(NONE)
const WatchActionsContext = createContext<WatchActions | null>(null)
const UNREADABLE = msg`Sotto could not read Watcher. Nothing was changed. Reopen Sotto to try again.`

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

/**
 * This window's thread IDs by their owning host's address: what threadForTarget finds, from one pass over the threads
 * instead of a search per address. The room resolves every watched thread on each update, and with hundreds of them a
 * search apiece was most of the work while a thread streamed. The first thread that would match wins, as
 * with threadForTarget; one whose host this window cannot name answers for any host.
 */
export function threadAddressIndex(state: AgentState | null): (target: WatcherThreadTarget) => string | undefined {
  if (state === null) return () => undefined
  const localHostId = state.hostId ?? state.host.hostId
  const exact = new Map<string, { readonly id: string; readonly at: number }>()
  const anyHost = new Map<string, { readonly id: string; readonly at: number }>()
  for (const [at, thread] of state.host.threads.entries()) {
    const key = parseHostEntityKey(thread.id)
    const hostId = key !== null ? key.hostId : thread.hostId ?? localHostId
    const map = hostId === undefined ? anyHost : exact
    const slot = hostId === undefined ? key?.id ?? thread.id : JSON.stringify([hostId, key?.id ?? thread.id])
    if (!map.has(slot)) map.set(slot, { id: thread.id, at })
  }
  return target => {
    const found = exact.get(JSON.stringify([target.hostId, target.threadId])), loose = anyHost.get(target.threadId)
    return found === undefined ? loose?.id : loose === undefined || found.at < loose.at ? found.id : loose.id
  }
}
/** The owning host's address for a thread in this window, whichever way the window keys its threads. */
export function targetForThread(state: AgentState, thread: AgentThread): WatcherThreadTarget | null {
  const key = parseHostEntityKey(thread.id)
  if (key !== null) return { hostId: key.hostId, threadId: key.id }
  const hostId = thread.hostId ?? state.hostId ?? state.host.hostId
  return hostId ? { hostId, threadId: thread.id } : null
}

/**
 * The threads Watcher watches, by main's `watched` mark: under a standing watch, or taking part in an active Watcher
 * request. The iPhone's projection reads the same mark, so the room, the Threads page and the phone agree.
 */
export function watchedRows(room: WatcherRoomState): WatcherRoomState['watchedThreads'] {
  return room.watchedThreads.filter(entry => isWatchedRow(entry, room.requests))
}
/**
 * Whether a thread is under a standing watch, which lasts until the user stops it. A thread watched only because it takes
 * part in a Watcher request is not: the user's own send there takes it over and it stops being watched.
 */
export function hasStandingWatch(room: WatcherRoomState, target: WatcherThreadTarget): boolean {
  return room.standingWatches?.some(watch => watch.target.hostId === target.hostId && watch.target.threadId === target.threadId) === true
}
export function watchedTargets(room: WatcherRoomState): WatcherThreadTarget[] {
  return watchedRows(room).map(entry => entry.target)
}

/** The newer of two projections; an answer to `get` or a command can arrive after a change main published later. */
const newer = newerWatcherRoom

/**
 * Reads Watcher's projection from main while the Watcher gate is on, and nothing at all while it is off: no
 * read, no subscription, and every consumer sees `null`. `bridge` is the preload's, or a test's stand-in. It also
 * delivers the first entry's message once Watcher exists, since it stays mounted when the room does not.
 */
export function WatcherRoomProvider({ bridge, children }: { readonly bridge?: WatcherBridge | undefined; readonly children: ReactNode }): ReactNode {
  const enabled = useWatcherEnabled()
  const agents = useOptionalAgents()
  const agentState = agents?.state ?? null
  const [state, setState] = useState<WatcherRoomState | null>(null)
  const [error, setError] = useState<LaterWords | null>(null)
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
  // One index per thread list: every address below is a lookup, not a search through the threads.
  const threads = agentState?.host.threads, stateHostId = agentState?.hostId, hostHostId = agentState?.host.hostId
  const idOf = useMemo(() => threadAddressIndex(agentState), [threads, stateHostId, hostHostId])
  const currentThreadId = current === null ? null : idOf(current.target) ?? null
  const watchedKey = state === null || agentState === null ? '' : JSON.stringify(watchedTargets(state).map(idOf).filter(Boolean))
  const watchedThreadIds = useMemo<ReadonlySet<string>>(() => watchedKey === '' ? NONE : new Set(JSON.parse(watchedKey) as string[]), [watchedKey])
  // A first message sent before Watcher existed goes to it from here, so leaving the room cannot lose it.
  useFirstMessageDelivery(enabled ? agents : null, currentThreadId)
  // A first message read back after a reload as started, when main then says there is no Watcher, goes back to the composer.
  const noWatcher = live && answered && state !== null && state.current === null
  useEffect(() => { if (noWatcher) firstMessage.noWatcher() }, [noWatcher])
  // The contract keeps these three optional for stand-ins written before them, so the room asks before offering them.
  // Main's own preload supplies all three.
  const manage = useMemo(() => {
    const { setPermission, watchThread, unwatchThread, readHandover, continueWithHandover, dismissHandover, startNew, readMergeTurns } = live && bridge !== undefined ? bridge : {} as Partial<WatcherBridge>
    return {
      startNew: startNew === undefined ? null : () => startNew.call(bridge),
      readMergeTurns: readMergeTurns === undefined ? null : () => readMergeTurns.call(bridge),
      setPermission: setPermission === undefined ? null : (request: Parameters<typeof setPermission>[0]) => setPermission.call(bridge, request),
      handover: readHandover === undefined || continueWithHandover === undefined || dismissHandover === undefined ? null : {
        read: () => readHandover.call(bridge),
        continueWith: (request: WatcherContinueHandoverRequest) => continueWithHandover.call(bridge, request),
        dismiss: () => dismissHandover.call(bridge),
      } satisfies WatcherHandoverCalls,
      watch: watchThread === undefined || unwatchThread === undefined ? null : {
        watchThread: (request: Parameters<typeof watchThread>[0]) => watchThread.call(bridge, request),
        unwatchThread: (request: Parameters<typeof unwatchThread>[0]) => unwatchThread.call(bridge, request),
      },
    }
  }, [live, bridge])
  const latest = useRef(agentState)
  useEffect(() => { latest.current = agentState })
  const actions = useMemo<WatchActions | null>(() => {
    const watch = manage.watch
    if (!enabled || watch === null) return null
    const set = async (target: WatcherThreadTarget, title: string, watched: boolean): Promise<void> => {
      let refusal: LaterWords | null
      try {
        refusal = settle(await (watched ? watch.watchThread({ target }) : watch.unwatchThread({ target })))
      } catch {
        refusal = watched ? msg`Sotto could not reach Watcher, so ${title} is not watched. Try again.` : msg`Sotto could not reach Watcher, so ${title} is still watched. Try again.`
      }
      watchNotices.show({ target, title, watched, refusal })
    }
    return {
      set,
      setThread: async (threadId, watched) => {
        const agents = latest.current
        const thread = agents?.host.threads.find(item => item.id === threadId)
        const target = agents == null || thread === undefined ? null : targetForThread(agents, thread)
        if (thread !== undefined && target !== null) await set(target, thread.title, watched)
      },
    }
  }, [enabled, manage, settle])
  const value = useMemo<WatcherRoom | null>(() => !enabled ? null : {
    status: !live ? 'unavailable' : answered ? 'ready' : 'loading',
    state, error, currentThreadId, watchedThreadIds, settle,
    open: live ? request => bridge.open(request) : null,
    setPermission: manage.setPermission,
    watchThread: manage.watch?.watchThread ?? null,
    unwatchThread: manage.watch?.unwatchThread ?? null,
    handover: manage.handover,
    startNew: manage.startNew,
    readMergeTurns: manage.readMergeTurns,
    stopAll: live ? { prepare: () => bridge.prepareStopAll(), stop: request => bridge.stopAll(request) } : null,
  }, [enabled, live, answered, state, error, currentThreadId, watchedThreadIds, settle, bridge, manage])
  return <WatcherRoomContext.Provider value={value}>
    <WatchedThreadsContext.Provider value={enabled ? watchedThreadIds : NONE}>
      <WatchActionsContext.Provider value={actions}>{children}</WatchActionsContext.Provider>
    </WatchedThreadsContext.Provider>
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

/** Watch and Stop watching, or null with the gate off or where the bridge offers neither. */
export function useWatchActions(): WatchActions | null {
  return useContext(WatchActionsContext)
}

/** The window's ID for the current Watcher, which the Threads page leaves to Watcher's room. */
export function useRoomWatcherThreadId(): string | null {
  return useContext(WatcherRoomContext)?.currentThreadId ?? null
}

import { useEffect, useSyncExternalStore } from 'react'
import type { AgentThread } from '../../../shared/agents'
import { useAgents } from './AgentContext'

/**
 * Threads that finished while nothing showed them. It is about what you have seen, not about the thread, so it
 * lives here rather than in the state main publishes: a thread on screen never earns the mark, coming on screen
 * clears it, and a restart forgets it. The sidebar is mounted afresh on every page and absent on Settings and
 * Chats, so the record is kept outside it and fed by a watch that stays mounted for as long as the window is.
 */
let working: ReadonlySet<string> = new Set()
let unseen: ReadonlySet<string> = new Set()
let onScreen: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function publish(next: ReadonlySet<string>): void {
  if (next.size === unseen.size && [...next].every(id => unseen.has(id))) return
  unseen = next
  for (const listener of listeners) listener()
}

/** Note which threads are running now: one that was running and is idle out of sight earns the mark. */
export function watchThreads(threads: readonly AgentThread[]): void {
  const live = new Set(threads.filter(thread => thread.status === 'running').map(thread => thread.id))
  const stopped = [...working].filter(id => !live.has(id))
  working = live
  // The mark lasts only while the thread is still finished, still known, and still out of sight.
  const finishedUnseen = (id: string): boolean => !onScreen.has(id) && threads.some(thread => thread.id === id && thread.status === 'idle')
  publish(new Set([...unseen, ...stopped].filter(finishedUnseen)))
}

/** Which threads are on screen now: those lose the mark and cannot earn it. Once the list is gone, none are. */
export function showThreads(ids: readonly string[]): void {
  onScreen = new Set(ids)
  publish(new Set([...unseen].filter(id => !onScreen.has(id))))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The threads that finished out of sight, kept current as they finish or come on screen. */
export function useFinishedUnseen(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => unseen)
}

/** Keeps the record from the published state for as long as it is mounted; seated once inside the agent provider. */
export function FinishedThreadWatch(): null {
  const { state } = useAgents()
  const threads = state?.host.threads
  // While main has no state to publish the record stands as it was, the way the sidebar's absence leaves it.
  useEffect(() => { if (threads !== undefined) watchThreads(threads) }, [threads])
  return null
}

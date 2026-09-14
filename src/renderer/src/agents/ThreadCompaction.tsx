import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AgentCommand, AgentThread } from '../../../shared/agents'
import { compactionPending } from '../../../shared/compaction'
import { Button } from '../components/Button'
import './threadCompaction.css'

const AGE = 70 * 60_000
// T3 retains every (thread, context snapshot) dismissal for the renderer session.
// Keep these across pane remounts, but never persist them across app restarts.
const dismissedSnapshots = new Set<string>()
const dismissalListeners = new Set<() => void>()
const subscribeDismissals = (listener: () => void): (() => void) => {
  dismissalListeners.add(listener)
  return () => { dismissalListeners.delete(listener) }
}
/** Recommendations describe context age and size, never inferred cache expiry. */
export function ThreadCompaction({ thread, supported, connected, command, blocked = false }: {
  readonly thread: AgentThread; readonly supported: boolean; readonly connected: boolean
  readonly command: (command: AgentCommand) => unknown; readonly blocked?: boolean
}): ReactNode {
  const [now, setNow] = useState(Date.now)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const sending = useRef(false)
  const usage = thread.usage
  const snapshot = JSON.stringify([thread.id, usage?.contextUpdatedAt])
  const dismissed = useSyncExternalStore(subscribeDismissals, () => dismissedSnapshots.has(snapshot))
  const eligibleAt = Date.parse(usage?.contextUpdatedAt ?? '') + AGE
  useEffect(() => {
    if (!Number.isFinite(eligibleAt) || eligibleAt <= Date.now()) { setNow(Date.now()); return }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(eligibleAt - Date.now(), 2_147_483_647))
    return () => clearTimeout(timer)
  }, [eligibleAt])
  const busy = blocked || submitting || compactionPending(thread.compaction) || thread.status === 'running' || !!thread.requests.length
    || !thread.messages.some(message => message.role === 'user' && !/^\/compact(?:\s|$)/u.test(message.text.trim()))
  const offer = supported && connected && !busy && !thread.resumeCompactionDismissed && thread.providerId === 'claude'
    && (usage?.modelId === undefined || usage.modelId === thread.modelId) && (usage?.contextUsed ?? 0) >= 100_000
    && now >= eligibleAt && !dismissed
  const compact = async (): Promise<void> => {
    if (sending.current || busy || !connected) return
    sending.current = true; setSubmitting(true); setError('')
    try { await command({ type: 'compact-thread', threadId: thread.id }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Native compaction could not start.') }
    finally { sending.current = false; setSubmitting(false) }
  }
  if (!supported) return null
  return <div className="thread-compaction">
    {offer ? <><p>This context is large and hasn’t been updated for over an hour.</p>
      <Button variant="secondary" onClick={() => void compact()}>Compact</Button>
      <Button variant="ghost" onClick={() => { dismissedSnapshots.add(snapshot); for (const listener of dismissalListeners) listener() }}>Keep full history</Button></>
      : <Button variant="ghost" disabled={!connected || busy || thread.nativeSessionStarted === false} onClick={() => void compact()}>Compact context</Button>}
    {thread.compaction ? <p role="status">{thread.compaction.status === 'completed' ? 'Context compacted' : thread.compaction.status === 'running' ? 'Compacting context…'
      : thread.compaction.error ?? (thread.compaction.status === 'failed' ? 'Native compaction failed.' : 'Native compaction is unconfirmed. Reconnect to observe its result.')}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>
}

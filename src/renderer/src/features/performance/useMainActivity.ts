import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type { MainActivityBridge, MainActivityCommand, MainActivityState } from '../../../../shared/mainActivity'
import { setNewThreadIntent } from '../../agents/threadIntent'
import { activityRecordingDraft } from '../../../../shared/mainActivity'

/** How often an open popover or Settings > Performance asks main for fresh numbers. Nothing asks while neither shows. */
export const LIVE_READ_MS = 1_000

/**
 * Main's watch on itself, as the window sees it (ADR-0097). Main says when the notice's answer changes; while `live`
 * (the popover or Settings > Performance is open) the window also reads the numbers once a second for the chart.
 */
export function useMainActivity(live: boolean, bridge: MainActivityBridge | undefined = window.sotto?.mainActivity): MainActivityState | null {
  const [state, setState] = useState<MainActivityState | null>(null)
  useEffect(() => {
    if (!bridge) return
    let current = true
    void bridge.read().then(next => { if (current) setState(next) }, () => undefined)
    const off = bridge.onChanged(next => { if (current) setState(next) })
    return () => { current = false; off() }
  }, [bridge])
  useEffect(() => {
    if (!bridge || !live) return
    let current = true
    const read = (): void => { void bridge.read().then(next => { if (current) setState(next) }, () => undefined) }
    read()
    const timer = window.setInterval(read, LIVE_READ_MS)
    return () => { current = false; window.clearInterval(timer) }
  }, [bridge, live])
  return state
}

/** One press, answered with main's new state; a refused press leaves the state as it was. */
export function useMainActivityCommand(bridge: MainActivityBridge | undefined = window.sotto?.mainActivity): (command: MainActivityCommand) => Promise<MainActivityState | null> {
  return useCallback(async command => bridge ? bridge.command(command).catch(() => null) : null, [bridge])
}

/** Seconds left in a running recording, counted on the window's own clock against main's start time. */
export function useSecondsLeft(startedAt: number | null, durationMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return 0
  return Math.max(0, Math.ceil((startedAt + durationMs - now) / 1_000))
}

// Which saved recording has been attached to a new thread, shared by the notice and Settings so both say so.
let attachedName: string | null = null
const attachedListeners = new Set<() => void>()
function subscribeAttached(listener: () => void): () => void { attachedListeners.add(listener); return () => { attachedListeners.delete(listener) } }

export function useAttachedRecording(): string | null {
  return useSyncExternalStore(subscribeAttached, () => attachedName, () => null)
}

/**
 * Attach to a thread (Zach's pick): a new thread opens on the Threads page with the recording named in its composer,
 * unsent. A thread on this computer can read the files where they are, so the new thread goes in the current project
 * when that project is on this computer, and the project chooser opens otherwise.
 */
export function attachRecordingToNewThread(recording: { readonly name: string; readonly folder: string; readonly files: readonly string[] },
  localProjectId: string | undefined, go: () => void): void {
  setNewThreadIntent({ projectId: localProjectId, carried: { text: activityRecordingDraft(recording.folder, recording.files), attachments: [], threadId: null } })
  attachedName = recording.name
  for (const listener of attachedListeners) listener()
  go()
}

/** File sizes as people say them. */
export function recordingSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

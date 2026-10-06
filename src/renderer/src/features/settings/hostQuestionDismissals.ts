import { useSyncExternalStore } from 'react'
import type { HostsBridge, HostStatus } from '../../../../shared/hosts'

/** Dismissal belongs to this window's connection, shared by the dialog and saved-host rows. */
function createDismissals() {
  let keys: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const answerTargets = new Map<string, () => void>()
  const change = (key: string, dismissed: boolean): void => {
    const next = new Set(keys)
    if (dismissed) next.add(key); else next.delete(key)
    keys = next
    for (const listener of listeners) listener()
  }
  return {
    snapshot: () => keys,
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dismiss: (key: string) => change(key, true),
    resume: (key: string) => change(key, false),
    registerAnswerTarget: (key: string, focus: () => void): (() => void) => {
      answerTargets.set(key, focus)
      return () => { answerTargets.delete(key) }
    },
    focusAnswer: (key: string): void => { answerTargets.get(key)?.() },
  }
}

const connections = new WeakMap<HostsBridge, ReturnType<typeof createDismissals>>()
const unavailable = createDismissals()

export function hostQuestionKey(host: HostStatus): string | null {
  return host.prompt ? `prompt:${host.id}:${host.prompt.id}` : null
}

export function useHostQuestionDismissals(bridge: HostsBridge | undefined) {
  let store = bridge ? connections.get(bridge) : unavailable
  if (!store) { store = createDismissals(); connections.set(bridge!, store) }
  const dismissedQuestionKeys = useSyncExternalStore(store.subscribe, store.snapshot)
  return { dismissedQuestionKeys, dismissQuestion: store.dismiss, resumeQuestion: store.resume, registerAnswerTarget: store.registerAnswerTarget, focusAnswer: store.focusAnswer }
}

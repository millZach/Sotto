import { useSyncExternalStore } from 'react'
import type { NextPromptBridge, NextPromptEntry } from '../../../shared/nextPrompt'

/**
 * The next prompts main holds for this computer's threads (ADR-0131), as the window last heard them. Main tells each change;
 * a window that has just loaded reads them all once. A send here lets go of its thread's at once, and a late delivery for
 * the turn that send answered is dropped, so a suggestion never comes back after the user moved on.
 */
export class NextPromptStore {
  private readonly entries = new Map<string, NextPromptEntry>()
  /** The turn each thread's last send here answered, by its newest user message then. */
  private readonly sentAfter = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private connected: NextPromptBridge | null = null

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(threadId: string): NextPromptEntry | undefined { return this.entries.get(threadId) }

  /** Hears main once per bridge; asking again changes nothing. */
  connect(bridge: NextPromptBridge | undefined): void {
    if (!bridge || this.connected === bridge) return
    this.connected = bridge
    bridge.onChanged(entry => this.apply(entry))
    void bridge.read().then(entries => { for (const entry of entries) this.apply(entry) }, () => undefined)
  }

  apply(entry: NextPromptEntry): void {
    if (entry.prompt === null) {
      if (this.entries.get(entry.threadId)?.afterUserMessageId !== entry.afterUserMessageId) return
      this.entries.delete(entry.threadId)
    } else {
      if (this.sentAfter.get(entry.threadId) === entry.afterUserMessageId) return
      this.entries.set(entry.threadId, entry)
    }
    this.emit()
  }

  /**
   * The user sent this thread something after the turn whose newest user message is `afterUserMessageId`: what was
   * suggested for that turn is over, including a suggestion still on its way.
   */
  sent(threadId: string, afterUserMessageId: string): void {
    this.sentAfter.set(threadId, afterUserMessageId)
    if (!this.entries.delete(threadId)) return
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

export const nextPromptStore = new NextPromptStore()

/** One thread's next prompt, or undefined; with a null thread nothing is read and main is not asked. */
export function useNextPrompt(threadId: string | null, store: NextPromptStore = nextPromptStore): NextPromptEntry | undefined {
  if (threadId !== null) store.connect(typeof window === 'undefined' ? undefined : window.sotto?.nextPrompt)
  return useSyncExternalStore(store.subscribe, () => threadId === null ? undefined : store.get(threadId))
}

import { parseHostEntityKey } from '../../shared/clientIdentity'

/**
 * Watcher talks only to parent threads (#1217; Zach's rule of October 20, 2026, and his picks of November 7, ADR-0081).
 * A thread another thread delegated to is that thread's to brief, stop and settle, so Watcher directs the thread that
 * delegated it and never the delegated thread itself: no send, stop, settle, restore or watch. It may still read it. The
 * rule binds Watcher alone; the user stays free to type in a delegated thread.
 */

/** What Watcher was asked to do to a delegated thread, which names what its refusal says did not happen. */
export type DelegatedAction = 'send' | 'stop' | 'settle' | 'restore' | 'watch'

/** The thread that delegated to another, as Watcher names threads. `hostId` is left out where its link names no machine. */
export interface DelegatingThread { readonly hostId?: string; readonly threadId: string }

const RELAY_CALLER = /^relay:[^:]+:([\s\S]+)$/u

/**
 * The thread that delegated to a thread on `hostId`, from that thread's `delegatedBy` link as its own machine keeps it
 * (`delegatingKey` in src/shared/clientIdentity.ts): a thread ID on the same machine; `host:<hostId>:<threadId>` for one on
 * another machine the desktop relay started it for; or `relay:<client>:<caller>` for one a desktop asked for, whose caller
 * is that key or, for the desktop's own thread, its bare ID, which names no machine.
 */
export function delegatingThread(delegatedBy: string, hostId: string): DelegatingThread {
  const keyed = parseHostEntityKey(delegatedBy)
  if (keyed) return { hostId: keyed.hostId, threadId: keyed.id }
  const relay = RELAY_CALLER.exec(delegatedBy)
  if (!relay) return { hostId, threadId: delegatedBy }
  const caller = parseHostEntityKey(relay[1]!)
  return caller ? { hostId: caller.hostId, threadId: caller.id } : { threadId: relay[1]! }
}

const NOTHING: Record<DelegatedAction, string> = {
  send: 'Nothing was sent.', stop: 'Nothing was stopped.', settle: 'Nothing was settled.', restore: 'Nothing was changed.', watch: 'Nothing was watched.',
}

/**
 * Watcher's refusal for a delegated thread: what the thread is, the thread to direct instead by its ID and, where listed,
 * its title, that reading is still open, and that nothing happened.
 */
export function delegatedRefusalWords(parent: DelegatingThread, title: string | undefined, action: DelegatedAction): string {
  const named = title ? `“${title}”, ` : ''
  const where = parent.hostId ? `hostId ${parent.hostId}` : 'on another computer'
  return `This thread is another thread’s delegated worker, and only the thread that delegated it directs it. Direct that thread instead: ${named}threadId ${parent.threadId}, ${where}. You can still read this one. ${NOTHING[action]}`
}

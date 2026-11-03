import { createContext, useContext } from 'react'
import type { AgentThread } from '../../../../shared/agents'
import { isThreadClosed } from '../../../../shared/threadActivity'

/** What Ask the Council on a reply hands the Council page: the thread it comes from and the question to start with. */
export interface CouncilDraft { readonly originThread: string; readonly question: string }

let offered: CouncilDraft | null = null

/** Left for the Council page to open with; the next draft replaces it. */
export function offerCouncilDraft(draft: CouncilDraft): void { offered = draft }
/** The draft waiting for the Council page, read without clearing it, since a strict render reads twice. */
export function readCouncilDraft(): CouncilDraft | null { return offered }
export function clearCouncilDraft(): void { offered = null }

/** The reply's text as the question: quoted, line by line. */
export function quotedReply(text: string): string { return text.trim().split('\n').map(line => line ? `> ${line}` : '>').join('\n') }

/** Opens the Council page with a reply of this thread as its question, or nothing: the Council is off or can't start here. */
export const CouncilAskContext = createContext<((text: string) => void) | null>(null)
export function useCouncilAsk(): ((text: string) => void) | null { return useContext(CouncilAskContext) }

/** A thread the Council can start from: an ordinary thread on this computer, open, not one another thread started. */
export function councilAskable(thread: AgentThread, localHostId: string | undefined): boolean {
  return thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && thread.remoteHost !== true && (thread.hostId === undefined || thread.hostId === localHostId)
    && thread.delegatedBy === undefined && !isThreadClosed(thread)
}

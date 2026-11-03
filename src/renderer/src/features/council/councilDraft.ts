import { createContext, useContext } from 'react'
import type { AgentThread } from '../../../../shared/agents'
import { isThreadClosed } from '../../../../shared/threadActivity'
import { COUNCIL_QUESTION_MAX } from '../../../../shared/council'
import { paneTerminalChromeStore, type PaneTerminalChromeStore } from '../../tools/paneTerminalStore'
import type { CouncilPanel } from './CouncilSeats'

/** What Ask the Council on a reply hands the Council tab: the thread it comes from and the question to start with. */
export interface CouncilDraft { readonly originThread: string; readonly question: string }

let offered: CouncilDraft | null = null
const listeners = new Set<() => void>()

/** Left for the Council tab of its thread's pane to take, open already or opening; the next draft replaces it. */
export function offerCouncilDraft(draft: CouncilDraft): void {
  offered = draft
  for (const listener of [...listeners]) listener()
}
/** The draft waiting for the Council tab, read without clearing it, since a strict render reads twice. */
export function readCouncilDraft(): CouncilDraft | null { return offered }
export function clearCouncilDraft(): void { offered = null }
/** Tells an open Council tab that a draft was offered after it opened. */
export function onCouncilDraft(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * What a pane's Council tab holds while the drawer shows a shell or is hidden, so it comes back as it was left: the
 * question, the seats changed for this Council, and the thread chosen in From, if the user chose one.
 */
export interface CouncilForm { readonly question: string; readonly panel: CouncilPanel | null; readonly origin: string | null }
const forms = new Map<string, CouncilForm>()
export function heldCouncilForm(thread: string): CouncilForm | undefined { return forms.get(thread) }
export function holdCouncilForm(thread: string, form: CouncilForm): void {
  if (!form.question && form.panel === null && form.origin === null) forms.delete(thread)
  else forms.set(thread, form)
}

/** Ask the Council on a reply: offers the draft and opens the Council tab of the drawer in the pane of the thread it comes from. */
export function openCouncilDraft(draft: CouncilDraft, chromeStore: PaneTerminalChromeStore = paneTerminalChromeStore): void {
  offerCouncilDraft(draft)
  chromeStore.show(draft.originThread, 'council')
}

/** The reply's text as the question: quoted, line by line, and cut to the longest question main takes. */
export function quotedReply(text: string): string { return text.trim().split('\n').map(line => line ? `> ${line}` : '>').join('\n').slice(0, COUNCIL_QUESTION_MAX) }

/** Opens the Council tab with a reply of this thread as its question, or nothing: the Council is off or can't start here. */
export const CouncilAskContext = createContext<((text: string) => void) | null>(null)
export function useCouncilAsk(): ((text: string) => void) | null { return useContext(CouncilAskContext) }

/** A thread the Council can start from: an ordinary thread on this computer, open, not one another thread started. */
export function councilAskable(thread: AgentThread, localHostId: string | undefined): boolean {
  return thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && thread.remoteHost !== true && (thread.hostId === undefined || thread.hostId === localHostId)
    && thread.delegatedBy === undefined && !isThreadClosed(thread)
}

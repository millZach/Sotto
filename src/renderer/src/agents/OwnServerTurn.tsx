import React, { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'
import { RotateCcw, Settings2 } from 'lucide-react'
import type { AgentActivity } from '../../../shared/agentActivity'
import { capabilitiesForThread, isThreadBusy, type AgentState } from '../../../shared/agents'
import { lastTurnRecord } from '../../../shared/threadFailures'
import { Button } from '../components/Button'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import type { AgentConnection } from './AgentContext'
import { sendThreadRevision } from './ThreadComposer'
import { hasDraftContent, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { failureWords, openSettingsName, openSettingsWords, tryAgainName, tryAgainWords } from './ownServerTurnWords'

/**
 * A thread on one of the user's own model servers (ADR-0124, October 24 amendment; the `own-model-servers` Owl feature):
 * what its transcript can do about a turn the server will not answer or let down. The newest failure keeps Try again,
 * which sends the user's last message again, and Open Settings when the server turned down its key; the live line keeps
 * Stop. Absent while the Owl feature is off, so every turn reads as it always has.
 */
export interface OwnServerTurnActions {
  /** The record ID of the thread's newest turn when it failed: only that failure keeps its buttons. */
  readonly newestFailure: string | null
  readonly canTryAgain: boolean
  readonly canStop: boolean
  readonly tryAgain: () => void
  readonly openSettings: () => void
  readonly stop: () => void
}

export const OwnServerTurnContext = createContext<OwnServerTurnActions | null>(null)
export const useOwnServerTurnActions = (): OwnServerTurnActions | null => useContext(OwnServerTurnContext)

type Command = AgentConnection['command']

/**
 * Sends the thread's last user message again as a new send, through the composer's own send. Its words go; an image it
 * carried does not, since the transcript keeps only the image's name and preview, not the staged image a send needs.
 * Whatever the composer holds is put back once the message is on its way, so a draft is never lost to the press.
 */
export function sendLastMessageAgain(row: ThreadRow, command: Command, store: ThreadDraftStore): boolean {
  const threadId = row.thread.id
  const last = row.thread.messages.findLast(message => message.role === 'user')
  if (last === undefined || !last.text.trim()) return false
  const kept = store.draft(threadId)
  store.edit(threadId, { text: last.text, attachments: [], skills: [], files: [], requestId: null })
  // The send takes the composer's revision before its first wait, so the draft can come back at once.
  void sendThreadRevision(store, row, command, performance.now())
  if (hasDraftContent(kept)) store.restoreDraft(threadId, { text: kept.text, attachments: kept.attachments, skills: kept.skills, files: kept.files, requestId: kept.requestId })
  return true
}

/**
 * After Stop or Try again the button pressed goes away, so focus goes to the composer of the pane it was in, where the
 * next message is written. Found from the press rather than by thread, as a thread can be open in two panes.
 */
export function focusComposerFrom(pressed: HTMLElement): void {
  pressed.closest('.thread-pane')?.querySelector<HTMLElement>('.thread-workspace__compose .prompt-editor[contenteditable="true"]')?.focus()
}

/** The actions a transcript gives its own-server turns, or null while the Owl feature is off. */
export function useOwnServerTurns(row: ThreadRow, state: AgentState, command: Command, store: ThreadDraftStore): OwnServerTurnActions | null {
  const on = useOwlFeature('own-model-servers')
  const app = useOptionalApp()
  const latest = useRef({ row, command, store })
  latest.current = { row, command, store }
  const thread = row.thread
  const newestTurn = lastTurnRecord(thread)
  const newestFailure = newestTurn?.status === 'failed' && newestTurn.ownServer?.failure !== undefined ? newestTurn.id : null
  const busy = isThreadBusy(state, thread.id)
  const capabilities = capabilitiesForThread(state.host, thread)
  const canTryAgain = row.connected && !busy && thread.status !== 'running' && !thread.archivedAt && capabilities.submit
  const canStop = row.connected && !busy && thread.status === 'running' && capabilities.interrupt === true
  const tryAgain = useCallback(() => { const { row: current, command: send, store: drafts } = latest.current; sendLastMessageAgain(current, send, drafts) }, [])
  const navigate = app?.actions.navigate
  const openSettings = useCallback(() => { navigate?.('settings', 'settings-providers', 'own-model-servers') }, [navigate])
  const threadId = thread.id
  const stop = useCallback(() => { void latest.current.command({ type: 'interrupt', threadId }) }, [threadId])
  const actions = useMemo(() => ({ newestFailure, canTryAgain, canStop, tryAgain, openSettings, stop }), [newestFailure, canTryAgain, canStop, tryAgain, openSettings, stop])
  return on ? actions : null
}

/**
 * Why a turn failed, under its Failed line. A turn one of the user's own servers let down says what happened in the
 * error colour, then that nothing was lost and what to do, in the interface language; the newest such failure keeps its
 * buttons. Every other failure reads as its turn record says.
 */
export function TurnFailureReason({ turn }: { readonly turn: AgentActivity | undefined }): ReactNode {
  const actions = useOwnServerTurnActions()
  const own = turn?.status === 'failed' ? turn.ownServer : undefined
  if (turn === undefined) return null
  if (actions === null || own?.failure === undefined) return turn.error ? <p className="thread-activity__error thread-activity__error--turn">{turn.error}</p> : null
  return <OwnServerFailure failure={own.failure} name={own.name} model={own.model} host={own.host} newest={actions.newestFailure === turn.id} actions={actions} />
}

function OwnServerFailure({ failure, name, model, host, newest, actions }: {
  readonly failure: NonNullable<NonNullable<AgentActivity['ownServer']>['failure']>
  readonly name: string; readonly model: string; readonly host: string
  readonly newest: boolean; readonly actions: OwnServerTurnActions
}): ReactNode {
  const words = failureWords(failure, name, model, host)
  return <div className="thread-own-failure" data-failure={failure}>
    <p className="thread-own-failure__reason tt-paragraph"><strong>{words.title}</strong> {words.body}</p>
    {newest ? <div className="thread-own-failure__actions">
      {failure === 'key-refused' ? <Button variant="secondary" aria-label={openSettingsName()} onClick={actions.openSettings}>
        <Settings2 size={14} aria-hidden="true" />{openSettingsWords()}</Button> : null}
      <Button variant="secondary" aria-label={tryAgainName(name)} disabled={!actions.canTryAgain}
        onClick={event => { const pressed = event.currentTarget; actions.tryAgain(); focusComposerFrom(pressed) }}>
        <RotateCcw size={14} aria-hidden="true" />{tryAgainWords()}</Button>
    </div> : null}
  </div>
}

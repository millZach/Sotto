import React, { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { RotateCcw, Settings2 } from 'lucide-react'
import type { AgentActivity, OwnServerTurn, OwnServerTurnFailure } from '../../../shared/agentActivity'
import { capabilitiesForThread, isThreadBusy, type AgentState, type AgentThread } from '../../../shared/agents'
import { lastTurnRecord } from '../../../shared/threadFailures'
import { Button } from '../components/Button'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import type { AgentConnection } from './AgentContext'
import { sendThreadRevision } from './ThreadComposer'
import { hasDraftContent, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { failureWords, imagesNotKept, openSettingsName, openSettingsWords, putBackName, tryAgainName, tryAgainWords } from './ownServerTurnWords'

/**
 * A thread on one of the user's own model servers (ADR-0124, October 24 amendment; the `own-model-servers` Owl feature):
 * what its transcript can do about a turn the server will not answer or let down. The newest failure keeps Try again,
 * which sends the user's last message again, and Open Settings when the server turned down its key; the live line keeps
 * Stop. Absent while the Owl feature is off, so every turn reads as it always has.
 */
export interface OwnServerTurnActions {
  /** The record ID of the thread's newest turn when it failed: only that failure keeps its buttons. */
  readonly newestFailure: string | null
  /**
   * What Try again does with the thread's last message: sends it again, or, when it carried images that cannot be sent
   * again, puts its words back in the composer for the user to attach them and send. Null when there is none to use.
   */
  readonly tryAgainBy: TryAgainBy | null
  readonly canTryAgain: boolean
  readonly canStop: boolean
  readonly tryAgain: () => void
  readonly openSettings: () => void
  readonly stop: () => void
}

export type TryAgainBy = 'send' | 'put-back'

export const OwnServerTurnContext = createContext<OwnServerTurnActions | null>(null)
export const useOwnServerTurnActions = (): OwnServerTurnActions | null => useContext(OwnServerTurnContext)

type Command = AgentConnection['command']

/** What Try again can do with the thread's last message from the user. */
export function tryAgainOf(messages: AgentThread['messages']): TryAgainBy | null {
  const last = messages.findLast(message => message.role === 'user')
  if (last === undefined) return null
  // The transcript keeps an image's name and preview, not the staged image a send needs, so it cannot go again.
  if (last.attachments?.length) return 'put-back'
  return last.text.trim() ? 'send' : null
}

/**
 * Try again. A message of words only is sent again as a new send, through the composer's own send, and whatever the
 * composer holds is put back once it is on its way, so a draft is never lost to the press. A message that carried images
 * has its words put in the composer instead, only when the composer is empty, for the user to attach them and send.
 */
export function tryLastMessageAgain(row: ThreadRow, command: Command, store: ThreadDraftStore): TryAgainBy | null {
  const threadId = row.thread.id
  const by = tryAgainOf(row.thread.messages)
  const last = row.thread.messages.findLast(message => message.role === 'user')
  if (by === null || last === undefined) return null
  if (by === 'put-back') {
    if (last.text.trim()) store.restoreDraft(threadId, { text: last.text, attachments: [], skills: [], files: [], requestId: null }, true)
    return by
  }
  const kept = store.draft(threadId)
  store.edit(threadId, { text: last.text, attachments: [], skills: [], files: [], requestId: null })
  // The send takes the composer's revision before its first wait, so the draft can come back at once.
  void sendThreadRevision(store, row, command, performance.now())
  if (hasDraftContent(kept)) store.restoreDraft(threadId, { text: kept.text, attachments: kept.attachments, skills: kept.skills, files: kept.files, requestId: kept.requestId })
  return by
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
  const tryAgainBy = tryAgainOf(thread.messages)
  // Putting words back in the composer sends nothing, so it waits on no connection.
  const canTryAgain = tryAgainBy === 'put-back' ? !thread.archivedAt
    : tryAgainBy === 'send' && row.connected && !busy && thread.status !== 'running' && !thread.archivedAt && capabilities.submit
  const canStop = row.connected && !busy && thread.status === 'running' && capabilities.interrupt === true
  const tryAgain = useCallback(() => { const { row: current, command: send, store: drafts } = latest.current; tryLastMessageAgain(current, send, drafts) }, [])
  const navigate = app?.actions?.navigate
  const openSettings = useCallback(() => { navigate?.('settings', 'settings-providers', 'own-model-servers') }, [navigate])
  const threadId = thread.id
  const stop = useCallback(() => { void latest.current.command({ type: 'interrupt', threadId }) }, [threadId])
  const actions = useMemo(() => ({ newestFailure, tryAgainBy, canTryAgain, canStop, tryAgain, openSettings, stop }),
    [newestFailure, tryAgainBy, canTryAgain, canStop, tryAgain, openSettings, stop])
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
  return <OwnServerFailure server={{ ...own, failure: own.failure }} newest={actions.newestFailure === turn.id} actions={actions} />
}

function OwnServerFailure({ server, newest, actions }: {
  readonly server: OwnServerTurn & { readonly failure: OwnServerTurnFailure }
  readonly newest: boolean; readonly actions: OwnServerTurnActions
}): ReactNode {
  const { i18n } = useLingui()
  // Said once, after a press put the message back because its images could not go again.
  const [putBack, setPutBack] = useState(false)
  const words = failureWords(i18n, server.failure, server)
  const byPutBack = actions.tryAgainBy === 'put-back'
  return <div className="thread-own-failure" data-failure={server.failure}>
    <p className="thread-own-failure__reason tt-paragraph"><strong>{words.title}</strong> {words.body}</p>
    {newest ? <div className="thread-own-failure__actions">
      {server.failure === 'key-refused' ? <Button variant="secondary" aria-label={openSettingsName(i18n)} onClick={actions.openSettings}>
        <Settings2 size={14} aria-hidden="true" />{openSettingsWords(i18n)}</Button> : null}
      <Button variant="secondary" aria-label={byPutBack ? putBackName(i18n) : tryAgainName(i18n, server)} disabled={!actions.canTryAgain}
        onClick={event => { const pressed = event.currentTarget; actions.tryAgain(); if (byPutBack) setPutBack(true); focusComposerFrom(pressed) }}>
        <RotateCcw size={14} aria-hidden="true" />{tryAgainWords(i18n)}</Button>
    </div> : null}
    {newest ? <p className="thread-own-failure__note tt-paragraph" role="status">{putBack && byPutBack ? imagesNotKept(i18n) : null}</p> : null}
  </div>
}

import { t } from '@lingui/core/macro'

import { isThreadBusy, type AgentState } from '../../../../shared/agents'
import type { RequestDraftOwner } from '../../../../shared/requestDrafts'
import type { ThreadRow } from '../threadFacts'

/**
 * Whose saved answers a thread's request cards keep: the thread's own, by its provider. Every card for the same request
 * passes this, wherever it is drawn, so they share one answer in the window (`requestAnswerOwnerKey`).
 */
export function threadRequestOwner(row: ThreadRow, state: AgentState): RequestDraftOwner {
  return { kind: 'thread', ownerId: row.thread.id, providerId: row.providerId ?? state.configuration.provider }
}

/** Why a thread's request cards cannot be answered right now, in the words the card shows, or null when they can. */
export function threadRequestBlocked(row: ThreadRow, state: AgentState): string | null {
  const provider = row.provider
  return isThreadBusy(state, row.thread.id) ? t`Waiting for Sotto…` : !row.connected ? t`Reconnect ${provider} to answer.` : null
}

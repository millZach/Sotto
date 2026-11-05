import { randomUUID } from 'node:crypto'
import { AGENT_TEXT_MAX, isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { COUNCIL_PROMPT_LEAD } from '../../shared/council'
import type { CouncilAskedBy } from '../../shared/councilTools'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import type { CouncilCoordinator, CouncilHost } from './councilService'

/**
 * The way back to the thread whose agent asked for a Council or a Climb (ADR-0177, amendment of November 5, 2026): once
 * the verdict clears its fairness check, or the Climb ends, Sotto sends that thread one message in its own voice, tagged
 * as the Council's, as soon as the thread is free. It is recorded as Sotto's before the provider hears it, so no client
 * shows it as the user's and Watcher never takes it for the user's word. It is sent once: a send never confirmed is
 * never sent again.
 */

/** One user message in one thread, which asks for at most one Council or Climb. */
export const askedKey = (threadId: string, userMessageId: string): string => `${threadId}\n${userMessageId}`

/** Where the delivery stands now, and a new one when it is due and none was made. */
export function dueDelivery(asked: CouncilAskedBy): NonNullable<CouncilAskedBy['delivery']> {
  return asked.delivery ?? (asked.delivery = { draftId: randomUUID(), messageId: randomUUID(), state: 'queued' })
}

/** Whether a delivery has nothing more to do: sent, or given up on. */
export const deliveryEnded = (asked: CouncilAskedBy | undefined): boolean =>
  asked?.delivery !== undefined && asked.delivery.state !== 'queued' && asked.delivery.state !== 'dispatching'

/** Free for Sotto's message: on this computer, connected, open, at rest, asking the user nothing and holding no other work. */
export function originFree(snapshot: AgentHostSnapshot, thread: AgentThread | undefined, control: Pick<CouncilCoordinator, 'hasPendingThreadWork'>): thread is AgentThread {
  return thread !== undefined && isThreadProviderConnected(snapshot, thread) && thread.clientConnected !== false && !isThreadClosed(thread) && thread.workspaceSettledAt == null
    && !isThreadTurnRunning(thread) && thread.requests.length === 0 && !control.hasPendingThreadWork(thread.id)
}

/** The message as sent: the Council's lead line, then Sotto's note, then what it found, cut to what one send carries. */
export function deliveryText(note: string, body: string): string {
  const head = `${COUNCIL_PROMPT_LEAD}\n\n${note}\n\n`
  const room = AGENT_TEXT_MAX - head.length
  const cut = '\n\n(Cut here to fit one message. read_council reads all of it.)'
  return head + (body.length <= room ? body : `${body.slice(0, room - cut.length)}${cut}`)
}

/**
 * Sends it: saved as on its way, recorded as Sotto's, then sent through the coordinator. Resolves with what came of it;
 * an uncertain send is unconfirmed and is never sent again.
 */
export async function sendDelivery(options: { readonly control: CouncilCoordinator; readonly host: CouncilHost; readonly save: () => Promise<void> },
  thread: string, delivery: NonNullable<CouncilAskedBy['delivery']>, text: string, guard: () => void): Promise<void> {
  delivery.state = 'dispatching'
  try { await options.save(); await options.host.recordSottoMessage(thread, delivery.messageId); guard() } catch { delivery.state = 'failed'; return }
  try {
    const result = await options.control.commandFromCouncil({ type: 'manual-send', threadId: thread, draftId: delivery.draftId, text }, guard)
    const sent = result.deliveries?.find(item => item.draftId === delivery.draftId && item.threadId === thread)
    delivery.state = sent?.status === 'accepted' || !sent && !result.error ? 'sent' : sent?.status === 'uncertain' || sent?.status === 'submitting' ? 'unconfirmed' : 'failed'
  } catch { delivery.state = 'unconfirmed' }
}

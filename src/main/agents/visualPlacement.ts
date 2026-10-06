import type { AgentMessage } from '../../shared/agents'
import { visualFallbackText, visualMessageId } from '../../shared/visuals'
import type { StoredVisual } from './threadStore'

/** A visual as the message a window draws: Sotto's own ID, the visual, and its words for a reader that cannot draw it. */
export function visualMessage(stored: StoredVisual): AgentMessage {
  return { id: visualMessageId(stored.visual.id), role: 'assistant', text: visualFallbackText(stored.visual), createdAt: stored.createdAt, visual: stored.visual }
}

/**
 * A window's messages with its thread's visuals slotted in (ADR-0055). Each visual goes right after the message it was
 * anchored to when that message is in the window, after any earlier visual on the same message; otherwise at the end of
 * the turn it was drawn in, when that turn's user message is in the window; otherwise it is left out, because its place
 * is above the window or was taken back. A visual drawn before the thread held any message leads a window that starts
 * at the beginning of the thread. The window's own messages are never moved.
 */
export function placeVisuals(messages: readonly AgentMessage[], visuals: readonly StoredVisual[], windowStartsThread: boolean): AgentMessage[] {
  if (visuals.length === 0) return [...messages]
  const index = new Map(messages.map((message, position) => [message.id, position]))
  /** Visuals to draw after each window position; -1 is before the first message. */
  const after = new Map<number, AgentMessage[]>()
  const place = (position: number, stored: StoredVisual): void => {
    const list = after.get(position)
    if (list) list.push(visualMessage(stored))
    else after.set(position, [visualMessage(stored)])
  }
  for (const stored of visuals) {
    const anchor = stored.anchorMessageId === null ? undefined : index.get(stored.anchorMessageId)
    if (anchor !== undefined) { place(anchor, stored); continue }
    const user = stored.anchorUserMessageId === null ? undefined : index.get(stored.anchorUserMessageId)
    if (user !== undefined) {
      // The turn ends at the next user message, or with the window.
      let end = user
      while (end + 1 < messages.length && messages[end + 1]!.role !== 'user') end++
      place(end, stored)
      continue
    }
    if (stored.anchorMessageId === null && stored.anchorUserMessageId === null && windowStartsThread) place(-1, stored)
  }
  const placed: AgentMessage[] = [...after.get(-1) ?? []]
  for (const [position, message] of messages.entries()) {
    placed.push(message)
    const drawn = after.get(position)
    if (drawn) placed.push(...drawn)
  }
  return placed
}

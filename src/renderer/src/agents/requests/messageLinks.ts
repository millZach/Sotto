import { isVisualMessage, type AgentMessage } from '../../../../shared/agents'
import { textLinks } from './LinkedText'

/** Each http or https address written in a text, once, in the order written. */
export function webLinks(text: string): string[] {
  return [...new Set(textLinks(text).flatMap(part => part.url === undefined ? [] : [part.url]))]
}

/**
 * The web links in the agent's message just before a question. A question has no place in the transcript of its own,
 * but the agent waits on the answer, so its newest message is the one the question follows. A visual's message is
 * Sotto's, not the agent's words; one that reached this window without its drawing, as a host sends it, is words alone
 * (ADR-0056) and counts. The card leaves out any it already shows as a link.
 */
export function messageLinks(messages: readonly AgentMessage[]): string[] {
  const message = messages.findLast(item => item.role === 'assistant' && !isVisualMessage(item))
  return message === undefined ? [] : webLinks(message.text)
}

/** Where a link goes, as its row names it: the host and port, then the path when there is one. */
export function linkPlace(url: string): string {
  const parsed = new URL(url)
  return parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`
}

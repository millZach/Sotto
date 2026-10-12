import { isVisualMessage, type AgentMessage, type AgentRequest } from '../../../../shared/agents'
import { textLinks } from './LinkedText'

/**
 * Every text a question card shows with its web addresses as links: its own words, each question and each choice. A
 * question's header is a tag of plain words, so an address there is no link and the row still shows it.
 */
function requestTexts(request: AgentRequest): string[] {
  return [request.text,
    ...(request.questions ?? []).flatMap(question => [question.question, ...question.options.flatMap(option => [option.label, option.description ?? ''])]),
    ...request.options.map(option => option.label)]
}

const urls = (text: string): string[] => textLinks(text).flatMap(part => part.url === undefined ? [] : [part.url])

/**
 * The web links in the agent's message just before a question, each once and in the order written, leaving out any the
 * question already shows. A question has no place in the transcript of its own, but the agent waits on the answer, so
 * its newest message is the one the question follows. A visual's message is Sotto's, not the agent's words; one that
 * reached this window without its drawing, as a host sends it, is words alone (ADR-0056) and counts.
 */
export function messageLinks(messages: readonly AgentMessage[], request: AgentRequest): string[] {
  const message = messages.findLast(item => item.role === 'assistant' && !isVisualMessage(item))
  if (message === undefined) return []
  const shown = new Set(requestTexts(request).flatMap(urls))
  return [...new Set(urls(message.text))].filter(url => !shown.has(url))
}

/** Where a link goes, as its row names it: the host and port, then the path when there is one. */
export function linkPlace(url: string): string {
  const parsed = new URL(url)
  return parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`
}

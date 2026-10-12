// PROTOTYPE — throwaway. Three ways a question card could carry the links from the agent's message just before it,
// beside today's card, switchable from the floating bar or with ← and →. Only the winner is folded into the card.
import React, { type ReactNode } from 'react'
import { ArrowUpRight, Link2 } from 'lucide-react'
import { isVisualMessage, type AgentMessage, type AgentRequest } from '../../../../shared/agents'
import { PrototypeSwitcher, prototypesEnabled, usePrototypeVariant } from '../../components/PrototypeSwitcher'
import { LinkedText, textLinks } from './LinkedText'
import './messageLinksPrototype.css'

export const messageLinksPrototypeEnabled = prototypesEnabled

const VARIANTS = [
  { key: 'A', name: 'Link rows, like the iPhone' },
  { key: 'B', name: 'One line under the question' },
  { key: 'C', name: 'The sentence it came from' },
  { key: 'Now', name: 'Today’s card' },
] as const

/** Every web address a request already shows as a link: its text, prompts, headers, choices and their descriptions. */
function requestTexts(request: AgentRequest): string[] {
  return [request.text, ...(request.questions ?? []).flatMap(question => [question.question, question.header ?? '',
    ...question.options.flatMap(option => [option.label, option.description ?? ''])]), ...request.options.map(option => option.label)]
}

/** The agent's newest message, the one a pending question follows: it waits for the answer, so nothing comes after. */
function lastAgentMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
  return messages.findLast(message => message.role === 'assistant' && !isVisualMessage(message))
}

export interface MessageLink { readonly url: string; readonly place: string; readonly sentence: string }

/** The links in that message the request does not already show, each once, with the paragraph it was written in. */
export function messageLinks(messages: readonly AgentMessage[], request: AgentRequest): MessageLink[] {
  const message = lastAgentMessage(messages)
  if (!message) return []
  const shown = new Set(requestTexts(request).flatMap(text => textLinks(text).flatMap(part => part.url ? [part.url] : [])))
  const found: MessageLink[] = []
  for (const paragraph of message.text.split(/\n\s*\n/u)) {
    for (const part of textLinks(paragraph)) {
      if (!part.url || shown.has(part.url) || found.some(link => link.url === part.url)) continue
      const url = new URL(part.url)
      found.push({ url: part.url, place: url.pathname === '/' ? url.host : url.host + url.pathname, sentence: plain(paragraph) })
    }
  }
  return found
}

/** A paragraph's words without the markdown around them, for quoting. */
function plain(paragraph: string): string {
  return paragraph.replace(/\*\*|__|`/gu, '').replace(/^\s*[-*]\s+/gmu, '').replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 $2').replace(/\s+/gu, ' ').trim()
}

function open(url: string): void { void window.sotto?.openExternalLink?.(url) }

/** A: each link a row of its own, as the iPhone's question sheet shows a question's links. */
function Rows({ links }: { readonly links: readonly MessageLink[] }): ReactNode {
  return <div className="message-links message-links--rows" role="group" aria-label="Links from the message above">
    {links.map(link => <button key={link.url} type="button" className="message-links__row tt-focusable" title={link.url} onClick={() => open(link.url)}>
      <Link2 size={16} aria-hidden="true" />
      <span><b>Open the link</b><small>{link.place}</small></span>
      <ArrowUpRight size={16} aria-hidden="true" />
    </button>)}
  </div>
}

/** B: one quiet line naming where each link goes. */
function Line({ links }: { readonly links: readonly MessageLink[] }): ReactNode {
  return <p className="message-links message-links--line">
    <span>From the message above:</span>
    {links.map(link => <a key={link.url} className="agent-request__link tt-focusable" href={link.url} rel="noopener noreferrer" target="_blank" title={link.url}
      onClick={event => { event.preventDefault(); open(link.url) }}>{link.place}<ArrowUpRight size={13} aria-hidden="true" /></a>)}
  </p>
}

/** C: the paragraph each link was written in, quoted, with its links live. */
function Sentences({ links }: { readonly links: readonly MessageLink[] }): ReactNode {
  const sentences = [...new Set(links.map(link => link.sentence))]
  return <figure className="message-links message-links--quote">
    <figcaption>From the message above</figcaption>
    {sentences.map(sentence => <blockquote key={sentence}><LinkedText text={sentence} /></blockquote>)}
  </figure>
}

/** What the card shows for the current variant, and the bar that switches it; rendered once per pane. */
export function useMessageLinksPrototype(): { readonly variant: string; readonly switcher: ReactNode } {
  const [variant, choose] = usePrototypeVariant(VARIANTS, 'question-message-links')
  return { variant, switcher: <PrototypeSwitcher variants={VARIANTS} current={variant} onChoose={choose} /> }
}

export function MessageLinksVariant({ variant, links }: { readonly variant: string; readonly links: readonly MessageLink[] }): ReactNode {
  if (links.length === 0 || variant === 'Now') return null
  return variant === 'A' ? <Rows links={links} /> : variant === 'B' ? <Line links={links} /> : <Sentences links={links} />
}

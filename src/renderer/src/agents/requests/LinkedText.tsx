import React, { type ReactNode } from 'react'
import { externalLinkSchema } from '../../../../shared/externalLinks'

/** A web address as a provider writes one into a question: from its scheme up to the next space or quote. */
const WEB_ADDRESS = /https?:\/\/[^\s<>"'`]+/giu

/** The end of a sentence or a closing bracket the address did not open is not part of the address. */
function trimmed(address: string): string {
  let end = address
  for (;;) {
    const last = end.at(-1)
    if (last && '.,;:!?'.includes(last)) end = end.slice(0, -1)
    else if (last && ')]}'.includes(last) && end.split(last).length > end.split({ ')': '(', ']': '[', '}': '{' }[last]!).length) end = end.slice(0, -1)
    else return end
  }
}

/** The address as the URL a link opens, or null for one that is not a valid http(s) address. */
function webAddress(address: string): string | null {
  try {
    const parsed = new URL(address)
    return ['http:', 'https:'].includes(parsed.protocol) && externalLinkSchema.safeParse(parsed.href).success ? parsed.href : null
  } catch { return null }
}

/** Plain text in order, each web address in it marked with the URL it opens; anything not a valid http(s) address stays text. */
export function textLinks(text: string): Array<{ readonly text: string; readonly url?: string }> {
  const parts: Array<{ text: string; url?: string }> = []
  let from = 0
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const address = trimmed(match[0])
    const url = webAddress(address)
    if (!url) continue
    if (match.index > from) parts.push({ text: text.slice(from, match.index) })
    parts.push({ text: address, url })
    from = match.index + address.length
  }
  if (from < text.length) parts.push({ text: text.slice(from) })
  return parts
}

/**
 * Text with each web address in it a link that opens where a link in a message opens: the thread's browser or the
 * system browser. Inside a choice's label the link is its own control, so pressing it never picks the choice.
 */
export function LinkedText({ text }: { readonly text: string }): ReactNode {
  return <>{textLinks(text).map((part, index) => part.url
    ? <a key={index} className="agent-request__link tt-focusable" href={part.url} rel="noopener noreferrer" target="_blank" title={part.url}
      onClick={event => { event.preventDefault(); event.stopPropagation(); void window.sotto?.openExternalLink?.(part.url!) }}
      onAuxClick={event => event.preventDefault()}>{part.text}</a>
    : part.text)}</>
}

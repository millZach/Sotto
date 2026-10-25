import React, { type ReactNode } from 'react'

/**
 * Code inside a translated sentence (ADR-0123): a branch name, a commit or a path stays left to right, isolated from the
 * text around it, so an Arabic or Urdu sentence keeps `feat/إصلاح` in its own order. A message is a plain string, so the
 * value is marked with Unicode's isolates as it goes in, and `Isolated` draws each marked run as its own `<bdi>`, with the
 * marks themselves taken out of the page. `plainText` takes them out of a string for an accessible name or a tooltip.
 */
const LTR_START = '⁦', FIRST_STRONG_START = '⁨', END = '⁩'
const MARKS = /[⁦⁨⁩]/gu
const RUNS = /([⁦⁨])([^⁦⁨⁩]*)⁩/gu

/** A branch name, a commit or a path, kept left to right inside a sentence. */
export const ltr = (value: string): string => `${LTR_START}${value}${END}`
/** Text someone else wrote (a commit subject), kept apart from the sentence in whichever direction it starts. */
export const own = (value: string): string => `${FIRST_STRONG_START}${value}${END}`
/** The sentence without its marks, for an accessible name, a tooltip or a comparison. */
export const plainText = (text: string): string => text.replace(MARKS, '')

/** A sentence with each marked run drawn as its own isolated box. */
export function Isolated({ text }: { readonly text: string }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  for (const match of text.matchAll(RUNS)) {
    if (match.index > at) parts.push(plainText(text.slice(at, match.index)))
    parts.push(match[1] === LTR_START ? <bdi key={match.index} dir="ltr">{match[2]}</bdi> : <bdi key={match.index}>{match[2]}</bdi>)
    at = match.index + match[0].length
  }
  if (at < text.length) parts.push(plainText(text.slice(at)))
  return <>{parts}</>
}

import React, { type ReactNode } from 'react'

/**
 * Code inside a translated sentence (ADR-0123): a branch name, a commit or a path stays left to right, isolated from the
 * text around it, so an Arabic or Urdu sentence keeps `feat/إصلاح` in its own order. A message is a plain string, so the
 * value is marked as it goes in, and `Isolated` draws each marked run as its own `<bdi>`, with the marks taken out of the
 * page. `plainText` takes them out of a string for an accessible name or a tooltip.
 *
 * The marks are ASCII control characters, which Git refuses in a branch name, and any in a value are dropped before it is
 * marked, so a value is always one run. Unicode's own isolates (U+2066 to U+2069) are left alone: a branch may hold them,
 * and they stay inside its box as part of its name.
 */
const LTR_START = '\u0001', OWN_START = '\u0002', END = '\u0003'
const isMark = (character: string): boolean => character === LTR_START || character === OWN_START || character === END
const unmarked = (value: string): string => [...value].filter(character => !isMark(character)).join('')

/** A branch name, a commit or a path, kept left to right inside a sentence as one unit, whatever it contains. */
export const ltr = (value: string): string => `${LTR_START}${unmarked(value)}${END}`
/** Text someone else wrote (a thread title, a commit subject), kept apart from the sentence in whichever direction it starts. */
export const own = (value: string): string => `${OWN_START}${unmarked(value)}${END}`
/** The sentence without its marks, for an accessible name, a tooltip or a comparison. */
export const plainText = (text: string): string => unmarked(text)

/** A sentence with each marked run drawn as its own isolated box. */
export function Isolated({ text }: { readonly text: string }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  while (at < text.length) {
    const starts = [text.indexOf(LTR_START, at), text.indexOf(OWN_START, at)].filter(index => index >= 0)
    const start = starts.length > 0 ? Math.min(...starts) : -1
    const end = start >= 0 ? text.indexOf(END, start + 1) : -1
    if (start < 0 || end < 0) { parts.push(plainText(text.slice(at))); break }
    if (start > at) parts.push(plainText(text.slice(at, start)))
    const run = text.slice(start + 1, end)
    parts.push(text[start] === LTR_START ? <bdi key={start} dir="ltr">{run}</bdi> : <bdi key={start}>{run}</bdi>)
    at = end + 1
  }
  return <>{parts}</>
}

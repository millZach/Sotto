import type { Root } from 'hast'

export interface Highlighter {
  registered(language: string): boolean
  highlight(language: string, code: string): Root
}

// The grammar set is a large module; it loads the first time a fenced block names a language.
let highlighter: Highlighter | undefined
let loading: Promise<Highlighter> | undefined
export function loadHighlighter(): Promise<Highlighter> {
  return loading ??= import('lowlight').then(({ common, createLowlight }) => highlighter = createLowlight(common))
}
export const highlighterNow = (): Highlighter | null => highlighter ?? null

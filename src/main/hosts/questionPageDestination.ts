import type { QuestionPageOpening } from './desktopHostRouter'

/** Where the desktop opens a question's or prototype's page: the system browser, as a file or an address, or Sotto's browser. */
export type QuestionPageDestination =
  | { readonly browser: 'system'; readonly kind: 'file'; readonly file: string }
  | { readonly browser: 'system'; readonly kind: 'url'; readonly url: string }
  | { readonly browser: 'sotto'; readonly url: string }

/**
 * Where a page opens on the desktop, as **Web links in threads** chooses (ADR-0108). In the system browser a file opens as
 * a file and an address as an address, as before. In Sotto's browser an address opens as it is, and a file opens through
 * the phone access listener's loopback address under its token, because Sotto's browser opens no `file://` pages. With
 * phone access off there is no listener (`listenerPort` undefined), so the file opens in the system browser.
 */
export function questionPageDestination(opening: QuestionPageOpening, links: 'external' | 'embedded', listenerPort: number | undefined): QuestionPageDestination {
  if (opening.kind === 'url') return links === 'embedded' ? { browser: 'sotto', url: opening.url } : { browser: 'system', kind: 'url', url: opening.url }
  if (links === 'embedded' && listenerPort !== undefined) return { browser: 'sotto', url: `http://127.0.0.1:${listenerPort}/page/${opening.token}/${opening.start}` }
  return { browser: 'system', kind: 'file', file: opening.file }
}

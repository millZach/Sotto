import type { MatcherFunction } from '@testing-library/react'

/**
 * Finds a line of a drawn diff by its whole text. The words that changed sit in their own marks, so a line's text is
 * broken up across elements, and a screen reader's Added or Removed comes first.
 */
export const diffLine = (text: string): MatcherFunction => (_content, element) =>
  element?.classList.contains('changes-line__text') === true && element.textContent?.replace(/^(?:Added|Removed): /u, '').trim() === text

import { shownWords, type LaterWords } from '../../../src/renderer/src/features/settings/laterWords'

/**
 * Matches words Settings keeps to show later (laterWords.ts) by what they say now, whether they were kept as a message
 * or as text: `expect(onSave).toHaveBeenCalledWith(patch, saying('Theme saved.'))`.
 */
export function saying(text: string): { asymmetricMatch: (words: LaterWords) => boolean; toString: () => string } {
  return { asymmetricMatch: words => shownWords(words) === text, toString: () => `saying "${text}"` }
}

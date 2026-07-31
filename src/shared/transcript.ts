/**
 * Tidies transcript whitespace without destroying structure: runs of spaces
 * collapse to one, but line breaks survive — the LLM cleanup pass emits
 * multi-line output ("- " lists, paragraph breaks) that must reach the
 * clipboard intact. Raw ASR text contains no newlines, so plain dictation is
 * unaffected.
 */
export function formatTranscript(text: string): string {
  return text
    .replace(/\r\n?|\u2028|\u2029/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

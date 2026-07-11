export function formatTranscript(text: string): string {
  return text.replace(/\p{White_Space}+/gu, ' ').trim()
}

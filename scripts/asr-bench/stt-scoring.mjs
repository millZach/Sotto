import { normalize } from './wer.mjs'

// Use the production whitespace count, before WER normalization removes words.
export function shouldSkipCleanup(text) {
  return text.split(/\s+/u).filter(Boolean).length < 5
}

// Exact contiguous normalized name tokens, not aligned span WER. Empty annotation
// sets are N/A, so ordinary clips never inflate pooled name accuracy.
export function scoreProperNouns(hypothesis, names) {
  const tokens = normalize(hypothesis)
  const spans = names.map((name) => {
    const expected = normalize(name)
    const matched = expected.length > 0 && tokens.some((_, start) =>
      expected.every((token, offset) => tokens[start + offset] === token))
    return { name, matched }
  })
  const matched = spans.filter((span) => span.matched).length
  return { matched, total: spans.length, accuracy: spans.length ? matched / spans.length : null, spans }
}

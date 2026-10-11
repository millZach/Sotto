// A vocab for sherpa-onnx's hotword encoder that reproduces Parakeet's own BPE segmentation of the
// given words, for the dictionary experiment in bench-parakeet.mjs (ADR-0071 decided against it). sherpa picks the max-score split, so the exact BPE pieces of
// each hotword word cost -1 and every other piece -1000.
// Usage: node build-hotword-vocab.mjs <tokenizer.json> <tokens.txt> <out.vocab> <hotwords with / between phrases>
import { readFileSync, writeFileSync } from 'node:fs'

const [tokenizerFile, tokensFile, outFile, hotwords] = process.argv.slice(2)
const { model } = JSON.parse(readFileSync(tokenizerFile, 'utf8'))
const rank = new Map(model.merges.map((pair, i) => [Array.isArray(pair) ? pair.join(' ') : pair, i]))

function bpe(word) {
  let parts = [...word]
  for (;;) {
    let best = -1
    let bestRank = Infinity
    for (let i = 0; i < parts.length - 1; i++) {
      const r = rank.get(`${parts[i]} ${parts[i + 1]}`)
      if (r !== undefined && r < bestRank) {
        bestRank = r
        best = i
      }
    }
    if (best < 0) return parts
    parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)]
  }
}

const wanted = new Set()
for (const phrase of hotwords.split('/')) {
  for (const word of phrase.trim().split(/\s+/)) {
    const pieces = bpe(`▁${word}`)
    pieces.forEach((p) => wanted.add(p))
    console.log(`${word} -> ${pieces.join(' ')}`)
  }
}
const pieces = readFileSync(tokensFile, 'utf8').split(/\r?\n/).filter(Boolean)
  .map((line) => line.slice(0, line.lastIndexOf(' ')))
  .filter((piece) => !/^<.*>$/.test(piece))
const missing = [...wanted].filter((p) => !pieces.includes(p))
if (missing.length) console.log('pieces missing from tokens.txt:', missing.join(' '))
writeFileSync(outFile, pieces.map((p) => `${p}\t${wanted.has(p) ? -1 : -1000}`).join('\n') + '\n')

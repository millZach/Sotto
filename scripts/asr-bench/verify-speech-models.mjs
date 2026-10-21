// Loads each speech model folder with sherpa-onnx-node the way src/main/asr/speechEngine.ts does,
// and transcribes real speech: Common Voice English and Multilingual LibriSpeech (de, es, fr, it, pl),
// each with its reference, plus sherpa-onnx's own en/de/fr/es test clips. The check behind each of
// Sotto's downloads before it is published (ADR-0094, docs/release/releasing.md).
//
// Usage: node scripts/asr-bench/verify-speech-models.mjs <repoDir> <modelsDir> <outJson> <model>...
//   <modelsDir>/<model>/ holds encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt
//   <modelsDir>/clips/cv and clips/mls come from fetch-multilingual.mjs (fixie-ai/common_voice_17_0
//   en; facebook/multilingual_librispeech german, spanish, french, italian, polish), and
//   clips/sherpa-<en|de|fr|es>.wav from sherpa-onnx's asr-models release.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const [repoDir, modelsDir, outJson, ...models] = process.argv.slice(2)
const sherpa = createRequire(join(repoDir, 'package.json'))('sherpa-onnx-node')
const { wer } = await import(pathToFileURL(join(repoDir, 'scripts', 'asr-bench', 'wer.mjs')).href)
const version = JSON.parse(readFileSync(join(repoDir, 'node_modules', 'sherpa-onnx-node', 'package.json'), 'utf8')).version

const clipsDir = join(modelsDir, 'clips')
const clips = [
  ...JSON.parse(readFileSync(join(clipsDir, 'cv', 'manifest.json'), 'utf8')).map((c) => ({ ...c, path: join(clipsDir, 'cv', c.file), set: 'Common Voice' })),
  ...JSON.parse(readFileSync(join(clipsDir, 'mls', 'manifest.json'), 'utf8')).map((c) => ({ ...c, path: join(clipsDir, 'mls', c.file), set: 'MLS' })),
  ...['en', 'de', 'fr', 'es'].map((language) => ({ file: `sherpa-${language}.wav`, language, path: join(clipsDir, `sherpa-${language}.wav`), set: 'sherpa-onnx test clip', reference: null })),
]

const results = { sherpaOnnxNode: version, models: {} }
for (const name of models) {
  const dir = join(modelsDir, name)
  const started = performance.now()
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') },
      tokens: join(dir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  })
  const loadMs = Math.round(performance.now() - started)
  const rows = []
  for (const clip of clips) {
    const wave = sherpa.readWave(clip.path)
    const samples = Float32Array.from(wave.samples)
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples })
    const t = performance.now()
    const text = ((await recognizer.decodeAsync(stream)).text ?? '').trim()
    const decodeMs = Math.round(performance.now() - t)
    rows.push({ set: clip.set, file: clip.file, language: clip.language, reference: clip.reference, text, decodeMs, wer: clip.reference ? wer(clip.reference, text) : null })
  }
  const byLanguage = {}
  for (const row of rows.filter((r) => r.wer !== null)) {
    const entry = (byLanguage[row.language] ??= { errors: 0, words: 0 })
    entry.errors += row.wer.errors
    entry.words += row.wer.refWords
  }
  const summary = Object.fromEntries(Object.entries(byLanguage).map(([language, e]) => [language, Math.round((e.errors / e.words) * 1000) / 10]))
  results.models[name] = { loadMs, summary, rows }
  console.log(name, 'load', loadMs, 'ms', 'corpus WER % by language', JSON.stringify(summary))
}
writeFileSync(outJson, JSON.stringify(results, null, 2))

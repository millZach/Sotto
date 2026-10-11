// One on-device speech model in one process, through sherpa-onnx on CPU: the bench behind
// ADR-0071 and docs/perf/2026-10-10-local-speech-models.md.
//
// Usage: node scripts/asr-bench/bench-parakeet.mjs <kind> <modelDir> <threads> <multiDir> <outJson> [qwen3 hotwords]
//   kind: parakeet | qwen3 | whisper, with the model folder as sherpa-onnx publishes it
//   multiDir: clips from fetch-multilingual.mjs (a manifest.json and 16 kHz WAVs)
// Parakeet's dictionary experiment: DECODING=modified_beam_search BPE_VOCAB=<from build-hotword-vocab.mjs>
//   HOTWORDS='a/b/c' HOTWORDS_SCORE=1.5
//
// Reports load time, per-clip decode time, peak working set, WER on the English fixtures and
// names, WER/CER per language, and memory on 60 s and 180 s recordings. Models are not in the
// repository; download them from sherpa-onnx's asr-models release.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [kind, modelDir, threadsArg, multiDir, outJson, hotwordsArg] = process.argv.slice(2)
const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Parakeet hotwords: DECODING=modified_beam_search BPE_VOCAB=<file> HOTWORDS='a/b/c' HOTWORDS_SCORE=1.5
const decoding = process.env.DECODING || 'greedy_search'
const streamHotwords = process.env.HOTWORDS || undefined
const threads = Number(threadsArg)
const sherpa = createRequire(join(repoDir, 'package.json'))('sherpa-onnx-node')
const asrBench = join(repoDir, 'scripts', 'asr-bench')
const { wer } = await import(pathToFileURL(join(asrBench, 'wer.mjs')).href)
const { scoreProperNouns } = await import(pathToFileURL(join(asrBench, 'stt-scoring.mjs')).href)

const mb = (bytes) => Math.round(bytes / 1048576)
const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024)
const find = (pattern) => {
  const hit = readdirSync(modelDir).find((f) => pattern.test(f))
  if (!hit) throw new Error(`no file matching ${pattern} in ${modelDir}`)
  return join(modelDir, hit)
}

function modelConfig() {
  if (kind === 'parakeet') {
    return {
      transducer: { encoder: find(/^encoder.*\.onnx$/), decoder: find(/^decoder.*\.onnx$/), joiner: find(/^joiner.*\.onnx$/) },
      tokens: find(/tokens\.txt$/),
      modelType: 'nemo_transducer',
      ...(process.env.BPE_VOCAB ? { modelingUnit: 'bpe', bpeVocab: process.env.BPE_VOCAB } : {}),
    }
  }
  if (kind === 'qwen3') {
    return {
      qwen3Asr: {
        convFrontend: find(/^conv_frontend.*\.onnx$/),
        encoder: find(/^encoder.*\.onnx$/),
        decoder: find(/^decoder.*\.onnx$/),
        tokenizer: join(modelDir, 'tokenizer'),
        hotwords: hotwordsArg ?? '',
      },
      tokens: '',
    }
  }
  if (kind === 'whisper') {
    return {
      whisper: { encoder: find(/encoder.*int8\.onnx$/), decoder: find(/decoder.*int8\.onnx$/), language: '', task: 'transcribe' },
      tokens: find(/tokens\.txt$/),
    }
  }
  throw new Error(`unknown kind ${kind}`)
}

const baseline = { rssMb: mb(process.memoryUsage().rss), peakMb: peakMb() }
const t0 = performance.now()
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: kind === 'whisper' ? 128 : 80 },
  modelConfig: { ...modelConfig(), numThreads: threads, provider: 'cpu', debug: 0 },
  decodingMethod: decoding,
  maxActivePaths: 4,
  ...(process.env.HOTWORDS_SCORE ? { hotwordsScore: Number(process.env.HOTWORDS_SCORE) } : {}),
})
const loadMs = performance.now() - t0
const afterLoad = { rssMb: mb(process.memoryUsage().rss), peakMb: peakMb() }

function decode(samples) {
  const stream = streamHotwords ? recognizer.createStream(streamHotwords) : recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  const start = performance.now()
  recognizer.decode(stream)
  const ms = performance.now() - start
  return { ms, text: (recognizer.getResult(stream).text ?? '').trim() }
}

const read = (file) => sherpa.readWave(file).samples

// English fixtures, scored the way the repo's asr-bench scores them.
const truth = JSON.parse(readFileSync(join(asrBench, 'fixtures', 'ground-truth.json'), 'utf8').replace(/^\uFEFF/, ''))
const names = JSON.parse(readFileSync(join(asrBench, 'fixtures', 'proper-nouns.json'), 'utf8').replace(/^\uFEFF/, ''))
const english = Object.keys(truth).map((clip) => ({ clip, samples: read(join(asrBench, 'fixtures', `speech-${clip}.wav`)) }))
decode(english[0].samples) // warm-up, not counted

const englishRuns = english.map(({ clip, samples }) => {
  const runs = [decode(samples), decode(samples)]
  const { text } = runs[1]
  return {
    clip,
    seconds: samples.length / 16000,
    ms: Math.min(...runs.map((r) => r.ms)),
    wer: wer(truth[clip], text).wer,
    names: names[clip]?.length ? scoreProperNouns(text, names[clip]) : null,
    text,
  }
})
const afterEnglish = peakMb()

// Other languages: WER on words, CER for Japanese (no spaces between words).
const normalizeLoose = (s) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim()
function editRate(ref, hyp) {
  if (ref.length === 0) return hyp.length ? 1 : 0
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i]
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[hyp.length] / ref.length
}
const manifest = JSON.parse(readFileSync(join(multiDir, 'manifest.json'), 'utf8'))
const multiRuns = manifest.map(({ file, language, reference }) => {
  const samples = read(join(multiDir, file))
  const { ms, text } = decode(samples)
  const ref = normalizeLoose(reference)
  const hyp = normalizeLoose(text)
  const byChar = language === 'ja'
  const rate = byChar
    ? editRate([...ref.replace(/ /g, '')], [...hyp.replace(/ /g, '')])
    : editRate(ref.split(' ').filter(Boolean), hyp.split(' ').filter(Boolean))
  return { file, language, seconds: samples.length / 16000, ms, errorRate: rate, metric: byChar ? 'cer' : 'wer', text, reference }
})
const afterMulti = peakMb()

// Long audio: the 16.6 s clip repeated, to see how memory and time grow with length.
const longClip = english.find((e) => e.clip === 'long').samples
const repeat = (seconds) => {
  const out = new Float32Array(Math.round(seconds * 16000))
  for (let i = 0; i < out.length; i++) out[i] = longClip[i % longClip.length]
  return out
}
const longRuns = []
for (const seconds of [60, 180]) {
  try {
    const { ms, text } = decode(repeat(seconds))
    longRuns.push({ seconds, ms, peakMb: peakMb(), words: text.split(/\s+/).filter(Boolean).length })
  } catch (error) {
    longRuns.push({ seconds, error: String(error?.message ?? error), peakMb: peakMb() })
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const byLanguage = {}
for (const r of multiRuns) (byLanguage[r.language] ??= []).push(r)
const summary = {
  kind,
  model: modelDir.split(/[\\/]/).pop(),
  threads,
  hotwords: hotwordsArg ? hotwordsArg.split(/[\n,]/).length : 0,
  decoding,
  streamHotwords: streamHotwords ? streamHotwords.split('/').length : 0,
  hotwordsScore: process.env.HOTWORDS_SCORE ?? null,
  loadMs: Math.round(loadMs),
  memoryMb: { baseline, afterLoad, peakAfterEnglish: afterEnglish, peakAfterMultilingual: afterMulti, peakAfterLong: peakMb() },
  english: {
    meanWer: mean(englishRuns.map((r) => r.wer)),
    names: (() => {
      const scored = englishRuns.filter((r) => r.names)
      const matched = scored.reduce((a, r) => a + r.names.matched, 0)
      const total = scored.reduce((a, r) => a + r.names.total, 0)
      return { matched, total }
    })(),
    msPerClip: Object.fromEntries(englishRuns.map((r) => [r.clip, Math.round(r.ms)])),
    realTimeFactor: mean(englishRuns.map((r) => r.ms / 1000 / r.seconds)),
  },
  languages: Object.fromEntries(Object.entries(byLanguage).map(([language, rs]) => [language, {
    metric: rs[0].metric,
    errorRate: mean(rs.map((r) => r.errorRate)),
    medianMs: rs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)],
    meanSeconds: mean(rs.map((r) => r.seconds)),
  }])),
  long: longRuns.map((r) => ({ ...r, ms: r.ms === undefined ? undefined : Math.round(r.ms) })),
}
writeFileSync(outJson, JSON.stringify({ summary, englishRuns, multiRuns }, null, 2))
console.log(JSON.stringify(summary, null, 2))

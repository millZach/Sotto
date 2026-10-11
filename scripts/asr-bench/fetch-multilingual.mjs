// Fetches a few recorded test clips per language with their transcripts, as 16 kHz mono WAV, from
// Hugging Face's dataset viewer, for bench-parakeet.mjs. Needs ffmpeg on PATH.
// Usage: node scripts/asr-bench/fetch-multilingual.mjs <outDir> <perLanguage> <dataset|config|textField|label>...
// The October 10 run: facebook/multilingual_librispeech (spanish, french, german, italian,
// portuguese, polish; field transcript) and fixie-ai/common_voice_17_0 (ja, hi; field sentence).
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, perLanguage, ...specs] = process.argv.slice(2)
const n = Number(perLanguage)
mkdirSync(outDir, { recursive: true })
const manifest = []
for (const spec of specs) {
  const [dataset, config, textField, label] = spec.split('|')
  const url = `https://datasets-server.huggingface.co/rows?dataset=${dataset}&config=${config}&split=test&offset=0&length=${n}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
  const { rows } = await res.json()
  for (const { row_idx: index, row } of rows) {
    const src = row.audio?.[0]?.src
    if (!src) continue
    const audio = await fetch(src)
    if (!audio.ok) throw new Error(`${label} ${index}: audio HTTP ${audio.status}`)
    const raw = join(outDir, `${label}-${index}.download`)
    const file = `${label}-${index}.wav`
    writeFileSync(raw, Buffer.from(await audio.arrayBuffer()))
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', join(outDir, file)])
    rmSync(raw)
    manifest.push({ file, language: label, reference: row[textField] })
  }
  console.log(`${label}: ${rows.length} clips`)
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

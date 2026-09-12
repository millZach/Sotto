/* global process, console, URL */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomInt, randomUUID } from 'node:crypto'
const dir = resolve(process.argv[2])
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
const result = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
const rows = readFileSync(join(dir, 'trials.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const names = { supertonic: 'Supertonic · F1', grok: 'Grok · Altair', kokoro: 'Kokoro · Heart' }
mkdirSync(join(dir, 'blind'), { recursive: true })
const mapping = {}, comparisons = []
for (const fixture of manifest.fixtures) {
  const selected = rows.filter(r => r.fixtureId === fixture.id && r.repeat === 1 && r.phase === 'screen' && r.ok)
  if (selected.length !== 3) throw new Error('Incomplete three-voice fixture')
  for (let i = selected.length - 1; i > 0; i--) { const j = randomInt(i + 1); [selected[i], selected[j]] = [selected[j], selected[i]] }
  const clips = selected.map((row, i) => {
    const id = randomUUID(), path = `blind/${id}.wav`
    copyFileSync(join(dir, row.audio), join(dir, path))
    mapping[id] = { provider: row.provider, source: row.audio }
    return { id, label: String.fromCharCode(65 + i), path, name: names[row.provider] }
  })
  comparisons.push({ ...fixture, clips })
}
writeFileSync(join(dir, 'blind-mapping.json'), JSON.stringify(mapping, null, 2))
const data = { run: manifest.startedAt, comparisons, summary: result.summaries, names }
writeFileSync(join(dir, 'listening-data.json'), JSON.stringify(data, null, 2))
let html = readFileSync(new URL('./listening.html', import.meta.url), 'utf8')
html = html.replace('four voices', 'three voices')
  .replace('Network measurements from 72 replies per model. First data is not speaker onset; Sotto currently waits for the full response.', 'Windows output measurements from 72 replies per model. Process loopback measures rendered audio, not physical speaker acoustics. Stop statistics exclude natural pauses and require observed silence.')
  .replace('First data<br>p50 / p95', 'Output onset<br>p50 / p95').replace('Full response<br>p50 / p95', 'Stop to silence<br>p50 / p95')
  .replace('Human listening and actual speaker start/stop measurements remain separate. No automatic voice preference scores.', 'The original hosted listening choices are preserved separately. This adds the Supertonic baseline; no preference scores are generated automatically.')
  .replace('bench.names[r.model]', 'bench.names[r.provider]').replaceAll('r.firstByteP50Ms', 'r.onsetP50Ms').replaceAll('r.firstByteP95Ms', 'r.onsetP95Ms').replaceAll('r.completeP50Ms', 'r.stopP50Ms').replaceAll('r.completeP95Ms', 'r.stopP95Ms')
  .replace('/* BENCH_DATA */', `const bench = ${JSON.stringify(data).replace(/</gu, '\\u003c')};`)
writeFileSync(join(dir, 'listening.html'), html)
console.log(JSON.stringify({ listening: join(dir, 'listening.html'), comparisons: comparisons.length }))

// Throwaway: renders the local-model benchmark results as one page in the prototype site.
// Usage: node benchmark.mjs <resultsDir> <site>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [resultsDir, site] = process.argv.slice(2)
const load = (name) => JSON.parse(readFileSync(join(resultsDir, `${name}.json`), 'utf8'))
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`)
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`
const models = [
  ['Parakeet TDT 0.6B v3 (int8)', load('parakeet-v3-int8-t4')],
  ['Whisper large-v3-turbo (int8)', load('whisper-turbo-int8-t4')],
  ['Qwen3-ASR 0.6B (int8)', load('qwen3-asr-int8-t4')],
]
const langs = ['es', 'fr', 'de', 'it', 'pt', 'pl', 'ja', 'hi']
const hot = [
  ['Plain (no dictionary)', load('parakeet-v3-int8-t4'), 0],
  ['Dictionary at 1.5', load('parakeet-v3-exact-hw1.5'), 0],
  ['Dictionary at 2.0', load('parakeet-v3-exact-hw2.0'), 5],
  ['Dictionary at 3.0', load('parakeet-v3-exact-hw3.0'), 95],
]
const row = (cells) => `<tr>${cells.map((c, i) => `<${i ? 'td' : 'th'}>${c}</${i ? 'td' : 'th'}>`).join('')}</tr>`
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local speech models on this laptop</title>
<style>body{font:14px system-ui,sans-serif;background:#111;color:#e8e8e8;max-width:1000px;margin:20px auto;padding:0 16px;line-height:1.45}h1{font-size:20px}h2{font-size:16px;margin-top:26px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #2a2a2a;padding:6px 8px;text-align:right;white-space:nowrap}th{text-align:left;color:#ccc;font-weight:600}tr:first-child th{color:#999}p,li{color:#ccc}a{color:#8cf}</style>
<p><a href="index.html">← Prototype</a></p>
<h1>Local speech models on this laptop</h1>
<p>Core Ultra 9 275HX, sherpa-onnx 1.13.8 on CPU, 4 threads, 8-bit weights. English: Sotto's seven benchmark clips (names from the proper-noun list). Other languages: 8 recorded clips each, from Multilingual LibriSpeech (es, fr, de, it, pt, pl) and Common Voice (ja, hi); word error, character error for Japanese. These references have no punctuation, so absolute numbers run high; compare across rows.</p>
<h2>Models</h2><div class="wrap"><table>
${row(['', 'Download', 'RAM loaded', 'RAM peak', '2 s clip', '17 s clip', '1 min clip', 'English error', 'Names (of 14)', ...langs])}
${models.map(([name, { summary: s }]) => row([name, { 'Parakeet TDT 0.6B v3 (int8)': '670 MB', 'Whisper large-v3-turbo (int8)': '1.04 GB', 'Qwen3-ASR 0.6B (int8)': '980 MB' }[name], `${(s.memoryMb.afterLoad.rssMb / 1024).toFixed(2)} GB`, `${(s.memoryMb.peakAfterMultilingual / 1024).toFixed(1)} GB`, sec(s.english.msPerClip.tiny), sec(s.english.msPerClip.technical), s.long[0].error ? 'failed' : `${sec(s.long[0].ms)}${s.long[0].words < 100 ? ' (cut off)' : ''}`, pct(s.english.meanWer), `${s.english.names.matched}`, ...langs.map((l) => pct(s.languages[l]?.errorRate))])).join('\n')}
</table></div>
<p>Parakeet's memory grows with a single long recording: 1.5 GB at 1 minute and 3.0 GB at 3 minutes. Cutting long dictations at pauses keeps it near 1.1 GB. It does not support Japanese or Hindi; Whisper cuts anything past 30 seconds unless it is split; Qwen3-ASR returned a single word on the 1 and 3 minute recordings.</p>
<h2>Feeding the dictionary to Parakeet</h2><div class="wrap"><table>
${row(['', 'Names (of 14)', 'English error', '17 s clip', 'Invented dictionary words in other-language clips'])}
${hot.map(([name, { summary: s }, invented]) => row([name, `${s.english.names.matched}`, pct(s.english.meanWer), sec(s.english.msPerClip.technical), invented ? `<b style="color:#f88">${invented}</b>` : '0'])).join('\n')}
</table></div>
<p>Stronger settings fix more names but invent dictionary words in speech that never said them (a French clip came back as "Anthropic Descript Descript Descript…"). "Zache" and "Wispr Flow" stay "Zack" and "Whisperflow" at every setting; only AI cleanup with the dictionary fixes those. Decision: not now.</p>`
writeFileSync(join(site, 'benchmark.html'), html)
console.log('wrote benchmark.html')

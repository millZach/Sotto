// PROTOTYPE — throwaway. Builds one self-contained HTML page comparing the
// Cleanup section before and after the model picker is removed.
// Usage: node build-viewer.mjs <before-dir> <after-dir> <out.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [beforeDir, afterDir, outFile] = process.argv.slice(2)
const sizes = ['1600', '1280', '820']
const modes = ['dark', 'light']
const variants = { before: beforeDir, after: afterDir }
const images = {}
for (const [variant, dir] of Object.entries(variants)) {
  for (const size of sizes) {
    for (const mode of modes) {
      const data = readFileSync(join(dir, `cleanup-${size}-${mode}.png`)).toString('base64')
      images[`${variant}-${size}-${mode}`] = `data:image/png;base64,${data}`
    }
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PROTOTYPE — Cleanup without the model picker</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #111; color: #eee; }
  header { padding: 14px 18px 6px; }
  header h1 { margin: 0 0 4px; font-size: 16px; }
  header p { margin: 0; font-size: 13px; color: #aaa; max-width: 70ch; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 18px; }
  .controls button { background: #222; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .controls button[aria-pressed="true"] { background: #e8e8e8; color: #111; border-color: #e8e8e8; }
  main { padding: 0 18px 90px; }
  main img { max-width: 100%; height: auto; border: 1px solid #333; border-radius: 6px; display: block; }
  .bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 4px;
         background: #ffd400; color: #111; border-radius: 999px; padding: 4px; box-shadow: 0 6px 24px rgba(0,0,0,.5); font: 600 13px system-ui, sans-serif; }
  .bar button { background: transparent; border: 0; font: inherit; width: 32px; height: 32px; border-radius: 999px; cursor: pointer; color: inherit; }
  .bar button:hover, .bar button:focus-visible { background: rgba(0,0,0,.12); }
  .bar span { padding: 0 10px; min-width: 210px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>PROTOTYPE — Settings › Cleanup with one cleanup model</h1>
  <p>Screenshots of the real app, AI formatting on. <b>Before</b> is today's section with the Formatting quality picker. <b>After</b> removes the picker; the toggle keeps its name and nothing names a model. Use ← → to flip. <a href="benchmark.html" style="color:#8cf">Haiku 5.5 benchmark →</a></p>
</header>
<div class="controls" role="group" aria-label="Window size">
  ${sizes.map((s) => `<button type="button" data-size="${s}">${s === '1600' ? '1600 × 1000' : s === '1280' ? '1280 × 800' : '820 × 560 (minimum)'}</button>`).join('')}
</div>
<div class="controls" role="group" aria-label="Appearance">
  ${modes.map((m) => `<button type="button" data-mode="${m}">${m === 'dark' ? 'Dark' : 'Light'}</button>`).join('')}
</div>
<main><img id="shot" alt=""></main>
<nav class="bar" aria-label="Prototype variant">
  <button type="button" id="prev" aria-label="Previous variant">←</button>
  <span id="label"></span>
  <button type="button" id="next" aria-label="Next variant">→</button>
</nav>
<script>
  const images = ${JSON.stringify(images)}
  const variants = [['before', 'Before — quality picker'], ['after', 'After — no picker']]
  const params = new URLSearchParams(location.search)
  let state = {
    variant: params.get('variant') === 'after' ? 'after' : 'before',
    size: ['1600', '1280', '820'].includes(params.get('size')) ? params.get('size') : '1280',
    mode: params.get('mode') === 'light' ? 'light' : 'dark',
  }
  function render() {
    const img = document.getElementById('shot')
    img.src = images[state.variant + '-' + state.size + '-' + state.mode]
    const name = variants.find(([key]) => key === state.variant)[1]
    img.alt = name + ', ' + state.size + ' wide, ' + state.mode
    document.getElementById('label').textContent = name + ' · ' + state.size + ' · ' + state.mode
    for (const b of document.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', String(b.dataset.size === state.size))
    for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode))
    history.replaceState(null, '', '?' + new URLSearchParams(state))
  }
  function step(delta) {
    const i = variants.findIndex(([key]) => key === state.variant)
    state.variant = variants[(i + delta + variants.length) % variants.length][0]
    render()
  }
  document.getElementById('prev').onclick = () => step(-1)
  document.getElementById('next').onclick = () => step(1)
  for (const b of document.querySelectorAll('[data-size]')) b.onclick = () => { state.size = b.dataset.size; render() }
  for (const b of document.querySelectorAll('[data-mode]')) b.onclick = () => { state.mode = b.dataset.mode; render() }
  addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return
    if (e.key === 'ArrowLeft') step(-1)
    if (e.key === 'ArrowRight') step(1)
  })
  render()
</script>
</body>
</html>
`
writeFileSync(outFile, html)
console.log(`wrote ${outFile}`)

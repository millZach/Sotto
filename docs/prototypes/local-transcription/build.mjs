// PROTOTYPE — throwaway. Draws the local-transcription variants on Sotto's own captured markup and
// built stylesheets. Usage: node build.mjs <repo>   (writes ./site)
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = process.argv[2]
const site = join(here, 'site')
mkdirSync(join(site, 'assets'), { recursive: true })
for (const f of readdirSync(join(repo, 'out', 'renderer', 'assets'))) {
  if (/\.(css|woff2)$/.test(f)) copyFileSync(join(repo, 'out', 'renderer', 'assets', f), join(site, 'assets', f))
}
const captured = (name) => readFileSync(join(here, 'captured', `${name}.html`), 'utf8').replace(/<link rel="modulepreload"[^>]*>/g, '').replace(/ crossorigin=""/g, '')

// One replaceable region per template: everything between two markers, inclusive of the first.
function swap(html, start, end, replacement, anchor) {
  const i = html.indexOf(start, anchor ? html.indexOf(anchor) : 0)
  const j = html.indexOf(end, i)
  if (i < 0 || j < 0) throw new Error(`markers not found: ${start.slice(0, 40)} / ${end.slice(0, 40)}`)
  return html.slice(0, i) + replacement + html.slice(j)
}

const bar = (percent) => `<div style="height:6px;border-radius:999px;background:var(--theme-border);overflow:hidden;margin:10px 0 6px"><div style="width:${percent}%;height:100%;background:var(--theme-accent)"></div></div>`
const modelBlock = (state) => {
  const status = {
    ready: '<p class="tt-field__description" style="margin-top:8px"><strong style="color:var(--theme-accent)">Ready.</strong> 670 MB on this computer.</p>',
    downloading: `${bar(42)}<p class="tt-field__description">Downloading · 280 of 670 MB · about 1 minute left</p>`,
    failed: `${bar(42)}<p class="tt-field__description" style="color:var(--theme-error-foreground)">The download stopped at 280 of 670 MB because the connection dropped. Nothing is lost; try again to pick up where it stopped.</p><div style="margin-top:10px"><button type="button" class="tt-button tt-focusable tt-button--secondary">Try again</button></div>`,
  }[state]
  return `<div class="settings-model-statement"><h3>Parakeet v3</h3><p>Speech recognition by NVIDIA, on this computer. Understands 25 European languages and works out which one you speak.</p>${status}</div>`
}
const keyField = (description) => `<div class="key-field"><div class="settings-input-action"><div class="tt-field"><label class="tt-field__label" for="k">OpenRouter API key</label><p class="tt-field__description" id="kd">${description}</p><input class="tt-input tt-focusable" autocomplete="off" placeholder="Paste your key" id="k" aria-describedby="kd" type="password" value=""></div><button type="button" class="tt-button tt-focusable tt-button--secondary">Verify key</button></div></div>`
const toggle = (label, description, on) => `<button type="button" role="switch" aria-label="${label}" aria-checked="${on}" class="tt-toggle tt-focusable"><span class="tt-toggle__track" aria-hidden="true"><span class="tt-toggle__thumb"></span></span><span class="tt-toggle__copy"><strong>${label}</strong><span class="tt-field__description">${description}</span></span></button>`

// ---- Setup variants, drawn on the captured key step ----
const setupTemplate = captured('setup-key')
const setupBody = (stepName, inner, strip = '') => {
  let html = swap(setupTemplate, '<span class="onboarding-progress__text"', '<ol aria-hidden="true">',
    `<span class="onboarding-progress__text" aria-live="polite" aria-atomic="true">Step 4 of 9 · ${stepName}</span>${strip}`)
  html = swap(html, '<section aria-labelledby="onboarding-heading">', '</section></div><footer', `<section aria-labelledby="onboarding-heading">${inner}`)
  return html
}
const downloadPanel = `<div class="tt-field" style="margin-top:18px"><span class="tt-field__label">Parakeet v3, by NVIDIA</span><p class="tt-field__description">670 MB, downloaded once from Sotto's releases on GitHub.</p>${bar(42)}<p class="tt-field__description">280 of 670 MB · about 1 minute left</p></div>`
const variants = {
  'setup-a': {
    label: 'A — Download step',
    html: setupBody('Speech model', `<h1 id="onboarding-heading" tabindex="-1">Download the speech model</h1><p class="onboarding-lead">Sotto turns your voice into text on this computer. Your audio never leaves it.</p>${downloadPanel}<p class="onboarding-aside">You can continue while it downloads. Dictation works as soon as it finishes. AI cleanup is optional; turn it on in Settings → Cleanup.</p>`),
  },
  'setup-b': {
    label: 'B — Download and optional cleanup on one step',
    html: setupBody('Dictation', `<h1 id="onboarding-heading" tabindex="-1">Dictation on this computer</h1><p class="onboarding-lead">Sotto turns your voice into text on this computer. Your audio never leaves it.</p>${downloadPanel}<h2 style="font-size:1rem;margin:26px 0 4px">AI cleanup (optional)</h2><p class="onboarding-aside" style="margin-top:0">Cleanup fixes punctuation, names from your dictionary and self-corrections. It sends the transcript text, never audio, to OpenRouter on your own key.</p>${keyField('Only used for AI cleanup. Stored in your operating system credential store.')}<p class="onboarding-aside">Leave it empty to keep dictation fully private. You can add a key later in Settings → Cleanup.</p>`),
  },
  'setup-c': {
    label: 'C — Download in the background, cleanup step',
    html: setupBody('AI cleanup', `<h1 id="onboarding-heading" tabindex="-1">Turn on AI cleanup?</h1><p class="onboarding-lead">Your voice is turned into text on this computer. Cleanup is optional: it fixes punctuation, names from your dictionary and self-corrections by sending the transcript text, never audio, to OpenRouter on your own key.</p>${keyField('Only used for AI cleanup. Stored in your operating system credential store.')}<p class="onboarding-aside">Skip this step to keep dictation fully private. You can add a key later in Settings → Cleanup.</p>`,
      `<span class="onboarding-progress__text" style="display:block;margin-top:6px;opacity:.85">Downloading the speech model · 280 of 670 MB</span>`),
  },
}

// ---- Settings → Transcription states ----
const transcriptionTemplate = captured('settings-transcription')
const transcription = (state) => swap(transcriptionTemplate, '<div class="settings-rows">', '</section>',
  `<div class="settings-rows">${modelBlock(state)}${toggle('Whitespace formatting', 'Trim and normalize repeated whitespace without changing words.', true)}<p class="settings-disclosure">Your audio is transcribed on this computer and never leaves it. Only AI cleanup, when it is on, sends the transcript text to OpenRouter.</p></div>`, 'id="settings-transcription"')
  .replace('<p>Language &amp; speech to text</p>', '<p>Speech to text, on this computer</p>')
variants['transcription-ready'] = { label: 'Transcription — ready', html: transcription('ready') }
variants['transcription-downloading'] = { label: 'Transcription — downloading', html: transcription('downloading') }
variants['transcription-failed'] = { label: 'Transcription — download failed', html: transcription('failed') }

// ---- Settings → Cleanup: where the key goes ----
const cleanupTemplate = captured('settings-cleanup')
const cleanupToggle = toggle('AI formatting', 'Send transcript text, never audio, to OpenRouter for cleanup. Falls back to the raw transcript if the network is slow or offline.', false)
const cleanupKey = keyField('Only used for AI cleanup. Stored in your operating system credential store.')
const cleanup = (rows) => swap(cleanupTemplate, '<div class="settings-rows"><button type="button" role="switch" aria-label="AI formatting"', '<div class="settings-input-action"><div class="tt-field"><label class="tt-field__label"',
  `<div class="settings-rows">${rows}`).replace('Sent as spelling hints with your audio and used during cleanup.', 'Used during AI cleanup to spell names and terms the way you do.')
variants['cleanup-key-first'] = { label: 'Cleanup — key above the switch', html: cleanup(cleanupKey + cleanupToggle) }
variants['cleanup-toggle-first'] = { label: 'Cleanup — switch, then key', html: cleanup(cleanupToggle + cleanupKey) }

// ---- Pages, with the floating switcher ----
const groups = [
  ['Setup', ['setup-a', 'setup-b', 'setup-c']],
  ['Settings › Transcription', ['transcription-ready', 'transcription-downloading', 'transcription-failed']],
  ['Settings › Cleanup', ['cleanup-key-first', 'cleanup-toggle-first']],
]
const order = groups.flatMap(([, keys]) => keys)
const switcher = (key) => {
  const i = order.indexOf(key)
  const prev = order[(i - 1 + order.length) % order.length]
  const next = order[(i + 1) % order.length]
  return `<nav aria-label="Prototype variant" style="position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:4px;background:#ffd400;color:#111;border-radius:999px;padding:4px;box-shadow:0 6px 24px rgba(0,0,0,.5);font:600 13px system-ui,sans-serif">
<a href="${prev}.html" style="color:#111;text-decoration:none;padding:6px 12px">←</a><a href="index.html" style="color:#111;padding:0 8px;text-decoration:none">${variants[key].label} · ${i + 1}/${order.length}</a><a href="${next}.html" style="color:#111;text-decoration:none;padding:6px 12px">→</a></nav>
<script>addEventListener('keydown',e=>{if(e.target.closest('input,textarea,[contenteditable]'))return;if(e.key==='ArrowLeft')location.href='${prev}.html';if(e.key==='ArrowRight')location.href='${next}.html'})</script>`
}
for (const key of order) writeFileSync(join(site, `${key}.html`), variants[key].html.replace('</body>', `${switcher(key)}</body>`))
const index = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PROTOTYPE — local transcription</title>
<body style="font:15px system-ui,sans-serif;background:#111;color:#eee;max-width:760px;margin:24px auto;padding:0 18px;line-height:1.5">
<h1 style="font-size:20px">PROTOTYPE — Parakeet on this computer</h1>
<p>Sotto's real setup and Settings screens, with the changes drawn in. Arrow keys (or the yellow bar) step through every screen. <a style="color:#8cf" href="benchmark.html">Benchmark →</a></p>
${groups.map(([title, keys]) => `<h2 style="font-size:16px;margin-top:22px">${title}</h2><ul>${keys.map((k) => `<li><a style="color:#8cf" href="${k}.html">${variants[k].label}</a></li>`).join('')}</ul>`).join('')}
<p style="color:#aaa">Dark theme only. The progress bar is drawn for the prototype; the real one uses the theme's tokens.</p></body>`
writeFileSync(join(site, 'index.html'), index)
console.log(`wrote ${order.length + 1} pages to ${site}`)

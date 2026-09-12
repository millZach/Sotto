/* global console, process, require, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
// Controlled oscillator validation. Captures this isolated Electron process tree only.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'sotto-loopback-probe-')))

app.whenReady().then(async () => {
  const { startLoopback, qpcMs } = await import('./loopback.mjs')
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await window.loadURL('data:text/html,<title>Isolated loopback tone probe</title>')
  const capture = await startLoopback(process.pid)
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await delay(150)
  const requestQpcMs = qpcMs()
  await window.webContents.executeJavaScript(`(async () => {
    globalThis.ctx = new AudioContext(); await ctx.resume();
    globalThis.tone = ctx.createOscillator(); const gain = ctx.createGain();
    gain.gain.value = .04; tone.frequency.value = 440;
    tone.connect(gain).connect(ctx.destination); tone.start();
  })()`)
  await delay(700)
  const stopQpcMs = qpcMs()
  await window.webContents.executeJavaScript('tone.stop()')
  await delay(500)
  const endQpcMs = qpcMs()
  const summary = capture.summarize(requestQpcMs, endQpcMs)
  await capture.stop()
  const result = {
    method: 'Process-tree WASAPI; synthetic 440Hz oscillator; no microphone or other processes captured',
    metadata: capture.metadata, requestQpcMs, stopQpcMs, endQpcMs, ...summary,
    onsetMs: summary.firstOutputQpcMs - requestQpcMs,
    stopToSilenceMs: summary.lastOutputQpcMs - stopQpcMs,
    packets: capture.packets
  }
  const output = path.resolve('artifacts/tts-bench/loopback-build/probe.json')
  await fs.writeFile(output, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ output, onsetMs: result.onsetMs, stopToSilenceMs: result.stopToSilenceMs, timestampErrors: result.timestampErrors, discontinuities: result.discontinuities }))
  if (summary.firstOutputQpcMs === null || summary.timestampErrors || result.stopToSilenceMs < -10 || result.stopToSilenceMs > 300) throw new Error('Loopback tone validation failed')
  window.destroy(); app.quit()
}).catch((error) => { console.error(error); app.exit(1) })

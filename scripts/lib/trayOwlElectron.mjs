// Electron entry for scripts/generate-tray-owl.mjs: draws the menu bar owl's frames in a hidden window, and the same
// poses through the prototype's own code, so the generator can compare them. Reads a job JSON, writes a result JSON.
// Works offline: it loads nothing but about:blank and the prototype's local file.
/* global document, window, btoa, ImageData -- the page functions below run in the hidden window */
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { app, BrowserWindow } from 'electron'

const [jobPath, resultPath] = process.argv.slice(-2)

// Every pixel comes from the CPU rasteriser, the same on any Mac, and no dock icon flashes up.
app.disableHardwareAcceleration()
app.dock?.hide()

async function hiddenWindow(url) {
  const win = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { backgroundThrottling: false, sandbox: true } })
  await win.loadURL(url)
  return win
}

// Runs in the page: draws every pose for each palette (base64 RGBA), and the contact sheets asked for (base64 PNG).
function drawAll(draw, poses, palettes, sheets) {
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
  const frames = {}, png = {}
  for (const { body, eyes } of palettes) {
    const all = poses.map(pose => draw(document, pose, body, eyes))
    const out = new Uint8Array(all.length * all[0].length)
    all.forEach((f, i) => out.set(f, i * f.length))
    frames[`${body}-${eyes}`] = b64(out)
    if (!sheets.includes(`${body}-${eyes}`)) continue
    const cols = 13, rows = Math.ceil(all.length / cols), cw = 54 + 6, ch = 44 + 6, strip = rows * ch + 6
    const sheet = document.createElement('canvas'), cell = document.createElement('canvas')
    sheet.width = cols * cw + 6; sheet.height = strip * 2; cell.width = 27; cell.height = 22
    const s = sheet.getContext('2d'), k = cell.getContext('2d')
    s.imageSmoothingEnabled = false
    s.fillStyle = '#26262b'; s.fillRect(0, 0, sheet.width, strip)
    s.fillStyle = '#ebebef'; s.fillRect(0, strip, sheet.width, strip)
    for (const y0 of [0, strip]) all.forEach((f, i) => {
      k.putImageData(new ImageData(new Uint8ClampedArray(f), 27, 22), 0, 0)
      s.drawImage(cell, 6 + (i % cols) * cw, y0 + 6 + Math.floor(i / cols) * ch, 54, 44)
    })
    png[`${body}-${eyes}`] = sheet.toDataURL('image/png').split(',')[1]
  }
  return { frames, png }
}

// Runs in the prototype's page: its own variant A frames at 1x, as base64 RGBA.
function prototypeFrames(poses, palettes) {
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
  const owl = window.__owl, out = {}
  for (const { body, eyes } of palettes) {
    owl.O.tone = body; owl.O.glow = eyes; owl.setVariant('A')
    const all = poses.map(pose => owl.frame(pose, 1).getContext('2d').getImageData(0, 0, 27, 22).data)
    const bytes = new Uint8Array(all.length * all[0].length)
    all.forEach((f, i) => bytes.set(f, i * f.length))
    out[`${body}-${eyes}`] = b64(bytes)
  }
  return out
}

async function run() {
  const job = JSON.parse(await readFile(jobPath, 'utf8'))
  const blank = await hiddenWindow('about:blank')
  const args = [job.poses, job.palettes, job.sheets].map(value => JSON.stringify(value)).join(',')
  const drawn = await blank.webContents.executeJavaScript(`(${drawAll})(${job.drawSource}, ${args})`)
  let prototype = {}
  if (job.prototypeUrl) {
    const page = await hiddenWindow(job.prototypeUrl)
    prototype = await page.webContents.executeJavaScript(`(${prototypeFrames})(${JSON.stringify(job.poses)}, ${JSON.stringify(job.comparePalettes)})`)
  }
  await writeFile(resultPath, JSON.stringify({ ...drawn, prototype }))
}

app.whenReady().then(run).then(() => app.exit(0), error => {
  process.stderr.write(`tray owl render failed: ${error instanceof Error ? error.message : String(error)}\n`)
  app.exit(1)
})

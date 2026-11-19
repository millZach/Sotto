// The Electron helper: no window of its own, one page off screen, each frame's dmabuf handed to the Rust window.
// fd 3 is a SOCK_SEQPACKET socket from the window (frames up, with SCM_RIGHTS). stdin carries acks and input down.
// stdout carries JSON lines (state, stats). Ends when stdin ends.
'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fdpass = require(path.join(__dirname, 'fdpass.node'))

const SOCK = Number(process.env.WPE_SOCK_FD || 3)
const format = process.env.WPE_FORMAT || 'argb'
const [W, H] = (process.env.WPE_VIEW || '1280x800').split('x').map(Number)
const t0 = Number(process.env.WPE_SPAWNED_MS || Date.now())
const out = o => process.stdout.write(JSON.stringify(o) + '\n')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const held = new Map() // seq -> { texture, sent }
const stats = { paints: 0, withTexture: 0, withoutTexture: 0, sendErrors: 0, released: 0, releasedUnacked: 0, formats: {}, planes: {}, modifiers: {}, roundTripUs: [] }
let seq = 0, win = null, first = true

function header(info, plane, nplanes, s) {
  const b = Buffer.alloc(64)
  const mod = BigInt(info.handle.nativePixmap.modifier)
  const fmt = { rgba: 0, bgra: 1, rgbaf16: 2 }[info.pixelFormat] ?? 9
  const f = [1, info.codedSize.width, info.codedSize.height, plane.stride, plane.offset >>> 0, Math.floor(plane.offset / 2 ** 32),
    Number(mod & 0xffffffffn), Number(mod >> 32n), fmt, s, plane.size >>> 0, Math.floor(plane.size / 2 ** 32), nplanes]
  f.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4))
  return b
}

function release(s, acked) {
  const h = held.get(s); if (!h) return
  held.delete(s); h.texture.release(); stats.released++
  if (acked) { if (stats.roundTripUs.length < 100000) stats.roundTripUs.push(Number(process.hrtime.bigint() - h.sent) / 1000) }
  else stats.releasedUnacked++
}

app.whenReady().then(() => {
  win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, frame: false, skipTaskbar: true,
    webPreferences: { offscreen: { useSharedTexture: process.env.WPE_SHARED !== '0', sharedTexturePixelFormat: format }, backgroundThrottling: false } })
  win.webContents.setFrameRate(60)
  // A display smaller than the pane clamps the window; ask again for the pane's size.
  win.setContentSize(W, H)
  out({ ev: 'size', asked: [W, H], got: win.getContentSize() })
  if (process.env.WPE_MUTED !== '0') win.webContents.setAudioMuted(true)
  win.webContents.on('paint', (details, dirty, image) => {
    stats.paints++
    const texture = details.texture
    if (!texture) { stats.withoutTexture++; if (first) { first = false; out({ ev: 'first-paint-no-texture', imageEmpty: image ? image.isEmpty() : null, ms: Date.now() - t0 }) } return }
    stats.withTexture++
    const info = texture.textureInfo
    const np = info.handle && info.handle.nativePixmap
    stats.formats[info.pixelFormat] = (stats.formats[info.pixelFormat] || 0) + 1
    if (first) { first = false; out({ ev: 'first-texture', ms: Date.now() - t0, info: { widgetType: info.widgetType, pixelFormat: info.pixelFormat, codedSize: info.codedSize, visibleRect: info.visibleRect, colorSpace: info.colorSpace, planes: np && np.planes.map(p => ({ stride: p.stride, offset: p.offset, size: p.size, fd: p.fd })), modifier: np && np.modifier, supportsZeroCopyWebGpuImport: np && np.supportsZeroCopyWebGpuImport } }) }
    if (!np || !np.planes.length || info.widgetType !== 'frame') { texture.release(); return }
    stats.planes[np.planes.length] = (stats.planes[np.planes.length] || 0) + 1
    stats.modifiers[np.modifier] = (stats.modifiers[np.modifier] || 0) + 1
    const s = ++seq
    const sent = process.hrtime.bigint()
    const n = fdpass.send(SOCK, header(info, np.planes[0], np.planes.length, s), np.planes[0].fd)
    if (n !== 64) { stats.sendErrors++; texture.release(); return }
    held.set(s, { texture, sent })
    // Never hold the pool hostage: a frame the window has not acked within a second goes back anyway.
    setTimeout(() => release(s, false), 1000)
  })
  win.webContents.on('did-finish-load', () => {
    out({ ev: 'loaded', ms: Date.now() - t0 })
    // Control: Chromium's own copy of the same page, not through the shared texture.
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage()
        const bmp = img.toBitmap(); let nonblack = 0, n = 0
        for (let i = 0; i < bmp.length; i += 4 * 97) { n++; if (Math.max(bmp[i], bmp[i + 1], bmp[i + 2]) > 16) nonblack++ }
        if (process.env.WPE_CAPTURE_PNG) require('node:fs').writeFileSync(process.env.WPE_CAPTURE_PNG, img.toPNG())
        out({ ev: 'capture-page', size: img.getSize(), nonblackSampled: nonblack, of: n })
      } catch (e) { out({ ev: 'capture-page-error', e: String(e) }) }
    }, 3000)
  })
  win.webContents.on('render-process-gone', (_e, d) => out({ ev: 'render-gone', d }))
  app.on('child-process-gone', (_e, d) => out({ ev: 'child-gone', d }))
  win.loadFile(path.join(__dirname, 'page.html'))
  setInterval(async () => {
    try { out({ ev: 'state', ms: Date.now() - t0, state: await win.webContents.executeJavaScript('window.__state && window.__state()'), stats: summary() }) } catch (e) { out({ ev: 'state-error', e: String(e) }) }
  }, 1000)
})

function summary() {
  const rt = [...stats.roundTripUs].sort((a, b) => a - b)
  const pct = p => rt.length ? Math.round(rt[Math.floor((rt.length - 1) * p)]) : null
  return { ...stats, roundTripUs: { n: rt.length, p50: pct(0.5), p95: pct(0.95), max: pct(1) }, held: held.size }
}

// Down: "A <seq>" acks a frame; "C x y" clicks; "T text" types; "K key" presses one key.
let pending = ''
process.stdin.on('data', d => {
  pending += d
  let i
  while ((i = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, i); pending = pending.slice(i + 1)
    const [cmd, ...rest] = line.split(' ')
    const wc = win && win.webContents
    if (cmd === 'A') release(Number(rest[0]), true)
    else if (cmd === 'C' && wc) { const [x, y] = rest.map(Number); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }) }
    else if (cmd === 'T' && wc) { for (const ch of rest.join(' ')) { wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch }) } }
    else if (cmd === 'F' && wc) { wc.focus() }
  }
})
process.stdin.on('end', () => { out({ ev: 'stopping', stats: summary() }); for (const s of [...held.keys()]) release(s, false); app.quit() })
app.on('window-all-closed', () => {})

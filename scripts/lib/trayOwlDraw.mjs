// The menu bar owl's drawing (ADR-0113): the approved prototype's variant A (docs/prototypes/menubar-owl-prototype.html),
// ported line for line with its exact colours and geometry. scripts/generate-tray-owl.mjs injects `drawOwlFrame` as
// source into a hidden Electron page, so it closes over nothing: every constant lives inside it. The body and eye
// swatches in src/shared/menuBarOwl.ts are TONES[body].b0 and GLOWS[eyes].c; keep them equal.

/** The choices, in the order of MENU_BAR_OWL_BODIES and MENU_BAR_OWL_EYES (tests/unit/release/trayOwlAssets.test.ts checks). */
export const TRAY_OWL_BODIES = Object.freeze(['slate', 'ink', 'light'])
export const TRAY_OWL_EYES = Object.freeze(['teal', 'ice', 'amber'])

/**
 * Draws `p` (a pose from src/main/tray/owl/poses.mjs) at 1x on a fresh 27x22 canvas made from `doc`, in the body
 * colour `body` and eye colour `eyes`, and returns its straight-alpha RGBA pixels.
 */
export function drawOwlFrame(doc, p, body, eyes) {
  const { Path2D } = globalThis
  const W = 27, H = 22, K = 0.86, YB = 15.9, CX = W / 2
  const D = {
    body: 'M1.27 4.8C0.84 3.93 0.73 2.31 1.49 1.22C1.63 0.95 1.93 0.68 2.06 1.22C2.12 2.03 2.71 2.9 3.93 2.9C5.83 2.2 10.17 1.76 12.94 3.34C13.69 3.28 14.4 2.71 14.45 1.82C14.51 1.57 14.73 1.57 14.83 1.98C15.32 2.58 15.54 4.26 14.94 5.56C15.38 6.1 15.7 7.46 15.7 9.63C15.76 12.12 15.29 13.37 13.97 14.24C12.75 15.19 10.17 15.24 8 15.24C5.8 15.24 3.23 15.19 2.01 14.24C0.68 13.37 0.22 12.12 0.27 9.63C0.24 7.19 0.52 5.83 1.27 4.8Z',
    eL: 'M1.84 8.95C1.82 7.05 2.25 6.07 3.66 6.07C5.34 6.02 6.75 6.21 6.73 8.54C6.73 10.44 6.1 11.31 4.34 11.31C2.58 11.34 1.82 10.58 1.84 8.95Z',
    eR: 'M9.33 9.22C9.33 8.14 9.63 7.67 10.44 7.46L13.1 6.92C13.8 6.78 14.13 7.46 14.13 8.81C14.16 10.71 13.69 11.34 11.66 11.34C10.17 11.34 9.33 10.71 9.33 9.22Z',
  }
  const P = {}
  for (const k in D) P[k] = new Path2D(D[k])
  const EC = [[4.3, 8.7, 0.7, -0.35], [11.7, 9.1, -0.65, -0.2]]
  const hex = (h, a = 1) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})` }
  const GLOWS = {
    teal: { c: '#47b8a9', hi: '#e8fffb', mid: '#74e6d4', lo: '#1c8a7e', pup: '#02100e' },
    ice: { c: '#5ec8ff', hi: '#effaff', mid: '#8ad8ff', lo: '#1f7fb8', pup: '#020d16' },
    amber: { c: '#ffb44a', hi: '#fff4dc', mid: '#ffcb6e', lo: '#b86a12', pup: '#150a02' },
  }
  const TONES = {
    ink: { b0: '#2c3748', b1: '#151b26', ol: '#070a0f', rim: '#96acc8', wing: '#3a475d', wl: '#252f40', edge: '#a8bcd8', fea: '#10151e', sock: '#03070b', lid: '#1f2836', toe: '#c9ad7a', beak: '#ecb64e', belly: '#aac3e1' },
    slate: { b0: '#7f8fa6', b1: '#56647a', ol: '#222c3a', rim: '#e6eefa', wing: '#7482a0', wl: '#505d75', edge: '#d8e4f4', fea: '#34405a', sock: '#05101a', lid: '#5b6a82', toe: '#dcc08c', beak: '#f1b94d', belly: '#f0f6ff' },
    light: { b0: '#dde2ea', b1: '#aab3c2', ol: '#5a6578', rim: '#ffffff', wing: '#c9d0dc', wl: '#9ca6b7', edge: '#ffffff', fea: '#6c778a', sock: '#0a121c', lid: '#aab3c2', toe: '#caa86c', beak: '#e8a93a', belly: '#ffffff' },
  }
  const WOOD = { hl: '#cfa26a', mid: '#9c673b', lo: '#5d3a1e', grain: '#341d0c', knot: '#47301a', ring: '#c39460', twig: '#80532d', leaf: '#56ad82', leaf2: '#3d8a66' }
  const T = TONES[body], G = GLOWS[eyes]
  if (!T || !G) throw new Error(`Unknown menu bar owl palette: ${body}-${eyes}`)

  function smooth(c, pts, move) {
    if (move) c.moveTo(pts[0][0], pts[0][1]); else c.lineTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length - 1; i++) c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)
    const l = pts[pts.length - 1]
    c.lineTo(l[0], l[1])
  }
  function branch(c) {
    const top = [[2.4, 15.45], [6.5, 15.2], [11, 15.35], [16, 15.3], [20.5, 14.9], [24.7, 14.1]], th = [2.7, 2.9, 2.9, 2.8, 2.4, 1.8]
    const bot = top.map((pt, i) => [pt[0], pt[1] + th[i]]).reverse()
    c.beginPath(); smooth(c, top, 1); c.quadraticCurveTo(25.4, 14.6, 25, 15.9); smooth(c, bot, 0); c.quadraticCurveTo(1.6, 16.8, 2.4, 15.45); c.closePath()
    const g = c.createLinearGradient(0, 14.9, 0, 18.4); g.addColorStop(0, WOOD.hl); g.addColorStop(0.32, WOOD.mid); g.addColorStop(1, WOOD.lo); c.fillStyle = g; c.fill()
    c.save(); c.lineCap = 'round'; c.strokeStyle = hex(WOOD.grain, 0.5); c.lineWidth = 0.5
    for (const [a, b, y, e] of [[4.8, 7.8, 16.8, 0.25], [11, 14.4, 17.4, -0.2], [16.5, 20, 16.6, 0.2], [21.2, 23.4, 16.2, 0]]) { c.beginPath(); c.moveTo(a, y); c.quadraticCurveTo((a + b) / 2, y + e, b, y); c.stroke() }
    c.restore()
    c.save(); c.strokeStyle = hex('#f1c88e', 0.55); c.lineWidth = 0.5; c.beginPath(); smooth(c, top.map(pt => [pt[0] + 0.3, pt[1] + 0.45]), 1); c.stroke(); c.restore()
    c.save(); c.fillStyle = WOOD.knot; c.beginPath(); c.ellipse(8.8, 16.85, 0.78, 0.52, -0.1, 0, 7); c.fill(); c.restore()
    c.fillStyle = WOOD.ring; c.beginPath(); c.ellipse(2.6, 16.85, 0.65, 1.28, 0.05, 0, 7); c.fill()
    c.save(); c.strokeStyle = hex(WOOD.knot, 0.6); c.lineWidth = 0.3; c.beginPath(); c.ellipse(2.65, 16.85, 0.28, 0.6, 0.05, 0, 7); c.stroke(); c.restore()
    c.strokeStyle = WOOD.twig; c.lineWidth = 0.8; c.lineCap = 'round'; c.beginPath(); c.moveTo(19.8, 15.1); c.quadraticCurveTo(21, 13.1, 22.3, 12.4); c.stroke()
    c.fillStyle = WOOD.leaf; c.beginPath(); c.ellipse(22.9, 11.7, 1.25, 0.6, -0.95, 0, 7); c.fill()
    c.fillStyle = WOOD.leaf2; c.beginPath(); c.ellipse(21.2, 13.2, 0.85, 0.42, 0.5, 0, 7); c.fill()
  }
  function wingShape(c, r, w, ghost) {
    const tips = [[-r + 0.5, 1], [-r * 0.8, 2.3], [-r * 0.6, 3.4], [-r * 0.38, 4.2]], e = [1, -1.5 * w], q0 = [-r, -0.4 * w], pa = new Path2D()
    pa.moveTo(e[0], e[1]); pa.quadraticCurveTo(-r * 0.45, -3.1 * w, q0[0], q0[1]); let q = q0
    for (const t of tips) { const y = t[1] * w; pa.quadraticCurveTo((q[0] + t[0]) / 2 + 0.55, (q[1] + y) / 2 - 0.2 * w, t[0], y); q = [t[0], y] }
    pa.lineTo(1, 4.3 * w); pa.closePath()
    if (!ghost) { c.save(); c.lineJoin = 'round'; c.strokeStyle = hex(T.ol, 0.85); c.lineWidth = 0.95; c.stroke(pa); c.restore() }
    const g = c.createLinearGradient(0, -3 * w, 0, 4.3 * w); g.addColorStop(0, T.wing); g.addColorStop(1, T.wl); c.fillStyle = g; c.fill(pa)
    if (ghost) return
    c.save(); c.globalCompositeOperation = 'source-over'; c.strokeStyle = hex(T.fea, 0.6); c.lineWidth = 0.6; c.lineCap = 'round'
    for (let i = 0; i < 3; i++) {
      const a = tips[i], b = tips[i + 1], mx = (a[0] + b[0]) / 2 + 0.55, my = (a[1] + b[1]) * w / 2 - 0.2 * w, x0 = -r * 0.2, y0 = (1.2 + i * 0.8) * w
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + (mx - x0) * 0.85, y0 + (my - y0) * 0.85); c.stroke()
    }
    c.restore()
    c.strokeStyle = hex(T.edge, 0.85); c.lineWidth = 0.5; c.beginPath(); c.moveTo(e[0], e[1]); c.quadraticCurveTo(-r * 0.45, -3.1 * w, q0[0], q0[1]); c.stroke()
  }
  function wings(c, front) {
    for (const side of [0, 1]) {
      const th = side && p.thR != null ? p.thR : p.th, fold = th < -45
      if (fold !== front) continue
      const put = (ang, a, ghost) => {
        c.save(); c.globalAlpha = a
        if (side) { c.translate(16, 0); c.scale(-1, 1) }
        if (front) c.clip(P.body)
        c.translate(front ? 2.3 : 1.2, 10.3); c.rotate(ang * Math.PI / 180); wingShape(c, p.r, front ? 0.5 : 1, ghost); c.restore()
      }
      if (!front && p.sm) put(th + p.sm, 0.3, 1)
      put(th, 1)
    }
  }
  const eyeAt = i => { const e = EC[i]; return [e[0] + e[2] * 0.65 + p.lx * 0.55, e[1] + e[3] * 0.65 + p.ly * 0.4] }
  function eyesOf(c) {
    const gl = p.glow, ga = [0.5, 0.85, 1][gl], ir = [1.5, 1.65, 1.85][gl], pr = [0.95, 0.9, 0.7][gl]
    EC.forEach((e, i) => {
      const path = i ? P.eR : P.eL, [x, y] = eyeAt(i), top = i ? 6.8 : 6.05
      c.save(); c.clip(path)
      c.fillStyle = T.sock; c.fillRect(0, 0, 16, 16)
      let g = c.createRadialGradient(x, y, 0.4, x, y, 3.7); g.addColorStop(0, hex(G.c, 0.65 * ga)); g.addColorStop(1, hex(G.c, 0)); c.fillStyle = g; c.fillRect(0, 0, 16, 16)
      g = c.createRadialGradient(x, y, 0, x, y, ir); g.addColorStop(0, G.hi); g.addColorStop(0.5, G.mid); g.addColorStop(1, G.lo); c.fillStyle = g; c.beginPath(); c.arc(x, y, ir, 0, 7); c.fill()
      c.fillStyle = G.pup; c.beginPath(); c.arc(x + p.lx * 0.7, y + p.ly * 0.45, pr * 0.62, 0, 7); c.fill()
      c.fillStyle = 'rgba(255,255,255,.95)'; c.beginPath(); c.arc(x - 0.5, y - 0.55, 0.34, 0, 7); c.fill()
      if (p.lid > 0) {
        const yy = top - 0.4 + (11.34 - top + 0.9) * p.lid
        c.fillStyle = T.lid; c.fillRect(0, 0, 16, yy)
        c.fillStyle = hex(T.sock, 0.9); c.fillRect(0, yy - 0.2, 16, 0.4)
      }
      c.restore()
      if (p.lid > 0.99) {
        c.save(); c.strokeStyle = hex(G.mid, 0.75)
        c.lineWidth = 0.55; c.lineCap = 'round'; c.beginPath(); c.moveTo(e[0] - 1.5, e[1] + 0.3); c.quadraticCurveTo(e[0], e[1] + 1.2, e[0] + 1.5, e[1] + 0.3); c.stroke(); c.restore()
      }
    })
  }
  function spill(c) {
    const a = [0.14, 0.28, 0.42][p.glow] * (1 - p.lid)
    if (a <= 0) return
    EC.forEach((e, i) => { const [x, y] = eyeAt(i), g = c.createRadialGradient(x, y, 0.6, x, y, 5.8); g.addColorStop(0, hex(G.c, a)); g.addColorStop(1, hex(G.c, 0)); c.fillStyle = g; c.fillRect(x - 6.5, y - 6.5, 13, 13) })
  }
  function bodyOf(c) {
    c.save(); c.lineJoin = 'round'; c.strokeStyle = hex(T.ol, 0.9); c.lineWidth = 1.2; c.stroke(P.body); c.restore()
    let g = c.createLinearGradient(0, 1, 0, 15.3); g.addColorStop(0, T.b0); g.addColorStop(1, T.b1); c.fillStyle = g; c.fill(P.body)
    c.save(); c.clip(P.body)
    g = c.createLinearGradient(0, 0, 16, 16); g.addColorStop(0, hex(T.rim, 0.85)); g.addColorStop(0.55, hex(T.rim, 0.18)); g.addColorStop(1, hex(T.rim, 0.1)); c.strokeStyle = g; c.lineWidth = 1.15; c.stroke(P.body)
    c.fillStyle = hex(T.sock, 0.3); c.beginPath(); c.ellipse(8, 8.9, 7.4, 3.5, 0, 0, 7); c.fill()
    g = c.createRadialGradient(8, 13.6, 0.3, 8, 13.6, 4.6); g.addColorStop(0, hex(T.belly, 0.2)); g.addColorStop(1, hex(T.belly, 0)); c.fillStyle = g; c.fillRect(0, 9, 16, 7)
    c.restore()
  }
  function toes(c) {
    c.strokeStyle = T.toe; c.lineWidth = 0.75; c.lineCap = 'round'
    for (const x of [5.3, 10.7]) for (const d of [-0.95, 0, 0.95]) { c.beginPath(); c.moveTo(x + d * 0.3, 14.6); c.lineTo(x + d, 16.15); c.stroke() }
  }
  function beak(c) { c.fillStyle = T.beak; c.beginPath(); c.moveTo(7.3, 9.5); c.quadraticCurveTo(8, 9.15, 8.7, 9.5); c.lineTo(8, 11.15); c.closePath(); c.fill() }

  const cv = doc.createElement('canvas')
  cv.width = W; cv.height = H
  const c = cv.getContext('2d', { willReadFrequently: true })
  c.save(); c.translate(0, 0.5); branch(c); c.restore(); c.save()
  c.translate(CX, YB - p.lift); c.rotate(p.tilt * Math.PI / 180); c.scale(1 / Math.sqrt(p.sq), p.sq); c.scale(K, K); c.translate(-8, -15.24)
  toes(c); wings(c, false); bodyOf(c); wings(c, true); eyesOf(c); spill(c); beak(c); c.restore()
  return c.getImageData(0, 0, W, H).data
}

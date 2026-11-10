// PROTOTYPE, throwaway. Everything the prototype adds to the night wood's picture, drawn through the hook the real
// painter already gives a place for what moves in it (scenePlace.ts, `Ambience`): glyphs in the theme's ink or accent,
// one to a cell, held to the column's share and ink ceiling, never under still words, a star or an owl. Nothing here
// touches a canvas; the real painter draws every glyph.
import { clamp, gridFor, groundAt, lerp, rampGlyph, seeded, type Point, type SceneLayout } from '@w/nightScene'
import type { NightScenePainter } from '@w/nightScenePainter'
import type { Ambience, AmbientGlyph } from '@w/scenePlace'
import { activity, fast, has, hash, LIFE, threadOf, type Happening } from './life'

export interface River { readonly at: (share: number) => Point }

/** The night wood's river, as placeNightWood.ts draws it: from the far hills to the front of the left margin. */
export function riverPath(g: SceneLayout): River {
  const edge = g.column.left - 14, sky = g.sky
  const a = { x: edge * 0.8, y: g.horizon + 6 }, c1 = { x: edge * 0.55, y: g.horizon + sky * 0.14 }, c2 = { x: edge * 0.7, y: g.groundY - sky * 0.03 }
  const b = { x: edge * 0.35, y: g.groundY + 20 }, q = { x: edge * 0.12, y: g.groundY + 45 }, c = { x: -10, y: g.height }
  const pts: Array<Point & { d: number }> = []
  const push = (x: number, y: number): void => { const last = pts[pts.length - 1]; pts.push({ x, y, d: last === undefined ? 0 : last.d + Math.hypot(x - last.x, y - last.y) }) }
  for (let k = 0; k <= 40; k++) { const u = k / 40, v = 1 - u; push(v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x, v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y) }
  for (let k = 1; k <= 24; k++) { const u = k / 24, v = 1 - u; push(v * v * b.x + 2 * v * u * q.x + u * u * c.x, v * v * b.y + 2 * v * u * q.y + u * u * c.y) }
  const length = pts[pts.length - 1]!.d
  return {
    at(share) {
      const target = clamp(share, 0, 1) * length
      let k = 1
      while (k < pts.length - 1 && pts[k]!.d < target) k++
      const p = pts[k - 1]!, n = pts[k]!, u = n.d === p.d ? 0 : (target - p.d) / (n.d - p.d)
      return { x: lerp(p.x, n.x, u), y: lerp(p.y, n.y, u) }
    },
  }
}

/** How hard the wind blows at `x`: a faint breeze, and each gust's front as it crosses from the left. */
export function windAt(x: number, t: number): number {
  let wind = 0.08
  for (const h of LIFE.happenings) if (h.kind === 'gust') { const d = (x - (-220 + (t - h.t0) * 320)) / 190; wind += h.strength * Math.exp(-d * d) }
  return Math.min(1, wind)
}

const FOX_WALK = [['~-.__/\\°>', '   /|  |\\ '], ['~-.__/\\°>', '   |\\  /| ']] as const
const FOX_STOP = ['~-.__/\\°>', '   ||  || '] as const

export function makeAmbience(g: SceneLayout, painter: NightScenePainter): Ambience {
  const grid = gridFor(g.width, g.height), { cols, rows, cw, ch } = grid
  const W = g.width, H = g.height, sky = g.sky
  const river = riverPath(g)
  const R = seeded(71)
  const flies = Array.from({ length: 16 }, (_, k) => ({
    x: k % 2 === 0 ? lerp(10, Math.max(12, g.column.left - 26), R()) : lerp(Math.min(W - 12, g.column.right + 26), W - 10, R()),
    y: lerp(g.horizon + sky * 0.16, Math.min(H - 16, g.groundY + 74), R()), p1: R() * 6.28, p2: R() * 6.28, p3: R() * 6.28, w: 0.2 + R() * 0.16,
  }))
  const wisps = [g.horizon + sky * 0.03, g.horizon + sky * 0.1, g.groundY - sky * 0.09, g.groundY - sky * 0.035].map((y, k) => ({ y, len: 26 + k * 7, speed: 5 + k * 1.6, x0: hash(k, 9) * (W + 400) }))
  // The grass: one cell a column, where the blades' tips are.
  const grass = Array.from({ length: cols }, (_, c) => { const x = (c + 0.5) * cw; return { x, y: (Math.floor((groundAt(g, x) - 7) / ch) + 0.5) * ch } })
  // The two crowns, read from the painter's own landscape the first time they are needed.
  let crown: Array<{ readonly i: number; readonly x: number; readonly y: number; readonly high: number }> | null = null
  let land = new Float32Array(0), noise = new Float32Array(0), lookGlyph: Uint16Array | null = null, lookStrength = new Float32Array(0)
  const readCrowns = (): void => {
    const p = painter as unknown as { land: Float32Array; noise: Float32Array; lookGlyph: Uint16Array | null; lookStrength: Float32Array }
    land = p.land; noise = p.noise; lookGlyph = p.lookGlyph; lookStrength = p.lookStrength
    crown = []
    for (const tree of [g.left, g.right]) {
      const top = tree.y - tree.h * 1.02, bottom = tree.y - tree.h * 0.66
      const c0 = clamp(Math.floor((tree.x - tree.h * 0.42) / cw), 1, cols - 1), c1 = clamp(Math.ceil((tree.x + tree.h * 0.42) / cw), 1, cols - 1)
      for (let r = clamp(Math.floor(top / ch), 0, rows - 1); r <= clamp(Math.floor(bottom / ch), 0, rows - 1); r++) for (let c = c0; c <= c1; c++) {
        const i = r * cols + c, x = (c + 0.5) * cw, y = (r + 0.5) * ch
        if (Math.hypot(x - g.moon.x, y - g.moon.y) < g.moon.r * 2.9) continue
        if ((land[i] ?? 0) >= 0.1 || (land[i - 1] ?? 0) >= 0.1) crown.push({ i, x, y, high: clamp((bottom - y) / Math.max(1, bottom - top), 0, 1) })
      }
    }
  }

  return {
    // As often as the stars twinkle while nothing is switched on, eight times a second otherwise, and more while
    // something quick crosses.
    get steps() { return LIFE.flags.size === 0 ? 2 : !LIFE.still && fast(LIFE.now) ? 24 : 8 },
    most: 900,
    cells(t, emit: AmbientGlyph) {
      if (LIFE.flags.size === 0) return
      const still = LIFE.still
      const sprite = (lines: readonly string[], x: number, y: number, strength: number, accents = ''): void => {
        const w = Math.max(...lines.map(line => line.length)), c0 = Math.round(x / cw - w / 2), r0 = Math.floor((y - 1) / ch) - lines.length + 1
        lines.forEach((line, k) => { for (let j = 0; j < line.length; j++) if (line[j] !== ' ') emit((c0 + j + 0.5) * cw, (r0 + k + 0.5) * ch, line[j]!, accents.includes(line[j]!), strength, true) })
      }
      const meteor = (m: Happening, tau: number): void => {
        if (tau < 0 || tau > m.life + 0.3) return
        const head = Math.min(tau, m.life), fade = tau > m.life ? clamp(1 - (tau - m.life) / 0.3, 0, 1) : 1
        for (let j = 0; j < 13; j++) {
          const s = head - j * 0.011
          if (s < 0) break
          const x = m.x0 + m.dx * m.speed * s, y = m.y0 + m.dy * m.speed * s
          if (j === 0) { if (tau <= m.life) emit(x, y, '*', true, 1, true); continue }
          emit(x, y, j < 4 ? '=' : j < 8 ? '-' : '·', j < 5, (0.9 - j * 0.06) * fade, true)
        }
      }

      // ---------- What is happening right now, in front of everything else ----------
      if (!still) for (const h of LIFE.happenings) {
        const tau = t - h.t0
        if (tau < 0 || tau > h.dur) continue
        if (h.kind === 'star') meteor(h, tau)
        else if (h.kind === 'meteors') for (const m of h.list) meteor(m, tau - m.at)
        else if (h.kind === 'note') {
          const k = clamp(tau / h.dur, 0, 1), e = k * k * (3 - 2 * k)
          const at = (u: number): Point => { const v = 1 - u, mx = (h.from.x + h.to.x) / 2, my = Math.min(h.from.y, h.to.y) - h.lift; return { x: v * v * h.from.x + 2 * v * u * mx + u * u * h.to.x, y: v * v * h.from.y + 2 * v * u * my + u * u * h.to.y } }
          const p = at(e)
          emit(p.x, p.y, '♪', h.accent, 1, true)
          for (const [back, strength] of [[0.05, 0.55], [0.1, 0.32]] as const) if (e - back > 0) { const q = at(e - back); emit(q.x, q.y, '·', h.accent, strength, false) }
        } else if (h.kind === 'sparkle') {
          const k = tau / h.dur
          for (let j = 0; j < 12; j++) {
            const a = j / 12 * Math.PI * 2 + h.spin, r = 10 + 58 * (1 - (1 - k) ** 2) * (0.6 + 0.4 * hash(j, 3))
            emit(h.x + Math.cos(a) * r, h.y - 20 + Math.sin(a) * r * 0.62, k < 0.35 ? '*' : k < 0.7 ? '+' : '·', true, 1 - k * 0.8, true)
          }
        } else if (h.kind === 'bats') {
          for (const bat of h.bats) {
            const x = h.from === null ? W + 30 + bat.dx - 150 * tau : h.from.x + bat.vx * tau, y = h.from === null ? bat.y + 9 * Math.sin(tau * 2.3 + bat.ph) : h.from.y + bat.vy * tau + 7 * Math.sin(tau * 3 + bat.ph)
            const wings = Math.floor(tau * 7 + bat.ph) % 2 === 0 ? '^v^' : '-v-'
            for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, wings[j]!, false, 0.85, true)
          }
        } else if (h.kind === 'fox') {
          const speed = 95, toStop = (h.stopX + 70) / speed, pause = 2
          const stopped = tau >= toStop && tau < toStop + pause
          const x = tau < toStop ? -70 + speed * tau : stopped ? h.stopX : h.stopX + speed * (tau - toStop - pause)
          // Its feet are in the row above the ground's edge, so it walks on the ground rather than in it.
          const y = Math.floor(groundAt(g, x) / ch) * ch
          sprite(stopped ? FOX_STOP : FOX_WALK[Math.floor(tau * 6) % 2]!, x, y, 0.9, '°')
          if (stopped && tau - toStop > 0.35 && tau - toStop < 1.7) emit(x + 40, y - 30, '?', true, 0.9, true)
        } else if (h.kind === 'mouse') {
          let x = tau < h.run ? lerp(h.x0, h.x1, tau / h.run) : h.x1
          if (h.boltAt !== null) x = h.x1 + (t - h.boltAt) * 420
          const y = groundAt(g, x) - 3
          for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, '~o>'[j]!, j === 1, 0.9, true)
        } else if (h.kind === 'fish') {
          if (tau < 0.9) {
            const k = tau / 0.9, x = h.x - 14 + 28 * k, y = h.y - 42 * Math.sin(Math.PI * k)
            for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, '><>'[j]!, true, 1, true)
            if (tau < 0.45) for (const side of [-1, 1]) emit(h.x - 14 + side * (6 + tau * 30), h.y - 8 - tau * 26, "'", true, 0.7 - tau, true)
          } else {
            const k = (tau - 0.9) / (h.dur - 0.9), r = 6 + 36 * k, x = h.x + 14
            emit(x - r, h.y, '(', true, 0.9 * (1 - k), true); emit(x + r, h.y, ')', true, 0.9 * (1 - k), true)
            if (r > 16) { emit(x - r / 2, h.y, '~', true, 0.5 * (1 - k), true); emit(x + r / 2, h.y, '~', true, 0.5 * (1 - k), true) }
            if (k < 0.45) for (const side of [-1, 0, 1]) emit(x + side * (8 + k * 22), h.y - 10 - 34 * k + 60 * k * k, side === 0 ? '.' : "'", true, 0.8 - k, true)
          }
        }
      }

      // ---------- What a thread owl's state adds over its head ----------
      for (const pose of LIFE.poses) {
        if (pose.flying || pose.alpha < 0.9) continue
        const column = Math.round(pose.x / cw - 2.5) + 2, top = Math.floor((pose.y - 1) / ch) - 3
        if (has('wave') && pose.owl.mood === 'waiting') {
          // A row clear of the owl's glow, which the painter lays over the row above its head, and bobbing a row higher.
          const up = still ? 0 : Math.floor(t * 2) % 2
          emit((column + 0.5) * cw, (top - 1 - up + 0.5) * ch, threadOf(pose.owl.key)?.ask === 'permission' ? '!' : '?', true, 1, true)
        }
        if (has('sleepZ') && pose.owl.mood === 'asleep' && threadOf(pose.owl.key)?.state !== 'failed') {
          const tau = still ? 1.2 : (t + pose.owl.order * 1.9) % 5.6
          if (tau < 2.9) for (let stage = 0; stage <= Math.min(2, Math.floor(tau / 0.9)); stage++) {
            emit((column + 2 + stage + 0.5) * cw, (top - stage + 0.5) * ch, stage === 2 ? 'Z' : 'z', false, [0.62, 0.5, 0.4][stage]!, false)
          }
        }
      }

      // ---------- Fireflies: fewer the busier the room, when the wood mirrors it ----------
      if (has('fireflies')) {
        const count = has('mirror') ? Math.round(lerp(16, 5, activity())) : 14
        const pointer = has('gaze') && LIFE.pointer !== null && LIFE.now - LIFE.pointer.t < 2 ? LIFE.pointer : null
        flies.forEach((fly, k) => {
          if (k >= count) return
          let x = fly.x + 26 * Math.sin(t * 0.31 + fly.p1) + 9 * Math.sin(t * 1.3 + fly.p2), y = fly.y + 12 * Math.sin(t * 0.43 + fly.p3) + 5 * Math.sin(t * 1.7 + fly.p1)
          if (pointer !== null) { const dx = x - pointer.x, dy = y - pointer.y, d = Math.hypot(dx, dy) || 1; if (d < 90) { x += dx / d * (90 - d) * 0.8; y += dy / d * (90 - d) * 0.8 } }
          const phase = (t * fly.w + fly.p2) % 1, glow = still ? (k % 3 === 0 ? 0.9 : 0) : phase < 0.4 ? Math.sin(phase / 0.4 * Math.PI) : 0
          if (glow < 0.12) return
          emit(x, y, glow > 0.7 ? '*' : glow > 0.35 ? '°' : '·', true, 0.45 + 0.55 * glow, false)
        })
      }

      // ---------- Wind: leaves off Watcher's tree, the grass leaning, the crowns swaying ----------
      if (has('wind') && !still) {
        for (const h of LIFE.happenings) if (h.kind === 'gust') for (const leaf of h.leaves) {
          const s = t - h.t0 - leaf.delay
          if (s < 0 || s > 2.8) continue
          emit(leaf.x + 250 * s + 6 * s * s, leaf.y + 26 * s + 14 * Math.sin(s * 5 + leaf.ph) + 9 * s * s, ",'`."[Math.floor(s * 7 + leaf.ph) % 4]!, false, 0.75 - s * 0.2, false)
        }
      }

      // ---------- The river runs toward you, faster the busier the room ----------
      if (has('river')) {
        const speed = has('mirror') ? lerp(0.025, 0.085, activity()) : 0.055
        for (let k = 0; k < 18; k++) {
          const share = (k / 18 + t * speed * (0.8 + 0.4 * hash(k, 31))) % 1
          if (!still && hash(k, Math.floor(t * 2), 5) < 0.15) continue
          const p = river.at(share)
          emit(p.x + (hash(k, 37) - 0.5) * (4 + 14 * share), p.y, share > 0.6 ? '~' : share > 0.3 ? '-' : '·', true, 0.45 + 0.4 * hash(k, 41), true)
        }
      }

      if (has('wind') && !still) {
        if (crown === null) readCrowns()
        for (let c = 0; c < cols; c++) {
          const blade = grass[c]!, wind = windAt(blade.x, t)
          // Each blade leans once the wind passes its own threshold, so the front is ragged and never a solid run.
          if (wind < 0.3 + 0.6 * hash(c, 43)) continue
          emit(blade.x, blade.y, '/', false, 0.5, true)
        }
        for (const cell of crown!) {
          if (windAt(cell.x, t) < 0.52 - 0.14 * cell.high) continue
          // Drawn by shape, the crown sways in the characters the painter picked for it.
          if (lookGlyph !== null) {
            const code = lookGlyph[cell.i - 1] ?? 0
            emit(cell.x, cell.y, code === 0 ? ' ' : String.fromCharCode(code), false, code === 0 ? 0.1 : lookStrength[cell.i - 1]!, true)
            continue
          }
          const d = land[cell.i - 1] ?? 0
          if (d >= 0.1) emit(cell.x, cell.y, rampGlyph(clamp(d + ((noise[cell.i - 1] ?? 0.5) - 0.5) * 0.1, 0, 1)), false, 0.1 + 0.5 * d, true)
          else emit(cell.x, cell.y, ' ', false, 0.1, true)
        }
      }

      // ---------- A cloud over the moon ----------
      if (!still) for (const h of LIFE.happenings) {
        const tau = t - h.t0
        if (h.kind !== 'cloud' || tau < 0 || tau > h.dur) continue
        const cx = h.x0 - 22 * tau, shift = Math.floor(cx / cw), fade = Math.min(1, tau / 1.5, (h.dur - tau) / 1.5)
        for (let r = Math.floor((h.y - h.ry) / ch); r <= Math.ceil((h.y + h.ry) / ch); r++) for (let c = Math.floor((cx - h.rx) / cw); c <= Math.ceil((cx + h.rx) / cw); c++) {
          const x = (c + 0.5) * cw, y = (r + 0.5) * ch, dx = (x - cx) / h.rx, dy = (y - h.y) / h.ry
          const v = 1 - dx * dx - dy * dy - hash(c - shift, r, 5) * 0.45 + 0.18 * Math.sin((c - shift) * 0.9 + r * 1.7)
          if (v <= 0.05) continue
          emit(x, y, v > 0.55 ? '=' : v > 0.3 ? '~' : v > 0.15 ? '-' : '·', false, (0.24 + 0.3 * Math.min(1, v)) * fade, true)
        }
      }

      // ---------- Mist between the hills, thicker when the room is quiet ----------
      if (has('mist')) {
        const thick = has('mirror') ? lerp(1.25, 0.35, activity()) : 1
        wisps.forEach((wisp, k) => {
          const start = Math.floor(((((wisp.x0 - t * wisp.speed) % (W + 400)) + W + 400) % (W + 400) - 200) / cw), row = Math.floor(wisp.y / ch)
          for (let j = 0; j < wisp.len; j++) {
            const taper = Math.sin(Math.PI * j / wisp.len)
            for (const [line, share] of [[0, 1], [1, 0.55]] as const) {
              if (hash(j, k * 2 + line, 17) > (0.25 + 0.5 * taper) * share * thick) continue
              const pick = hash(j, k * 2 + line, 23)
              emit((start + j + 0.5) * cw, (row + line + 0.5) * ch, pick < 0.4 ? '~' : pick < 0.75 ? '-' : '·', false, 0.2 + 0.14 * taper, false)
            }
          }
        })
      }
    },
  }
}

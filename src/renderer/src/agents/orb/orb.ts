/*
 * The agent orb: a port of design/redesign-3/orb.js.
 *
 * A subdivided icosphere (uniform triangle mesh, no poles) displaced by three
 * octaves of 3D Perlin noise, drawn as additive strokes in three passes: a wide
 * bloom, a tight bloom and a sharp pass. Alpha rises toward the silhouette so
 * the rim reads as the bright band, and colour runs diagonally across the
 * screen (colour A top-left, colour B bottom-right) with the brightest edges
 * pushed toward white. The maths is the mockup's, unchanged; only the surface
 * differs: a handle with pause/resume so a hidden room costs no frames, and a
 * `still` mode that draws exactly one frame for reduced motion and captures.
 */

export type OrbState = 'idle' | 'wake' | 'listening' | 'speaking' | 'working'
export type OrbPreset = 'teal' | 'violet' | 'ice' | 'amber' | 'mono'
export type OrbColors = OrbPreset | readonly [string, string]

type Rgb = readonly [number, number, number]

function hex(value: string): Rgb {
  const n = parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
const rgba = (c: Rgb, alpha: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`
const WHITE: Rgb = [255, 255, 255]

export const ORB_PRESETS: Readonly<Record<OrbPreset, readonly [string, string]>> = {
  violet: ['#4f7dff', '#e04cff'],
  ice: ['#bff4ff', '#5cc8ff'],
  teal: ['#9df0e3', '#2c7a72'],
  amber: ['#ffd89a', '#e0701a'],
  mono: ['#ffffff', '#8a9099'],
}

/**
 * The light room shows the orb through `invert(1) hue-rotate(180deg)`, which
 * turns its additive glow into ink. That filter is its own inverse up to the
 * white point (hue-rotate by 180 degrees squares to identity and keeps white),
 * so drawing `hueRotate180(1 - c)` makes colour `c` the one that is seen.
 * Channels a saturated colour pushes out of range are clipped.
 */
export const ORB_INK_FILTER = 'invert(1) hue-rotate(180deg)'

/** The Filter Effects hue-rotate matrix at 180 degrees (cos -1, sin 0), unclamped. */
function hueRotate180([r, g, b]: readonly [number, number, number]): [number, number, number] {
  return [
    -0.574 * r + 1.43 * g + 0.144 * b,
    0.426 * r + 0.43 * g + 0.144 * b,
    0.426 * r + 1.43 * g - 0.856 * b,
  ]
}

const inRange = (channels: readonly number[]): boolean => channels.every(channel => channel >= -1e-6 && channel <= 1 + 1e-6)
const toHex = (channels: readonly number[]): string =>
  `#${channels.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('')}`

/**
 * The most saturated version of `visible` the ink filter can show. A colour
 * whose rotation leaves the unit cube would clip into a different hue, so it
 * is pulled toward the grey of equal luminance (which the rotation keeps)
 * until it fits; hue and lightness hold, only chroma gives.
 */
export function inkableColor(visible: string): string {
  const color = hex(visible).map(channel => channel / 255) as [number, number, number]
  if (inRange(hueRotate180(color))) return visible
  const grey = 0.213 * color[0] + 0.715 * color[1] + 0.072 * color[2]
  const toward = (amount: number): [number, number, number] => color.map(channel => grey + (channel - grey) * amount) as [number, number, number]
  let low = 0
  let high = 1
  for (let step = 0; step < 16; step += 1) {
    const middle = (low + high) / 2
    if (inRange(hueRotate180(toward(middle)))) low = middle
    else high = middle
  }
  return toHex(toward(low))
}

export function colorBeneathInkFilter(visible: string): string {
  const seen = hex(inkableColor(visible)).map(channel => channel / 255) as [number, number, number]
  return toHex(hueRotate180(seen.map(channel => 1 - channel) as [number, number, number]))
}

/** The colours to draw so the pair is what appears through the canvas's CSS filter. */
export function orbColorsBeneath(filter: string, visible: readonly [string, string]): readonly [string, string] {
  if (filter.trim() !== ORB_INK_FILTER) return visible
  return [colorBeneathInkFilter(visible[0]), colorBeneathInkFilter(visible[1])]
}

interface Motion { amp: number; flow: number; spin: number; pulse: number; glow: number }

/** Motion per state: amp scales the lumps, flow evolves the noise field, spin rotates, pulse breathes, glow multiplies bloom. */
export const ORB_STATES: Readonly<Record<OrbState, Motion>> = {
  idle: { amp: 0.55, flow: 0.25, spin: 0.04, pulse: 0.0, glow: 0.7 },
  wake: { amp: 0.85, flow: 0.45, spin: 0.06, pulse: 0.0, glow: 1.0 },
  listening: { amp: 1.05, flow: 0.9, spin: 0.08, pulse: 0.06, glow: 1.15 },
  speaking: { amp: 1.35, flow: 1.4, spin: 0.1, pulse: 0.03, glow: 1.25 },
  working: { amp: 0.75, flow: 0.6, spin: 0.22, pulse: 0.0, glow: 0.9 },
}

/** The look. The mockup's TUNE block, verbatim. */
export const ORB_TUNE = {
  density: 4, // icosphere subdivision level: 3 (642 verts), 4 (2562), 5 (10242)
  radius: 0.23, // sphere radius as a fraction of min(canvas w, h)
  amp: 0.18, // displacement amplitude (multiplied by the state's amp)
  lump: 2.2, // frequency of the big lumps
  ripple: 6.4, // frequency of the medium ripples
  rippleMix: 1.0, // how much medium ripple is added
  grain: 9.5, // frequency of the fine grain
  grainMix: 0.1, // how much fine grain is added
  line: 0.5, // sharp line width in CSS px
  alpha: 0.46, // overall line opacity
  rim: 0.9, // how much the silhouette brightens
  back: 0.24, // opacity of the far side relative to the near side
  hot: 0.1, // how far the brightest edges push toward white
  bloom: 0.85, // bloom strength
  bloomWide: 27, // wide bloom blur in CSS px
  bloomTight: 9, // tight bloom blur in CSS px
  fill: 1.0, // interior glow
  halo: 0.2, // outer halo behind the orb
  dust: 220, // number of dust points
  tilt: -0.75, // camera tilt in radians
  perspective: 0.6,
}
export type OrbTune = typeof ORB_TUNE

// ---- improved Perlin noise (Ken Perlin 2002), 3D ----
const perm = new Uint8Array(512)
;(function seedPermutation(): void {
  const p: number[] = []
  for (let i = 0; i < 256; i++) p[i] = i
  let s = 1337
  const r = (): number => (s = (s * 16807) % 2147483647) / 2147483647
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0
    const t = p[i]!
    p[i] = p[j]!
    p[j] = t
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!
})()
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a: number, b: number, t: number): number => a + t * (b - a)
function grad(h: number, x: number, y: number, z: number): number {
  switch (h & 15) {
    case 0: return x + y
    case 1: return -x + y
    case 2: return x - y
    case 3: return -x - y
    case 4: return x + z
    case 5: return -x + z
    case 6: return x - z
    case 7: return -x - z
    case 8: return y + z
    case 9: return -y + z
    case 10: return y - z
    case 11: return -y - z
    case 12: return y + x
    case 13: return -y + z
    case 14: return y - x
    default: return -y - z
  }
}
export function noise(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const Z = Math.floor(z) & 255
  x -= Math.floor(x)
  y -= Math.floor(y)
  z -= Math.floor(z)
  const u = fade(x)
  const v = fade(y)
  const w = fade(z)
  const A = perm[X]! + Y
  const AA = perm[A]! + Z
  const AB = perm[A + 1]! + Z
  const B = perm[X + 1]! + Y
  const BA = perm[B]! + Z
  const BB = perm[B + 1]! + Z
  return lerp(
    lerp(lerp(grad(perm[AA]!, x, y, z), grad(perm[BA]!, x - 1, y, z), u), lerp(grad(perm[AB]!, x, y - 1, z), grad(perm[BB]!, x - 1, y - 1, z), u), v),
    lerp(lerp(grad(perm[AA + 1]!, x, y, z - 1), grad(perm[BA + 1]!, x - 1, y, z - 1), u), lerp(grad(perm[AB + 1]!, x, y - 1, z - 1), grad(perm[BB + 1]!, x - 1, y - 1, z - 1), u), v),
    w,
  )
}

// ---- icosphere ----
type Vertex = [number, number, number]
interface Mesh { readonly verts: readonly Vertex[]; readonly edges: readonly (readonly [number, number])[] }
const meshCache = new Map<number, Mesh>()
export function icosphere(level: number): Mesh {
  const cached = meshCache.get(level)
  if (cached !== undefined) return cached
  const t = (1 + Math.sqrt(5)) / 2
  const norm = (v: Vertex): Vertex => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l] }
  const verts: Vertex[] = ([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as Vertex[]).map(norm)
  let faces: [number, number, number][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let l = 0; l < level; l++) {
    const mid = new Map<number, number>()
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a
      const known = mid.get(key)
      if (known !== undefined) return known
      const va = verts[a]!
      const vb = verts[b]!
      verts.push(norm([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]))
      mid.set(key, verts.length - 1)
      return verts.length - 1
    }
    const next: [number, number, number][] = []
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }
  const edgeSet = new Set<number>()
  const edges: [number, number][] = []
  for (const [a, b, c] of faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = p < q ? p * 65536 + q : q * 65536 + p
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push(p < q ? [p, q] : [q, p])
    }
  }
  const mesh: Mesh = { verts, edges }
  meshCache.set(level, mesh)
  return mesh
}

export interface OrbOptions {
  readonly colors?: OrbColors
  readonly state?: OrbState
  /** Draw one settled frame and stop: reduced motion and design captures. */
  readonly still?: boolean
  readonly tune?: Partial<OrbTune>
}

export interface OrbHandle {
  setState(state: OrbState): void
  setColors(colors: OrbColors): void
  /** Freeze on one settled frame, or resume the loop. */
  setStill(still: boolean): void
  /** Stop the frame loop while the room is hidden; `resume` restarts it. */
  pause(): void
  resume(): void
  /** Redraw now (after a layout change while still or paused). */
  redraw(): void
  dispose(): void
  readonly colors: () => readonly [string, string]
  readonly settings: () => OrbTune
}

function resolvePair(colors: OrbColors): readonly [string, string] {
  return typeof colors === 'string' ? ORB_PRESETS[colors] : colors
}

/**
 * Mount the orb on a canvas. Returns `null` when the canvas has no 2D context
 * (jsdom, a lost context), so callers can treat the orb as decoration.
 */
export function createOrb(canvas: HTMLCanvasElement, options: OrbOptions = {}): OrbHandle | null {
  const context = canvas.getContext('2d')
  if (context === null) return null
  const ctx: CanvasRenderingContext2D = context
  const doc = canvas.ownerDocument
  // Bloom is computed at quarter resolution: stroke into `glow`, blur into
  // `wide` and `tight`, then upscale. The blur hides the low resolution.
  const glow = doc.createElement('canvas')
  const wide = doc.createElement('canvas')
  const tight = doc.createElement('canvas')
  const glowContext = glow.getContext('2d')
  const wideContext = wide.getContext('2d')
  const tightContext = tight.getContext('2d')
  if (glowContext === null || wideContext === null || tightContext === null) return null
  const gctx: CanvasRenderingContext2D = glowContext
  const wctx: CanvasRenderingContext2D = wideContext
  const tctx: CanvasRenderingContext2D = tightContext
  const Q = 0.25
  const tune: OrbTune = { ...ORB_TUNE, ...(options.tune ?? {}) }
  const mesh = icosphere(tune.density)

  let seed = 7
  const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647
  const dust: [number, number, number, number][] = []
  seed = 7
  for (let i = 0; i < tune.dust; i++) {
    const u = rand() * 2 - 1
    const ph = rand() * 6.283
    const r = 1.25 + rand() * 0.75
    const s = Math.sqrt(1 - u * u)
    dust.push([s * Math.cos(ph) * r, u * r, s * Math.sin(ph) * r, 0.4 + rand() * 0.6])
  }

  let pair = resolvePair(options.colors ?? 'teal')
  let A = hex(pair[0])
  let B = hex(pair[1])
  let target: Motion = ORB_STATES[options.state ?? 'wake']
  const cur: Motion = { ...target }
  let still = options.still === true
  // A still orb starts mid-flight so its one frame reads as a settled, organic shape.
  let t = still ? 3.7 : 0
  let spin = still ? 0.6 : 0
  let running = true
  let paused = false
  let frame: number | null = null
  const view = canvas.ownerDocument.defaultView ?? window

  // colour lookup: 12 hue steps x 4 heat steps
  const HUES = 12
  const HEAT = 4
  let palette: Rgb[] = []
  const buildPalette = (): void => {
    palette = []
    for (let h = 0; h < HUES; h++) {
      const base = mix(A, B, h / (HUES - 1))
      for (let k = 0; k < HEAT; k++) palette.push(mix(base, WHITE, (k / (HEAT - 1)) * tune.hot))
    }
  }
  buildPalette()

  const ALPHAS = 10
  const bucketCount = HUES * HEAT * ALPHAS
  const buckets: (Path2D | null)[] = new Array<Path2D | null>(bucketCount).fill(null)

  const schedule = (): void => {
    if (!running || still || paused || frame !== null) return
    frame = view.requestAnimationFrame(() => { frame = null; draw() })
  }

  function draw(): void {
    const dpr = view.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    if (cw === 0 || ch === 0) { schedule(); return }
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
    }
    const w = canvas.width
    const h = canvas.height
    const gw = Math.max(2, Math.round(w * Q))
    const gh = Math.max(2, Math.round(h * Q))
    for (const c of [glow, wide, tight]) if (c.width !== gw || c.height !== gh) { c.width = gw; c.height = gh }

    const ease = still ? 1 : 0.05
    for (const k of Object.keys(target) as (keyof Motion)[]) cur[k] += (target[k] - cur[k]) * ease
    const dt = 0.016
    if (!still) { t += dt * cur.flow; spin += dt * cur.spin }

    const R = Math.min(w, h) * tune.radius * (1 + cur.pulse * Math.sin(t * 3.2))
    const cx = w / 2
    const cy = h / 2
    const ca = Math.cos(spin)
    const sa = Math.sin(spin)
    const cb = Math.cos(tune.tilt)
    const sb = Math.sin(tune.tilt)
    const ampNow = tune.amp * cur.amp

    // ---- displace and project ----
    const V = mesh.verts
    const n = V.length
    const sx = new Float32Array(n)
    const sy = new Float32Array(n)
    const sz = new Float32Array(n)
    const rimv = new Float32Array(n)
    const huev = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = V[i]!
      const big = noise(v[0] * tune.lump + t * 0.31, v[1] * tune.lump - t * 0.23, v[2] * tune.lump + t * 0.17)
      const med = noise(v[0] * tune.ripple - t * 0.5, v[1] * tune.ripple + t * 0.4, v[2] * tune.ripple - t * 0.3)
      const fine = noise(v[0] * tune.grain + t, v[1] * tune.grain - t * 0.8, v[2] * tune.grain + t * 0.6)
      const d = big + med * tune.rippleMix + fine * tune.grainMix
      const r = 1 + ampNow * d
      const x = v[0] * r
      const y = v[1] * r
      const z = v[2] * r
      // rotate: spin about y, then tilt about x
      const X = x * ca - z * sa
      let Z = x * sa + z * ca
      const Y = y * cb - Z * sb
      Z = y * sb + Z * cb
      const p = 1 / (1 - Z * tune.perspective)
      sx[i] = cx + X * R * p
      sy[i] = cy + Y * R * p
      sz[i] = Z
      // rim: how grazing the surface is to the camera (normal ~ radial direction)
      const nz = Z / Math.hypot(X, Y, Z)
      rimv[i] = Math.pow(1 - Math.abs(nz), 2)
      // hue runs from A (top-left) to B (bottom-right) on screen
      huev[i] = Math.max(0, Math.min(1, 0.5 + (X + Y) * 0.36))
    }

    // ---- bucket edges by colour and alpha ----
    buckets.fill(null)
    const E = mesh.edges
    for (let e = 0; e < E.length; e++) {
      const a = E[e]![0]
      const b = E[e]![1]
      const z = (sz[a]! + sz[b]!) / 2
      const front = (z + 1) / 2
      const rim = (rimv[a]! + rimv[b]!) / 2
      const depthAlpha = tune.back + (1 - tune.back) * front * front
      let al = tune.alpha * depthAlpha * (0.35 + rim * tune.rim)
      if (al > 1) al = 1
      const ai = Math.min(ALPHAS - 1, (al * ALPHAS) | 0)
      if (ai === 0 && al < 0.03) continue
      const hi = Math.round(((huev[a]! + huev[b]!) / 2) * (HUES - 1))
      const ki = Math.min(HEAT - 1, (rim * front * 2.2 * (HEAT - 1)) | 0)
      const key = (hi * HEAT + ki) * ALPHAS + ai
      let path = buckets[key]
      if (path === null || path === undefined) { path = new Path2D(); buckets[key] = path }
      path.moveTo(sx[a]!, sy[a]!)
      path.lineTo(sx[b]!, sy[b]!)
    }

    // ---- background: halo and interior fill ----
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.clearRect(0, 0, w, h)
    const m = mix(A, B, 0.5)
    if (tune.halo > 0) {
      // the halo must reach zero inside the canvas or its edge shows as a box
      const edge = Math.min(cx, cy)
      const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, edge)
      halo.addColorStop(0, rgba(m, tune.halo * cur.glow))
      halo.addColorStop(0.4, rgba(m, tune.halo * cur.glow * 0.22))
      halo.addColorStop(0.85, rgba(m, tune.halo * cur.glow * 0.02))
      halo.addColorStop(1, rgba(m, 0))
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, w, h)
    }
    if (tune.fill > 0) {
      const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (1 + ampNow * 0.6))
      inner.addColorStop(0, rgba(mix(m, WHITE, 0.25), tune.fill * 0.55))
      inner.addColorStop(0.7, rgba(m, tune.fill * 0.35))
      inner.addColorStop(1, rgba(m, 0))
      ctx.fillStyle = inner
      ctx.fillRect(0, 0, w, h)
    }

    // ---- glow passes: stroke the same paths at quarter resolution, then blur up ----
    const strokeAll = (c: CanvasRenderingContext2D, width: number, alphaMul: number): void => {
      c.lineWidth = width
      c.lineCap = 'round'
      for (let key = 0; key < bucketCount; key++) {
        const path = buckets[key]
        if (path === null || path === undefined) continue
        const ai = key % ALPHAS
        const ci = (key / ALPHAS) | 0
        const al = Math.min(1, ((ai + 0.5) / ALPHAS) * alphaMul)
        c.strokeStyle = rgba(palette[ci]!, al)
        c.stroke(path)
      }
    }
    if (tune.bloom > 0) {
      gctx.setTransform(Q, 0, 0, Q, 0, 0)
      gctx.globalCompositeOperation = 'source-over'
      gctx.clearRect(0, 0, w, h)
      gctx.globalCompositeOperation = 'lighter'
      strokeAll(gctx, (dpr * 0.8) / Q, 0.75)
      const blurInto = (c: CanvasRenderingContext2D, px: number): void => {
        c.setTransform(1, 0, 0, 1, 0, 0)
        c.filter = 'none'
        c.clearRect(0, 0, gw, gh)
        c.filter = `blur(${Math.max(0.5, px * dpr * Q)}px)`
        c.drawImage(glow, 0, 0)
        c.filter = 'none'
      }
      blurInto(wctx, tune.bloomWide)
      blurInto(tctx, tune.bloomTight)
      ctx.globalCompositeOperation = 'lighter'
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.globalAlpha = Math.min(1, 0.7 * tune.bloom * cur.glow)
      ctx.drawImage(wide, 0, 0, gw, gh, 0, 0, w, h)
      ctx.globalAlpha = Math.min(1, 0.55 * tune.bloom * cur.glow)
      ctx.drawImage(tight, 0, 0, gw, gh, 0, 0, w, h)
      ctx.globalAlpha = 1
    }

    // ---- sharp pass ----
    ctx.globalCompositeOperation = 'lighter'
    strokeAll(ctx, dpr * tune.line, 1)

    // ---- dust ----
    for (let i = 0; i < dust.length; i++) {
      const d = dust[i]!
      const x = d[0]
      const y = d[1]
      const z = d[2]
      const X = x * ca - z * sa
      let Z = x * sa + z * ca
      const Y = y * cb - Z * sb
      Z = y * sb + Z * cb
      const p = 1 / (1 - Z * tune.perspective)
      const px = cx + X * R * p
      const py = cy + Y * R * p
      const c = mix(A, B, Math.max(0, Math.min(1, 0.5 + (X + Y) * 0.3)))
      const al = (0.1 + (Z + 1) * 0.28) * d[3]
      ctx.fillStyle = rgba(c, al)
      const s = dpr * (0.8 + d[3] * 0.8)
      ctx.fillRect(px - s / 2, py - s / 2, s, s)
    }
    ctx.globalCompositeOperation = 'source-over'
    schedule()
  }

  const cancel = (): void => {
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null }
  }

  draw()

  return {
    setState(state) { target = ORB_STATES[state]; if (still) draw() },
    setColors(colors) { pair = resolvePair(colors); A = hex(pair[0]); B = hex(pair[1]); buildPalette(); if (still) draw() },
    setStill(next) {
      if (still === next) return
      still = next
      if (still) { cancel(); t = 3.7; spin = 0.6; draw() } else if (!paused) draw()
    },
    pause() { if (paused) return; paused = true; cancel() },
    resume() { if (!paused) return; paused = false; if (running) draw() },
    redraw() { if (still || paused) draw() },
    dispose() { running = false; cancel() },
    colors: () => pair,
    settings: () => ({ ...tune }),
  }
}

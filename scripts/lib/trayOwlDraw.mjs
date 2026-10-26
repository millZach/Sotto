// The menu bar owl's drawing (ADR-0137): Night, a crescent moon with the owl's eyes in its dark side and one star, from
// the approved prototype docs/prototypes/menubar-icon-night-prototype.html (design N). Drawn pixel by pixel on an 18x18
// grid at 1x, with no anti-aliasing: the blocky look is the point. The body and eye swatches in src/shared/menuBarOwl.ts
// are TONES[body].b0 and GLOWS[eyes].c; keep them equal.

/** The choices, in the order of MENU_BAR_OWL_BODIES and MENU_BAR_OWL_EYES (tests/unit/release/trayOwlAssets.test.ts checks). */
export const TRAY_OWL_BODIES = Object.freeze(['slate', 'ink', 'light'])
export const TRAY_OWL_EYES = Object.freeze(['teal', 'ice', 'amber'])

const TONES = {
  slate: { b0: '#7f8fa6' },
  ink: { b0: '#2c3748' },
  light: { b0: '#dde2ea' },
}
const GLOWS = {
  teal: { c: '#47b8a9', hi: '#e8fffb', mid: '#74e6d4', lo: '#1c8a7e' },
  ice: { c: '#5ec8ff', hi: '#effaff', mid: '#8ad8ff', lo: '#1f7fb8' },
  amber: { c: '#ffb44a', hi: '#fff4dc', mid: '#ffcb6e', lo: '#b86a12' },
}

const W = 18, H = 18

const inDisc = (x, y, cx, cy, r) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r
const rgb = hex => { const n = Number.parseInt(hex.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255] }

/**
 * Draws `p` (a pose from src/main/tray/owl/poses.mjs) in the moon colour `body` and eye colour `eyes`, and returns its
 * straight-alpha RGBA pixels. Night reads the owl's poses: `lx`, `ly` move the eyes a point, `lid` blinks them (half, then
 * shut), and `glow` 2 flares them; through a flap (`glow` 2) the star flickers, bright while the wings are up (`th` > 0)
 * and faint while they are down. The wings, lean and hop themselves are not drawn.
 */
export function drawOwlFrame(p, body, eyes) {
  const tone = TONES[body], glow = GLOWS[eyes]
  if (!tone || !glow) throw new Error(`Unknown menu bar owl palette: ${body}-${eyes}`)
  const out = new Uint8Array(W * H * 4)
  const put = (x, y, hex, alpha = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 4, [r, g, b] = rgb(hex)
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = Math.round(alpha * 255)
  }
  const moon = tone.b0

  // The crescent: a disc with a smaller one taken out of its upper right. The dark side is left clear, so the bar shows
  // through it.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (inDisc(x, y, 9, 9.5, 8) && !inDisc(x, y, 12.6, 7.4, 6.6)) put(x, y, moon)
  }

  // The star: resting, or flickering through a flap.
  const flaring = p.glow === 2 && p.th !== -100
  if (flaring && p.th > 0) {
    put(16, 2, moon)
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) put(16 + dx, 2 + dy, moon, 0.6)
  } else {
    put(16, 2, moon, flaring ? 0.4 : 1)
  }

  // The eyes: two 2x2 lights four points apart, each with a one-point glint.
  const ex = 10 + Math.round(p.lx), ey = 8 + Math.round(p.ly)
  for (const x of [ex, ex + 4]) {
    if (p.lid >= 1) {
      put(x, ey + 1, glow.lo); put(x + 1, ey + 1, glow.lo)
    } else if (p.lid > 0) {
      put(x, ey + 1, glow.c); put(x + 1, ey + 1, glow.c)
    } else {
      const base = p.glow === 2 ? glow.mid : glow.c
      put(x, ey, glow.hi); put(x + 1, ey, base); put(x, ey + 1, base); put(x + 1, ey + 1, base)
    }
  }
  return out
}

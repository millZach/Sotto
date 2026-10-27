/*
 * PROTOTYPE, throwaway. Shared by appearance-page-prototype.html and appearance-themes-prototype.html:
 * the theme palettes (the three Sotto keeps plus the five proposed in place of Linen, Nocturne and Tropic),
 * a small Sotto window that paints from them (Threads sidebar, transcript, composer, Watcher's room) and the
 * night scene. Nothing here is saved; every choice lives in memory.
 */
(function () {
  'use strict'

  // Each half carries the roles the small window paints from. Sotto, Hush and Citrine are the shipped values
  // from src/shared/themes/palettes.ts; the five proposed ones are new.
  const THEMES = {
    sotto: {
      label: 'Sotto', note: 'Warm paper by day, ink by night, the app icon’s teal.', kept: true,
      light: { canvas: 'oklch(0.978 0.004 85)', sidebar: 'oklch(0.955 0.008 85)', raised: 'oklch(0.955 0.006 85)', message: 'oklch(0.93 0.012 85)', code: 'oklch(0.96 0.005 85)', text: 'oklch(0.235 0.014 75)', text2: 'oklch(0.5 0.014 75)', muted: 'oklch(0.5 0.014 75)', border: 'oklch(0.86 0.012 80)', accent: 'oklch(0.53 0.095 186)', accentFg: 'oklch(0.99 0.003 85)', rowSel: 'oklch(0.895 0.028 188)' },
      dark: { canvas: 'oklch(0.115 0.008 265)', sidebar: 'oklch(0.235 0.003 265)', raised: 'oklch(0.185 0.008 265)', message: 'oklch(0.205 0.014 265)', code: 'oklch(0.155 0.008 265)', text: 'oklch(0.985 0.005 280)', text2: 'oklch(0.72 0.014 265)', muted: 'oklch(0.72 0.014 265)', border: 'oklch(0.305 0.02 265)', accent: 'oklch(0.714 0.104 183)', accentFg: 'oklch(0.16 0.012 190)', rowSel: 'oklch(0.355 0.035 188)' },
    },
    hush: {
      label: 'Hush', note: 'Fog grey with a sage whisper.', kept: true,
      light: { canvas: 'oklch(0.963 0.004 106)', sidebar: 'oklch(0.918 0.0067 162)', raised: 'oklch(0.913 0.0048 162)', message: 'oklch(0.863 0.013 162)', code: 'oklch(0.928 0.004 162)', text: 'oklch(0.2 0.007 164)', text2: 'oklch(0.53 0.005 146)', muted: 'oklch(0.527 0.005 146)', border: 'oklch(0.843 0.006 162)', accent: 'oklch(0.502 0.028 162)', accentFg: 'oklch(0.99 0.008 325)', rowSel: 'oklch(0.863 0.013 162)' },
      dark: { canvas: 'oklch(0.22 0.0036 165)', sidebar: 'oklch(0.265 0.0067 163)', raised: 'oklch(0.27 0.0048 163)', message: 'oklch(0.36 0.0147 163)', code: 'oklch(0.255 0.004 163)', text: 'oklch(0.95 0.0075 165)', text2: 'oklch(0.636 0.0057 165)', muted: 'oklch(0.636 0.0057 165)', border: 'oklch(0.38 0.0064 163)', accent: 'oklch(0.749 0.031 163)', accentFg: 'oklch(0.222 0.035 329)', rowSel: 'oklch(0.36 0.0147 163)' },
    },
    citrine: {
      label: 'Citrine', note: 'Signal yellow on carbon.', kept: true,
      light: { canvas: 'oklch(0.972 0.008 99)', sidebar: 'oklch(0.927 0.0087 92)', raised: 'oklch(0.922 0.0062 92)', message: 'oklch(0.872 0.04 92)', code: 'oklch(0.937 0.005 92)', text: 'oklch(0.202 0.03 93)', text2: 'oklch(0.538 0.019 94)', muted: 'oklch(0.533 0.019 94)', border: 'oklch(0.852 0.0099 92)', accent: 'oklch(0.552 0.113 92)', accentFg: 'oklch(0.99 0.008 325)', rowSel: 'oklch(0.872 0.04 92)' },
      dark: { canvas: 'oklch(0.182 0.002 107)', sidebar: 'oklch(0.227 0 0)', raised: 'oklch(0.232 0 0)', message: 'oklch(0.322 0.021 97)', code: 'oklch(0.217 0 0)', text: 'oklch(0.95 0.035 96)', text2: 'oklch(0.616 0.021 97)', muted: 'oklch(0.616 0.021 97)', border: 'oklch(0.342 0 0)', accent: 'oklch(0.861 0.17 96.5)', accentFg: 'oklch(0.222 0.035 329)', rowSel: 'oklch(0.322 0.02 96.5)' },
    },

    // The five proposed. Glass is see-through: its room is a tint over the desktop, so its roles carry alpha.
    glass: {
      label: 'Glass', note: 'See-through to the desktop, blurred. Frosted panes, an azure accent.', glass: true,
      light: { canvas: 'oklch(0.975 0.006 250 / 0.8)', sidebar: 'oklch(1 0 0 / 0.42)', raised: 'oklch(1 0 0 / 0.62)', message: 'oklch(0.9 0.03 250 / 0.7)', code: 'oklch(1 0 0 / 0.5)', text: 'oklch(0.19 0.012 255)', text2: 'oklch(0.36 0.014 255)', muted: 'oklch(0.4 0.014 255)', border: 'oklch(0.2 0.02 255 / 0.12)', accent: 'oklch(0.5 0.17 252)', accentFg: 'oklch(0.99 0 0)', rowSel: 'oklch(0.55 0.15 252 / 0.2)', backdrop: 'linear-gradient(135deg, oklch(0.9 0.04 250), oklch(0.93 0.03 300) 55%, oklch(0.94 0.035 200))' },
      dark: { canvas: 'oklch(0.17 0.012 255 / 0.76)', sidebar: 'oklch(0.3 0.012 255 / 0.36)', raised: 'oklch(0.33 0.012 255 / 0.5)', message: 'oklch(0.42 0.06 250 / 0.45)', code: 'oklch(0.1 0.01 255 / 0.45)', text: 'oklch(0.985 0.003 255)', text2: 'oklch(0.9 0.01 255)', muted: 'oklch(0.86 0.012 255)', border: 'oklch(1 0 0 / 0.1)', accent: 'oklch(0.8 0.12 235)', accentFg: 'oklch(0.2 0.04 250)', rowSel: 'oklch(0.75 0.12 235 / 0.22)', backdrop: 'linear-gradient(135deg, oklch(0.24 0.05 265), oklch(0.2 0.06 300) 55%, oklch(0.22 0.05 210))' },
    },
    graphite: {
      label: 'Graphite', note: 'No hue at all. Black on white, white on black, the accent is the ink.',
      light: { canvas: 'oklch(0.988 0 0)', sidebar: 'oklch(0.963 0 0)', raised: 'oklch(0.952 0 0)', message: 'oklch(0.925 0 0)', code: 'oklch(0.965 0 0)', text: 'oklch(0.18 0 0)', text2: 'oklch(0.42 0 0)', muted: 'oklch(0.48 0 0)', border: 'oklch(0.885 0 0)', accent: 'oklch(0.2 0 0)', accentFg: 'oklch(0.99 0 0)', rowSel: 'oklch(0.9 0 0)' },
      dark: { canvas: 'oklch(0.135 0 0)', sidebar: 'oklch(0.175 0 0)', raised: 'oklch(0.205 0 0)', message: 'oklch(0.245 0 0)', code: 'oklch(0.165 0 0)', text: 'oklch(0.965 0 0)', text2: 'oklch(0.8 0 0)', muted: 'oklch(0.7 0 0)', border: 'oklch(0.275 0 0)', accent: 'oklch(0.95 0 0)', accentFg: 'oklch(0.14 0 0)', rowSel: 'oklch(0.27 0 0)' },
    },
    plum: {
      label: 'Plum', note: 'Lilac by day, aubergine by night, an orchid accent.',
      light: { canvas: 'oklch(0.977 0.008 320)', sidebar: 'oklch(0.952 0.015 320)', raised: 'oklch(0.945 0.016 320)', message: 'oklch(0.915 0.032 322)', code: 'oklch(0.962 0.01 320)', text: 'oklch(0.24 0.045 318)', text2: 'oklch(0.43 0.045 320)', muted: 'oklch(0.49 0.035 320)', border: 'oklch(0.875 0.022 320)', accent: 'oklch(0.5 0.17 330)', accentFg: 'oklch(0.99 0.005 320)', rowSel: 'oklch(0.9 0.045 328)' },
      dark: { canvas: 'oklch(0.17 0.03 315)', sidebar: 'oklch(0.215 0.035 315)', raised: 'oklch(0.245 0.04 316)', message: 'oklch(0.295 0.05 318)', code: 'oklch(0.2 0.03 315)', text: 'oklch(0.965 0.015 320)', text2: 'oklch(0.85 0.03 320)', muted: 'oklch(0.75 0.035 320)', border: 'oklch(0.32 0.04 315)', accent: 'oklch(0.77 0.14 335)', accentFg: 'oklch(0.2 0.045 320)', rowSel: 'oklch(0.33 0.065 325)' },
    },
    clay: {
      label: 'Clay', note: 'Plaster and terracotta by day, fired earth by night.',
      light: { canvas: 'oklch(0.973 0.01 60)', sidebar: 'oklch(0.947 0.018 52)', raised: 'oklch(0.938 0.02 52)', message: 'oklch(0.905 0.036 45)', code: 'oklch(0.958 0.012 55)', text: 'oklch(0.25 0.03 40)', text2: 'oklch(0.43 0.035 40)', muted: 'oklch(0.49 0.03 45)', border: 'oklch(0.865 0.025 50)', accent: 'oklch(0.53 0.15 38)', accentFg: 'oklch(0.99 0.005 60)', rowSel: 'oklch(0.895 0.045 40)' },
      dark: { canvas: 'oklch(0.18 0.018 40)', sidebar: 'oklch(0.225 0.022 40)', raised: 'oklch(0.255 0.025 40)', message: 'oklch(0.305 0.04 40)', code: 'oklch(0.205 0.018 40)', text: 'oklch(0.955 0.015 60)', text2: 'oklch(0.84 0.025 55)', muted: 'oklch(0.73 0.03 50)', border: 'oklch(0.335 0.03 40)', accent: 'oklch(0.73 0.14 42)', accentFg: 'oklch(0.2 0.03 40)', rowSel: 'oklch(0.335 0.06 40)' },
    },
    fern: {
      label: 'Fern', note: 'Clean white and charcoal with a fresh green, not a jungle.',
      light: { canvas: 'oklch(0.98 0.005 140)', sidebar: 'oklch(0.955 0.012 145)', raised: 'oklch(0.945 0.014 145)', message: 'oklch(0.915 0.035 145)', code: 'oklch(0.963 0.008 145)', text: 'oklch(0.22 0.025 150)', text2: 'oklch(0.41 0.03 150)', muted: 'oklch(0.48 0.025 150)', border: 'oklch(0.875 0.02 145)', accent: 'oklch(0.5 0.13 150)', accentFg: 'oklch(0.99 0.005 140)', rowSel: 'oklch(0.9 0.05 148)' },
      dark: { canvas: 'oklch(0.155 0.008 160)', sidebar: 'oklch(0.198 0.012 160)', raised: 'oklch(0.228 0.014 160)', message: 'oklch(0.275 0.03 155)', code: 'oklch(0.185 0.01 160)', text: 'oklch(0.965 0.01 140)', text2: 'oklch(0.845 0.02 145)', muted: 'oklch(0.73 0.02 150)', border: 'oklch(0.305 0.02 160)', accent: 'oklch(0.8 0.17 150)', accentFg: 'oklch(0.18 0.03 155)', rowSel: 'oklch(0.305 0.05 152)' },
    },
  }
  const PROPOSED = ['glass', 'graphite', 'plum', 'clay', 'fern']
  const KEPT = ['sotto', 'hush', 'citrine']

  const EFFORT = {
    ember: { label: 'Ember', image: 'linear-gradient(90deg, oklch(0.77 0.17 65), oklch(0.77 0.17 65), oklch(0.6 0.12 60))' },
    cyberpunk: { label: 'Cyberpunk', image: 'linear-gradient(90deg, oklch(0.7 0.3 345), oklch(0.62 0.27 305), oklch(0.86 0.15 200))' },
    rainbow: { label: 'Rainbow', image: 'linear-gradient(90deg, oklch(0.7 0.24 20), oklch(0.82 0.18 70), oklch(0.85 0.2 130), oklch(0.85 0.14 200), oklch(0.65 0.24 280), oklch(0.7 0.28 340))' },
    aurora: { label: 'Aurora', image: 'linear-gradient(90deg, oklch(0.86 0.18 160), oklch(0.82 0.14 200), oklch(0.68 0.22 300))' },
    plasma: { label: 'Plasma', image: 'linear-gradient(90deg, oklch(0.42 0.25 300), oklch(0.68 0.29 350), oklch(0.86 0.18 75))' },
    accent: { label: 'Theme accent', image: 'linear-gradient(90deg, var(--k-accent), var(--k-accent), color-mix(in srgb, var(--k-accent) 55%, var(--k-text)))' },
  }

  // Desktops for Glass to show through. Stripes is the hard case: pure black and white side by side.
  const WALLPAPERS = {
    bloom: { label: 'Bloom', css: 'radial-gradient(circle at 18% 22%, #ff7a59 0 18%, transparent 42%), radial-gradient(circle at 78% 30%, #5b8cff 0 16%, transparent 44%), radial-gradient(circle at 55% 85%, #ffd166 0 14%, transparent 40%), linear-gradient(135deg, #3a1c71, #d76d77 55%, #ffaf7b)' },
    snow: { label: 'Snow', css: 'radial-gradient(circle at 30% 30%, #ffffff, #f2f4f7 60%, #e6e9ee)' },
    night: { label: 'Night', css: 'radial-gradient(circle at 70% 20%, #1b2a4a 0 10%, transparent 40%), linear-gradient(180deg, #02040a, #0b1020 70%, #000)' },
    stripes: { label: 'Stripes', css: 'repeating-linear-gradient(45deg, #000 0 26px, #fff 26px 52px)' },
  }

  // ---------- colour maths: resolve any CSS colour (oklch included) through a 1px canvas ----------
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  probe.canvas.width = probe.canvas.height = 1
  /** The colour `css` paints over `under` (an opaque CSS colour), as 8-bit sRGB. */
  function paint(css, under = '#808080') {
    probe.globalAlpha = 1; probe.fillStyle = under; probe.fillRect(0, 0, 1, 1)
    probe.fillStyle = '#000'; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const css = rgb => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  /** Layers painted bottom first over `desk`, flattened to one opaque colour. */
  function stack(desk, layers) { let under = css(paint(desk, '#000')); for (const layer of layers) under = css(paint(layer, under)); return paint(under, '#000') }

  /**
   * The lowest contrast each line of words gets on the surfaces it sits on. For Glass, the desk is pure white and
   * pure black in turn (the two ends any wallpaper can reach, before blur softens it), so the number holds over any desktop.
   */
  function contrastReport(colors, glass) {
    const desks = glass ? ['#ffffff', '#000000'] : ['#808080']
    const pairs = [
      ['Words on the room', 'text', ['canvas']],
      ['Names and times', 'text2', ['canvas']],
      ['Muted words on the room', 'muted', ['canvas']],
      ['Sidebar rows', 'text', ['canvas', 'sidebar']],
      ['Sidebar muted', 'muted', ['canvas', 'sidebar']],
      ['Composer placeholder', 'muted', ['canvas', 'raised']],
      ['Your message', 'text', ['canvas', 'message']],
      ['Selected row', 'text', ['canvas', 'sidebar', 'rowSel']],
      ['Accent button', 'accentFg', ['canvas', 'accent']],
      ['Accent on the room', 'accent', ['canvas']],
    ]
    return pairs.map(([label, fg, layers]) => {
      let low = Infinity
      for (const desk of desks) {
        const bg = stack(desk, layers.map(role => colors[role]))
        const fgRgb = paint(colors[fg], css(bg))
        low = Math.min(low, ratio(fgRgb, bg))
      }
      // The accent on the room is a fill and focus colour, not body text: 3:1 is its bar.
      return { label, value: low, bar: fg === 'accent' ? 3 : 4.5 }
    })
  }

  function applyVars(el, colors) {
    for (const [role, value] of Object.entries(colors)) el.style.setProperty(`--k-${role}`, value)
  }

  // ---------- the small window ----------
  const style = document.createElement('style')
  style.textContent = `
  [data-preview], [data-host] { display: grid; grid-template-rows: minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .kw { --k-font: Figtree, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; position: relative; display: flex; flex-direction: column; min-height: 0; overflow: hidden; border-radius: 10px; background: var(--k-canvas); color: var(--k-text); font: 12px/1.45 var(--k-font); box-shadow: 0 18px 50px -18px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(0 0 0 / 0.08); isolation: isolate; text-align: left; }
  .kw[data-glass] { backdrop-filter: blur(var(--k-blur, 34px)) saturate(var(--k-sat, 170%)); -webkit-backdrop-filter: blur(var(--k-blur, 34px)) saturate(var(--k-sat, 170%)); }
  .kw[data-glass][data-grain]::after { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 5; opacity: .06; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E"); }
  .kw[data-glass][data-inapp] { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--k-backdrop); }
  .kw[data-glass][data-inapp] > .kw-tint { position: absolute; inset: 0; background: var(--k-canvas); z-index: -1; }
  .kw-strip { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; flex: none; font-size: 11.5px; }
  .kw-mark { width: 14px; height: 14px; border-radius: 4px; background: var(--k-accent); display: grid; place-items: center; }
  .kw-mark::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--k-accentFg); }
  .kw-switch { margin-inline: auto; display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: color-mix(in srgb, var(--k-text) 7%, transparent); }
  .kw-switch span { padding: 2px 9px; border-radius: 5px; color: var(--k-muted); }
  .kw-switch span[data-on] { background: var(--k-raised); color: var(--k-text); }
  .kw-ctl { color: var(--k-muted); letter-spacing: 6px; font-size: 10px; }
  .kw-body { flex: 1; display: flex; min-height: 0; }
  .kw-side { width: 34%; max-width: 210px; min-width: 132px; flex: none; background: var(--k-sidebar); padding: 8px 6px; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .kw-search { margin: 0 2px 6px; padding: 5px 8px; border-radius: 7px; background: color-mix(in srgb, var(--k-text) 6%, transparent); color: var(--k-muted); font-size: 11px; }
  .kw-proj { padding: 6px 8px 2px; color: var(--k-muted); font-size: 10.5px; font-weight: 600; letter-spacing: .02em; }
  .kw-row { display: flex; align-items: center; gap: 7px; padding: 5px 8px; border-radius: 7px; white-space: nowrap; overflow: hidden; }
  .kw-row b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .kw-row small { color: var(--k-muted); font-size: 10.5px; }
  .kw-row[data-sel] { background: var(--k-rowSel); }
  .kw-ring { width: 8px; height: 8px; border-radius: 50%; flex: none; border: 1.5px solid var(--k-muted); }
  .kw-ring[data-s=work] { border-color: var(--k-accent); border-right-color: transparent; }
  .kw-ring[data-s=wait] { background: var(--k-accent); border-color: var(--k-accent); }
  .kw-ring[data-s=done] { border-style: dotted; }
  .kw-main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .kw-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; flex: none; }
  .kw-head b { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kw-chip { font-size: 10.5px; color: var(--k-text2); padding: 1px 7px; border-radius: 6px; background: color-mix(in srgb, var(--k-text) 7%, transparent); white-space: nowrap; }
  .kw-tx { flex: 1; overflow: hidden; padding: 4px 14px 10px; display: flex; flex-direction: column; justify-content: flex-end; gap: 7px; min-height: 0; }
  .kw-tx > * { flex: none; }
  .kw-user { align-self: flex-end; max-width: 78%; background: var(--k-message); padding: 7px 10px; border-radius: 12px 12px 4px 12px; }
  .kw-who { color: var(--k-text2); font-size: 10.5px; }
  .kw-tx p { margin: 0; }
  .kw-tool { color: var(--k-muted); font-size: 11px; display: flex; gap: 6px; align-items: center; }
  .kw-tool::before { content: '✓'; color: var(--k-accent); }
  .kw-code { margin: 0; padding: 7px 10px; border-radius: 8px; background: var(--k-code); font: 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; overflow: hidden; }
  .kw-code i { font-style: normal; color: var(--k-accent); }
  .kw-link { color: var(--k-accent); text-decoration: underline; text-underline-offset: 2px; }
  .kw-creature { height: 22px; margin: 0 14px -4px; display: flex; align-items: flex-end; gap: 8px; font-size: 10.5px; color: var(--k-muted); flex: none; }
  .kw-creature svg { image-rendering: pixelated; }
  /* No border on the composer: a fill one step off the room, as every card is. */
  .kw-composer { margin: 0 12px 12px; padding: 9px 10px 8px; border-radius: 14px; background: var(--k-raised); flex: none; display: flex; flex-direction: column; gap: 8px; }
  .kw-ph { color: var(--k-muted); }
  .kw-chips { display: flex; gap: 5px; align-items: center; }
  .kw-chips span { font-size: 10.5px; padding: 2px 7px; border-radius: 6px; color: var(--k-text2); background: color-mix(in srgb, var(--k-text) 6%, transparent); }
  .kw-chips span[data-effort] { color: transparent; background-image: var(--k-effort-image); -webkit-background-clip: text; background-clip: text; font-weight: 700; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--k-text) 8%, transparent); }
  .kw-send { margin-left: auto; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--k-accent); color: var(--k-accentFg); font-style: normal; font-weight: 700; }
  /* Watcher's room */
  .kw[data-view=watcher] .kw-side { display: none; }
  .kw-wroom { flex: 1; position: relative; display: flex; flex-direction: column; min-height: 0; }
  .kw-wroom canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
  .kw-whead { position: relative; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 8px 14px; flex: none; }
  .kw-whead b { font-weight: 600; }
  .kw-tabs { display: flex; gap: 2px; margin-left: 6px; }
  .kw-tabs span { padding: 2px 8px; border-radius: 6px; color: var(--k-text2); font-size: 11px; }
  .kw-tabs span[data-on] { color: var(--k-text); background: color-mix(in srgb, var(--k-text) 9%, transparent); }
  .kw-wcol { position: relative; z-index: 1; flex: 1; width: min(62%, 420px); margin-inline: auto; display: flex; flex-direction: column; justify-content: flex-end; gap: 7px; padding: 6px 0 10px; min-height: 0; overflow: hidden; }
  .kw-wcol :is(p, .kw-who, .kw-user) { text-shadow: 0 0 3px var(--k-glow), 0 0 7px var(--k-glow), 0 0 12px var(--k-glow); }
  .kw-receipt { padding: 6px 9px; border-radius: 8px; background: color-mix(in srgb, var(--k-raised) 88%, transparent); font-size: 11px; display: flex; gap: 8px; align-items: center; }
  .kw-receipt i { font-style: normal; color: var(--k-accent); }
  .kw-wcomposer { position: relative; z-index: 2; width: min(62%, 420px); margin: 0 auto 12px; padding: 9px 10px 8px; border-radius: 14px; background: color-mix(in srgb, var(--k-raised) 72%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); display: flex; flex-direction: column; gap: 8px; }
  .kw-needs { position: relative; z-index: 1; width: min(62%, 420px); margin: 0 auto 6px; font-size: 11px; color: var(--k-text2); display: flex; gap: 6px; align-items: center; }
  .kw-needs::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--k-accent); }
  @media (max-width: 560px) { .kw-side { min-width: 112px; } .kw-wcol, .kw-wcomposer, .kw-needs { width: 74%; } }
  `
  document.head.appendChild(style)

  const CREATURE_SVG = {
    sotto: '<svg width="16" height="16" viewBox="0 0 8 8" aria-hidden="true"><rect x="2" y="1" width="4" height="4" fill="var(--k-accent)"/><rect x="3" y="2" width="1" height="1" fill="var(--k-canvas)"/><rect x="5" y="2" width="1" height="1" fill="var(--k-canvas)"/><rect x="2" y="5" width="1" height="2" fill="var(--k-text2)"/><rect x="5" y="5" width="1" height="2" fill="var(--k-text2)"/></svg>',
    claude: '<svg width="16" height="16" viewBox="0 0 8 8" aria-hidden="true"><rect x="1" y="2" width="6" height="3" fill="oklch(0.68 0.15 45)"/><rect x="2" y="3" width="1" height="1" fill="#000"/><rect x="5" y="3" width="1" height="1" fill="#000"/><rect x="0" y="3" width="1" height="1" fill="oklch(0.68 0.15 45)"/><rect x="7" y="3" width="1" height="1" fill="oklch(0.68 0.15 45)"/><rect x="2" y="5" width="1" height="2" fill="oklch(0.68 0.15 45)"/><rect x="5" y="5" width="1" height="2" fill="oklch(0.68 0.15 45)"/></svg>',
  }

  function windowHTML({ view = 'threads', creature = 'sotto', showCreature = true } = {}) {
    const strip = `<div class="kw-strip"><span class="kw-mark"></span><b>Sotto</b><nav class="kw-switch"><span>Dictate</span><span ${view === 'watcher' ? 'data-on' : ''}>Watcher</span><span ${view === 'threads' ? 'data-on' : ''}>Threads</span></nav><span class="kw-ctl">— ▢ ✕</span></div>`
    if (view === 'watcher') {
      return `${strip}<div class="kw-body"><div class="kw-wroom"><canvas data-scene></canvas>
        <div class="kw-whead"><b>Watcher</b><span class="kw-chip">All threads 6</span><span class="kw-tabs"><span data-on>Conversation</span><span>Watched 3</span><span>Visualize</span></span></div>
        <div class="kw-wcol">
          <div class="kw-user">How are the appearance threads doing?</div>
          <div class="kw-who">Watcher · 2:31 PM</div>
          <p>The page rework is building direction B. The themes thread is waiting on you for the Glass contrast question.</p>
          <div class="kw-receipt"><i>●</i> Checked in on Rework the Appearance page</div>
          <p>Both pull requests are green so far.</p>
        </div>
        <div class="kw-needs">Glass themes needs you</div>
        <div class="kw-wcomposer"><div class="kw-ph">Message Watcher…</div><div class="kw-chips"><span>Opus 5.5</span><span data-effort>Max</span><span>Supervised</span><i class="kw-send">↑</i></div></div>
      </div></div>`
    }
    const pet = showCreature ? `<div class="kw-creature">${CREATURE_SVG[creature] || CREATURE_SVG.sotto}<span>Monitoring the build</span></div>` : ''
    return `${strip}<div class="kw-body">
      <aside class="kw-side">
        <div class="kw-search">Search threads</div>
        <div class="kw-proj">sotto</div>
        <div class="kw-row" data-sel><span class="kw-ring" data-s="work"></span><b>Rework the Appearance page</b></div>
        <div class="kw-row"><span class="kw-ring" data-s="wait"></span><b>Glass themes</b><small>you</small></div>
        <div class="kw-row"><span class="kw-ring"></span><b>Fix fork beside Watcher</b><small>2h</small></div>
        <div class="kw-row"><span class="kw-ring" data-s="done"></span><b>Model favorites</b><small>1d</small></div>
        <div class="kw-proj">forge-scripts</div>
        <div class="kw-row"><span class="kw-ring"></span><b>Nightly backup check</b><small>3d</small></div>
      </aside>
      <main class="kw-main">
        <header class="kw-head"><b>Rework the Appearance page</b><span class="kw-chip">feat/appearance-page</span></header>
        <div class="kw-tx">
          <div class="kw-user">Make the Appearance page shorter, and show me three directions.</div>
          <div class="kw-who">Claude Code · 2:14 PM</div>
          <p>The theme gallery takes most of the page’s height, so each direction folds the choice into one group. See <span class="kw-link">ThemeGallery.tsx</span>.</p>
          <div class="kw-tool">Read 4 files</div>
          <pre class="kw-code"><i>-</i> &lt;ThemeColumn half="light" /&gt;
<i>+</i> &lt;ThemePicker pair={pair} /&gt;</pre>
        </div>
        ${pet}
        <div class="kw-composer"><div class="kw-ph">Ask Claude Code…</div><div class="kw-chips"><span>Opus 5.5</span><span data-effort>Max</span><span>Auto</span><i class="kw-send">↑</i></div></div>
      </main></div>`
  }

  /**
   * Paints `win` (a .kw element) in a theme half. `opts.glass` carries how Glass meets the desktop:
   * { platform: 'windows' | 'mica' | 'mac' | 'linux' }.
   */
  function paintWindow(win, themeId, mode, opts = {}) {
    const theme = THEMES[themeId]
    const colors = theme[mode]
    applyVars(win, colors)
    win.style.setProperty('--k-effort-image', (EFFORT[opts.effort] || EFFORT.ember).image)
    // The glow behind each word in Watcher's column is the room made opaque.
    win.style.setProperty('--k-glow', theme.glass ? css(stack(mode === 'dark' ? '#202020' : '#e0e0e0', [colors.canvas])) : colors.canvas)
    delete win.dataset.glass; delete win.dataset.inapp; delete win.dataset.grain
    win.style.removeProperty('--k-blur'); win.style.removeProperty('--k-sat')
    if (theme.glass) {
      win.dataset.glass = ''
      const p = opts.platform || 'windows'
      if (p === 'linux') win.dataset.inapp = ''
      if (p === 'windows') { win.dataset.grain = ''; win.style.setProperty('--k-blur', '30px'); win.style.setProperty('--k-sat', '150%') }
      if (p === 'mica') { win.style.setProperty('--k-blur', '90px'); win.style.setProperty('--k-sat', '120%') }
      if (p === 'mac') { win.style.setProperty('--k-blur', '40px'); win.style.setProperty('--k-sat', '190%') }
      if (p === 'linux' && !win.querySelector(':scope > .kw-tint')) win.insertAdjacentHTML('afterbegin', '<div class="kw-tint"></div>')
    }
    if (!(theme.glass && opts.platform === 'linux')) win.querySelector(':scope > .kw-tint')?.remove()
    Scene.repaint(win)
  }

  function mountWindow(host, view, opts = {}) {
    host.innerHTML = ''
    const win = document.createElement('div')
    win.className = 'kw'; win.dataset.view = view
    win.innerHTML = windowHTML({ view, creature: opts.creature, showCreature: opts.showCreature !== false })
    host.appendChild(win)
    for (const c of win.querySelectorAll('canvas[data-scene]')) Scene.attach(c, win)
    return win
  }

  // ---------- the night scene ----------
  // Hills, a river, two trees, stars and a moon in text characters, in the theme's text colour with the accent in the
  // moon's glow, the river, a few stars and the owls' eyes. It runs under the column at 85% and is capped there so the
  // words keep 4.5:1. It never blinks: a resize or a theme change repaints in the same task that cleared it, and
  // the stars only dim and brighten slowly, never going out.
  const Scene = (() => {
    const CW = 7, CH = 11, RAMP = ['.', ':', '-', '=', '+', '*', '#', '%', '@']
    const scenes = new Set()
    let reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let seed = 7
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
    const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

    function build(s, W, H) {
      seed = 7
      const cols = Math.ceil(W / CW), rows = Math.ceil(H / CH)
      const land = new Float32Array(cols * rows), kind = new Uint8Array(cols * rows) // 0 land, 1 river, 2 tree, 3 moon
      const ground = H * 0.8
      for (let c = 0; c < cols; c++) {
        const k = (c * CW) / W
        const h1 = ground - H * 0.26 * (0.55 + 0.25 * Math.sin(k * 7 + 1) + 0.15 * Math.sin(k * 17 + 4))
        const h2 = ground - H * 0.15 * (0.55 + 0.25 * Math.sin(k * 9 + 3) + 0.15 * Math.sin(k * 23 + 2))
        const riverY = ground + (H - ground) * (0.45 + 0.18 * Math.sin(k * 5 + 0.6))
        for (let r = 0; r < rows; r++) {
          const y = r * CH, i = r * cols + c
          let d = 0
          if (y > h1) d = Math.max(d, 0.16 + 0.1 * smooth(h1, h1 + 40, y))
          if (Math.abs(y - h1) < 6) d = Math.max(d, 0.4)
          if (y > h2) d = Math.max(d, 0.3 + 0.18 * smooth(h2, ground, y))
          if (Math.abs(y - h2) < 6) d = Math.max(d, 0.56)
          if (y > ground) d = Math.max(d, 0.5 + 0.3 * smooth(ground, H, y))
          if (Math.abs(y - riverY) < CH * 0.9 && y > ground) { kind[i] = 1; d = 0.55 }
          land[i] = Math.max(0, Math.min(1, d + (rnd() - 0.5) * 0.1))
        }
      }
      // Two trees in the margins: a trunk and a round crown.
      const trees = [W * 0.09, W * 0.92]
      for (const tx of trees) {
        const tc = Math.round(tx / CW), baseR = Math.floor((ground - CH) / CH), crownR = Math.floor((ground - H * 0.42) / CH)
        for (let r = crownR; r <= baseR; r++) for (const dc of [0]) { const i = r * cols + tc + dc; if (i >= 0 && i < land.length) { kind[i] = 2; land[i] = 0.75 } }
        const rad = Math.max(3, Math.round(H * 0.11 / CH))
        for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad * 1.6; dc <= rad * 1.6; dc++) {
          const dist = Math.hypot(dr / rad, dc / (rad * 1.6))
          if (dist > 1) continue
          const r = crownR + dr, c = tc + Math.round(dc); if (c < 0 || c >= cols || r < 0) continue
          const i = r * cols + c; kind[i] = 2; land[i] = 0.5 + 0.4 * (1 - dist) + (rnd() - 0.5) * 0.15
        }
      }
      // The moon sits high in the right margin, above the right tree, so the column never covers it.
      const moon = { x: W * 0.905, y: H * 0.2, r: Math.max(9, Math.min(W * 0.035, H * 0.06)) }
      const stars = []
      const n = Math.round((cols * rows) / 85)
      for (let i = 0; i < n; i++) {
        const c = Math.floor(rnd() * cols), r = Math.floor(rnd() * rows * 0.55)
        // Slow cycles of 9 to 16 seconds; a star never goes below 45% of its strength.
        stars.push({ i: r * cols + c, p: rnd() * 6.28, period: 9000 + rnd() * 7000, a: rnd() < 0.14 })
      }
      const owls = [{ x: trees[0] + CW * 2, y: (Math.floor((ground - H * 0.42) / CH) + 1) * CH, watcher: true }, { x: trees[1] - CW * 3, y: (Math.floor((ground - H * 0.42) / CH) + 2) * CH }, { x: trees[1] + CW * 2, y: (Math.floor((ground - H * 0.42) / CH) - 1) * CH, waiting: true }]
      Object.assign(s, { cols, rows, land, kind, stars, moon, owls, W, H })
    }

    function readInk(s) {
      const cs = getComputedStyle(s.win)
      const raw = n => cs.getPropertyValue(n).trim()
      const glass = s.win.dataset.glass !== undefined
      s.ink = raw('--k-text'); s.accent = raw('--k-accent')
      const glow = raw('--k-glow')
      s.canvasRgb = paint(glass ? glow : raw('--k-canvas'), '#000')
      s.textRgb = paint(s.ink, css(s.canvasRgb)); s.accentRgb = paint(s.accent, css(s.canvasRgb))
      s.text2Rgb = paint(raw('--k-text2'), css(s.canvasRgb))
      // The strongest a glyph may be in the column so text and the secondary text both keep 4.5:1 over it.
      const capFor = color => {
        let lo = 0, hi = 1
        for (let i = 0; i < 22; i++) {
          const mid = (lo + hi) / 2
          const under = [0, 1, 2].map(k => color[k] * mid + s.canvasRgb[k] * (1 - mid))
          if ([s.textRgb, s.text2Rgb].every(w => ratio(w, under) >= 4.6)) lo = mid; else hi = mid
        }
        return lo
      }
      s.cap = { ink: capFor(s.textRgb), accent: capFor(s.accentRgb) }
    }

    // The still part of the night (hills, trees, moon, owls) is painted once into its own canvas whenever the size or
    // the theme changes; each tick copies it and adds only the stars and the river, which is all that moves.
    function bake(s) {
      const dpr = devicePixelRatio || 1
      const still = s.still || (s.still = document.createElement('canvas'))
      still.width = s.canvas.width; still.height = s.canvas.height
      const ctx = still.getContext('2d')
      const colEl = s.win.querySelector('.kw-wcol'), room = s.canvas.getBoundingClientRect(), cr = colEl ? colEl.getBoundingClientRect() : null
      const colL = cr ? cr.left - room.left : -1, colR = cr ? cr.right - room.left : -1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const inCol = x => x > colL - 8 && x < colR + 8
      const q = x => { const e = x < colL ? colL - x : x > colR ? x - colR : -Math.min(x - colL, colR - x); return 0.85 + 0.15 * smooth(-40, 40, e) }
      const starAt = new Map(s.stars.map(st => [st.i, st]))
      const { moon } = s
      s.moving = []
      for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
        const x = (c + 0.5) * CW, y = (r + 0.5) * CH, i = r * s.cols + c
        const strength = q(x), capped = inCol(x)
        const md = Math.hypot(x - moon.x, y - moon.y)
        let ch = null, alpha = 0, accent = false
        if (md < moon.r) { ch = md < moon.r * 0.7 ? '@' : 'O'; alpha = 0.8 }
        else if (md < moon.r * 2.1) { if ((c + r) % 3 === 0) { ch = '.'; alpha = 0.55 * (1 - (md - moon.r) / (moon.r * 1.1)); accent = true } }
        const st = !ch && starAt.get(i)
        if (st) { s.moving.push({ x, y, c, star: st, strength, cap: capped ? (st.a ? s.cap.accent : s.cap.ink) : 1, accent: st.a }); continue }
        if (!ch) {
          const d = s.land[i]; if (d < 0.1) continue
          const k = s.kind[i]
          if (k === 1) { s.moving.push({ x, y, c, river: true, strength, cap: capped ? s.cap.accent : 1, accent: true }); continue }
          ch = k === 2 ? (d > 0.7 ? '#' : d > 0.55 ? '%' : '*') : RAMP[Math.min(RAMP.length - 1, Math.floor(d * RAMP.length))]; alpha = 0.1 + 0.5 * d
        }
        alpha *= strength
        if (capped) alpha = Math.min(alpha, accent ? s.cap.accent : s.cap.ink)
        ctx.globalAlpha = alpha; ctx.fillStyle = accent ? s.accent : s.ink
        ctx.fillText(ch, x, y)
      }
      // Owls: a body in the text colour, eyes in the accent; the waiting one glows. They sit in the margins only.
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      for (const o of s.owls) {
        if (inCol(o.x)) continue
        ctx.globalAlpha = 0.9; ctx.fillStyle = s.ink; ctx.fillText('(', o.x - 9, o.y); ctx.fillText(')', o.x + 9, o.y)
        ctx.fillStyle = s.accent; ctx.globalAlpha = 1
        if (o.waiting) { ctx.shadowColor = s.accent; ctx.shadowBlur = 8 }
        ctx.fillText('o', o.x - 3.5, o.y); ctx.fillText('o', o.x + 3.5, o.y); ctx.shadowBlur = 0
      }
    }

    function draw(s, t) {
      const { ctx, canvas } = s
      const dpr = devicePixelRatio || 1
      // Clearing and painting happen in this one call, so no frame ever shows an empty scene.
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (s.still) ctx.drawImage(s.still, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      for (const m of s.moving) {
        let ch, alpha
        if (m.star) {
          const wave = reduce ? 0.75 : 0.725 + 0.275 * Math.sin((t / m.star.period) * 6.283 + m.star.p)
          ch = wave > 0.82 ? '*' : wave > 0.6 ? '+' : '·'; alpha = 0.7 * wave
        } else { ch = (m.c + (reduce ? 0 : Math.floor(t / 2400))) % 4 === 0 ? '≈' : '~'; alpha = 0.55 }
        ctx.globalAlpha = Math.min(alpha * m.strength, m.cap); ctx.fillStyle = m.accent ? s.accent : s.ink
        ctx.fillText(ch, m.x, m.y)
      }
      ctx.globalAlpha = 1
    }

    function size(s) {
      const r = s.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height))
      if (w === s.W && h === s.H) return false
      s.canvas.width = Math.round(w * dpr); s.canvas.height = Math.round(h * dpr)
      build(s, w, h)
      return true
    }

    function attach(canvas, win) {
      const s = { canvas, win, ctx: canvas.getContext('2d'), W: 0, H: 0, visible: true }
      scenes.add(s)
      // Resizing clears a canvas; painting in the same callback means the cleared state is never shown.
      const ro = new ResizeObserver(() => { if (!canvas.isConnected) { ro.disconnect(); scenes.delete(s); return } if (size(s)) { readInk(s); bake(s); draw(s, performance.now()) } })
      ro.observe(canvas)
      const io = new IntersectionObserver(entries => { s.visible = entries.some(e => e.isIntersecting) })
      io.observe(canvas)
      size(s); readInk(s); bake(s); draw(s, performance.now())
      return s
    }

    function repaint(win) {
      for (const s of scenes) if (s.win === win && s.canvas.isConnected) { size(s); readInk(s); bake(s); draw(s, performance.now()) }
    }

    let last = 0
    function loop(t) {
      if (!reduce && t - last > 200) {
        last = t
        for (const s of [...scenes]) { if (!s.canvas.isConnected) { scenes.delete(s); continue } if (s.visible) draw(s, t) }
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    function setReduced(on) { reduce = on; for (const s of scenes) if (s.canvas.isConnected) draw(s, performance.now()) }
    return { attach, repaint, setReduced }
  })()

  // ---------- the variant switcher the prototype skill asks for ----------
  function switcher(variants, current, onChange) {
    const bar = document.createElement('div')
    bar.className = 'proto-switcher'
    bar.setAttribute('role', 'navigation'); bar.setAttribute('aria-label', 'Prototype variants')
    const s = document.createElement('style')
    s.textContent = `.proto-switcher { position: fixed; left: 50%; bottom: max(14px, env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 1000; display: flex; align-items: center; gap: 4px; padding: 5px; border-radius: 999px; background: #111; color: #fff; box-shadow: 0 10px 30px rgb(0 0 0 / .35), 0 0 0 1px rgb(255 255 255 / .12); font: 600 13px/1 system-ui, sans-serif; }
      .proto-switcher button { all: unset; cursor: pointer; padding: 9px 13px; border-radius: 999px; }
      .proto-switcher button:hover, .proto-switcher button:focus-visible { background: #333; }
      .proto-switcher span { padding: 0 8px; white-space: nowrap; }`
    document.head.appendChild(s)
    const keys = Object.keys(variants)
    let idx = Math.max(0, keys.indexOf(current))
    const label = document.createElement('span')
    const prev = document.createElement('button'); prev.textContent = '←'; prev.setAttribute('aria-label', 'Previous variant')
    const next = document.createElement('button'); next.textContent = '→'; next.setAttribute('aria-label', 'Next variant')
    const go = d => { idx = (idx + d + keys.length) % keys.length; show() }
    const show = () => {
      const key = keys[idx]
      label.textContent = `${key} — ${variants[key]}`
      const u = new URL(location.href); u.searchParams.set('variant', key); history.replaceState(null, '', u)
      onChange(key)
    }
    prev.onclick = () => go(-1); next.onclick = () => go(1)
    addEventListener('keydown', e => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1)
    })
    bar.append(prev, label, next)
    document.body.appendChild(bar)
    show()
    return { set(key) { const i = keys.indexOf(key); if (i >= 0 && i !== idx) { idx = i; show() } } }
  }

  window.Kit = { THEMES, PROPOSED, KEPT, EFFORT, WALLPAPERS, CREATURE_SVG, contrastReport, applyVars, mountWindow, paintWindow, Scene, switcher, paint, ratio, css }
})()

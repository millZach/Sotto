// PROTOTYPE helper for #1833. Measures the renderer's stylesheets (measure.mjs), maps every value onto each candidate
// scale, writes counts.json, and injects the data into ../type-radius-scale-prototype.html between the DATA markers.
// Usage: node build.mjs <checkout>
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = process.argv[2]
const m = JSON.parse(execFileSync('node', [join(here, 'measure.mjs'), checkout], { maxBuffer: 64 << 20 }).toString())

// ---- the candidates -------------------------------------------------------------------------------------------
const nearest = (steps, { below12Up = false } = {}) => (v) => {
  let best = steps[0]
  for (const s of steps) {
    const d = Math.abs(s - v), bd = Math.abs(best - v)
    if (d < bd || (d === bd && (below12Up && v < 12 ? s > best : s < best))) best = s
  }
  return best
}
const variants = {
  A: {
    name: 'Snap',
    blurb: 'Keep every whole size Sotto already leans on and snap the halves and one-offs to the nearest. A half-pixel size goes down to the step below, except under 12 px, where it goes up.',
    type: [
      ['micro', 11, 'Keys, badges and tiny marks'],
      ['caption', 12, 'Times, counts, statuses, metadata'],
      ['small', 13, 'Descriptions, controls, most interface text'],
      ['body', 14, 'Sidebar rows, fields, menu items'],
      ['reading', 15, 'Transcript, composer, journal entries, settings labels'],
      ['lead', 16, 'Dialog titles, section intros, request prompts'],
      ['heading', 18, 'Sidebar brand, empty-room headings'],
      ['figure', 22, 'Figures in a narrow room, sub-titles'],
      ['title', 28, 'Room titles and large figures'],
    ],
    typeMap: nearest([11, 12, 13, 14, 15, 16, 18, 22, 28], { below12Up: true }),
    radius: [
      ['mark', 2, 'Meters, legend squares, focus marks'],
      ['tag', 4, 'Tags, keys, chips, small close buttons'],
      ['control', 6, 'Buttons, fields, composer chips (today’s sm)'],
      ['row', 8, 'Sidebar and menu rows, icon buttons'],
      ['inset', 10, 'Code blocks, menus, notes inside a card (today’s md)'],
      ['card', 14, 'Cards, the composer, the Dictate bar (today’s lg)'],
      ['overlay', 20, 'Dialogs and the widget'],
      ['full', 'full', 'Dots, rings, pills'],
    ],
    radiusMap: nearest([2, 4, 6, 8, 10, 14, 20]),
  },
  B: {
    name: 'Six steps',
    blurb: 'The issue’s six-step ramp, named with the iPhone’s six roles. Nothing is smaller than 12 px. Reading text and settings labels drop from 15 to 14; radii keep four steps, so rows and dialogs lose some roundness.',
    type: [
      ['caption', 12, 'Times, counts, tags, keys, metadata'],
      ['small', 13, 'Descriptions, controls, most interface text'],
      ['body', 14, 'Sidebar rows, fields, transcript, composer, settings labels'],
      ['lead', 16, 'Dialog titles, section intros, headings'],
      ['title', 20, 'Empty-room headings, figures'],
      ['display', 28, 'Room titles and large figures'],
    ],
    typeMap: (v) => nearest([12, 13, 14, 16, 20, 28])(Math.max(v, 12)),
    radius: [
      ['small', 4, 'Marks, tags, keys, chips'],
      ['control', 6, 'Buttons, fields, rows (today’s sm)'],
      ['inset', 10, 'Code blocks, menus, notes (today’s md)'],
      ['card', 14, 'Cards, the composer and dialogs (today’s lg)'],
      ['full', 'full', 'Dots, rings, pills'],
    ],
    radiusMap: (v) => nearest([4, 6, 10, 14])(v),
  },
  C: {
    name: 'Fluent',
    blurb: 'Windows’ own ramp and corners: Caption 12, Body 14, Body Large 18, Subtitle 20, Title 28; 4 px for controls and rows, 8 px for cards and overlays. Each size goes to the role it plays, so 13 px interface text becomes Body 14 and 15 px reading text becomes Body 14 too. At 820 × 560 it costs little room (the Settings card grows 11 px, the dialog 13 px); what it costs is hierarchy and the soft corners.',
    type: [
      ['caption', 12, 'Caption: times, descriptions, metadata'],
      ['body', 14, 'Body and Body Strong: all interface and reading text'],
      ['body-large', 18, 'Body Large: dialog titles, section intros'],
      ['subtitle', 20, 'Subtitle: headings, small figures'],
      ['title', 28, 'Title: room titles and large figures'],
    ],
    typeMap: (v) => (v <= 12.5 ? 12 : v <= 15.5 ? 14 : v <= 18 ? 18 : v <= 23 ? 20 : 28),
    radius: [
      ['small', 2, 'Fluent Small: marks'],
      ['control', 4, 'Controls, rows, tags, keys'],
      ['overlay', 8, 'Cards, the composer, menus and dialogs'],
      ['full', 'full', 'Dots, rings, pills'],
    ],
    radiusMap: (v) => (v <= 3 ? 2 : v <= 9 ? 4 : 8),
  },
}

// ---- type ---------------------------------------------------------------------------------------------------------
const pxOf = (s) => (/^\d*\.?\d+px$/.test(s) ? parseFloat(s) : null)
function mapSize(value, fn) {
  const px = pxOf(value)
  if (px !== null) return { from: px, to: fn(px), delta: Math.abs(fn(px) - px) }
  const c = value.match(/^clamp\((\d*\.?\d+)px,\s*(.+),\s*(\d*\.?\d+)px\)$/)
  if (c) { const lo = +c[1], hi = +c[3]; const d = Math.max(Math.abs(fn(lo) - lo), Math.abs(fn(hi) - hi)); return { from: value, to: `clamp(${fn(lo)}px, ${c[2]}, ${fn(hi)}px)`, delta: d } }
  return { from: value, to: value, delta: 0 }
}
// ---- radii --------------------------------------------------------------------------------------------------------
const MAIN_TOKENS = { sm: 6, md: 10, lg: 14 }, WIDGET_TOKENS = { sm: 10, md: 12, lg: 14 }
function parts(value) { const out = []; let depth = 0, cur = ''; for (const ch of value) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth === 0 && /\s|\//.test(ch)) { if (cur) out.push(cur); cur = ''; continue } cur += ch } if (cur) out.push(cur); return out }
function radiusPart(p, file) {
  const tok = p.match(/^var\(--tt-radius-(sm|md|lg)\)$/)
  if (tok) return (file.includes('/widget/') ? WIDGET_TOKENS : MAIN_TOKENS)[tok[1]]
  if (p === '50%' || p === '100%' || p === '999px' || p === '9999px') return 'full'
  const px = pxOf(p); if (px !== null) return px === 0 ? 0 : px >= 25 && px !== 24 ? 'full' : px // 25 and 47 px are halo circles
  if (p === '0') return 0
  if (p === '.42em') return 5.5 // the skill pill, at its 13 px text
  return 'keep' // inherit, a room's own variable
}
function mapRadius(r, fn) {
  let delta = 0, kept = true; const to = []
  for (const p of parts(r.value)) {
    const v = radiusPart(p, r.file)
    if (v === 'keep' || v === 'full' || v === 0) { to.push(v === 'full' ? 'full' : p); continue }
    kept = false; const t = fn(v); to.push(t); delta = Math.max(delta, Math.abs(t - v))
  }
  return { delta, kept, to: to.join(' ') }
}
const resolvedRadius = (r) => parts(r.value).map((p) => { const v = radiusPart(p, r.file); return v === 'keep' ? p : v === 'full' ? 'full' : `${v}` }).join(' ')

// ---- movement -----------------------------------------------------------------------------------------------------
const roomsOf = (rows) => { const t = {}; for (const r of rows) t[r.room] = (t[r.room] ?? 0) + 1; return Object.entries(t).sort((a, b) => b[1] - a[1]) }
const out = { measuredAt: new Date().toLocaleDateString('en-CA'), checkout: execFileSync('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD']).toString().trim(), today: {}, variants: {} }

const sizeRows = m.raw.sizes, radiusRows = m.raw.radii
const pxSizes = [...new Set(sizeRows.map((s) => pxOf(s.value)).filter((v) => v !== null))].sort((a, b) => a - b)
out.today.type = {
  declarations: sizeRows.length, distinct: m.sizes.distinct, distinctPx: pxSizes.length,
  below12: sizeRows.filter((s) => pxOf(s.value) !== null && pxOf(s.value) < 12).length,
  values: m.sizes.values.map((v) => ({ value: v.value, count: v.count, rooms: Object.entries(v.rooms).sort((a, b) => b[1] - a[1]) })),
  rooms: m.sizes.rooms.map(({ room, count, distinct }) => ({ room, count, distinct })),
  inline: m.inline.filter((i) => i.prop === 'fontSize'),
}
const resolved = {}; for (const r of radiusRows) { const k = resolvedRadius(r); (resolved[k] ??= []).push(r) }
out.today.radius = {
  declarations: radiusRows.length, distinct: m.radii.distinct, tokenised: m.radii.tokenised,
  distinctResolved: Object.keys(resolved).length,
  values: m.radii.values.map((v) => ({ value: v.value, count: v.count, rooms: Object.entries(v.rooms).sort((a, b) => b[1] - a[1]) })),
  rooms: m.radii.rooms.map(({ room, count, distinct }) => ({ room, count, distinct })),
  inline: m.inline.filter((i) => i.prop === 'borderRadius'),
}
out.today.shadow = { declarations: m.shadows.declarations, distinct: m.shadows.distinct, none: m.shadows.none,
  rooms: m.shadows.rooms.map(({ room, count, distinct }) => ({ room, count, distinct })),
  top: m.shadows.values.slice(0, 8).map((v) => ({ value: v.value, count: v.count })) }

for (const [id, v] of Object.entries(variants)) {
  const t = { stay: 0, half: 0, more: 0, below12: 0, byRoom: {} }, map = {}
  for (const s of sizeRows) {
    const r = mapSize(s.value, v.typeMap)
    const k = r.delta === 0 ? 'stay' : r.delta <= 0.5 ? 'half' : 'more'
    t[k]++; if (pxOf(s.value) !== null && v.typeMap(pxOf(s.value)) < 12) t.below12++
    const room = (t.byRoom[s.room] ??= { stay: 0, half: 0, more: 0 }); room[k]++
    const e = (map[s.value] ??= { from: s.value, to: r.to, count: 0 }); e.count++
  }
  const rr = { stay: 0, one: 0, more: 0, byRoom: {} }, rmap = {}
  for (const r of radiusRows) {
    const x = mapRadius(r, v.radiusMap)
    const k = x.delta === 0 ? 'stay' : x.delta <= 1 ? 'one' : 'more'
    rr[k]++
    const room = (rr.byRoom[r.room] ??= { stay: 0, one: 0, more: 0 }); room[k]++
    const key = resolvedRadius(r); const e = (rmap[key] ??= { from: key, to: x.to, count: 0 }); e.count++
  }
  out.variants[id] = {
    name: v.name, blurb: v.blurb,
    type: v.type.map(([role, px, use]) => ({ token: `--tt-type-${role}`, role, px, use, from: Object.values(map).filter((e) => pxOf(e.from) !== null && v.typeMap(pxOf(e.from)) === px).map((e) => [e.from, e.count]) })),
    radius: v.radius.map(([role, px, use]) => ({ token: `--tt-radius-${role}`, role, px, use })),
    typeMap: Object.fromEntries(pxSizes.map((p) => [p, v.typeMap(p)])),
    radiusMap: Object.fromEntries([1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 20, 24].map((p) => [p, v.radiusMap(p)])),
    typeMoves: t, radiusMoves: rr,
    radiusTable: Object.values(rmap).sort((a, b) => b.count - a.count),
  }
}

writeFileSync(join(here, 'counts.json'), JSON.stringify(out, null, 1) + '\n')
const page = join(here, '..', 'type-radius-scale-prototype.html')
const html = readFileSync(page, 'utf8')
const next = html.replace(/\/\*DATA\*\/[\s\S]*?\/\*END DATA\*\//, `/*DATA*/${JSON.stringify(out)}/*END DATA*/`)
writeFileSync(page, next)
console.log(JSON.stringify(Object.fromEntries(Object.entries(out.variants).map(([k, v]) => [k, { type: v.typeMoves, radius: { stay: v.radiusMoves.stay, one: v.radiusMoves.one, more: v.radiusMoves.more } }])), (k, val) => (k === 'byRoom' ? undefined : val), 1))
console.log('today', out.today.type.declarations, out.today.type.distinct, out.today.type.distinctPx, 'below12', out.today.type.below12, '| radii', out.today.radius.declarations, out.today.radius.distinct, out.today.radius.tokenised, 'resolved', out.today.radius.distinctResolved, '| shadows', out.today.shadow.declarations, out.today.shadow.distinct)

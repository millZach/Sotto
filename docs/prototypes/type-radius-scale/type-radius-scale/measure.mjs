// PROTOTYPE helper for #1833: counts font-size, border-radius and box-shadow declarations in the renderer.
// Usage: node measure.mjs <checkout> > counts.json
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2]
const src = join(root, 'src/renderer/src')
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = walk(src)

function roomOf(file, selector) {
  const f = relative(src, file).replaceAll('\\', '/')
  if (f.startsWith('features/dictate/')) return 'Dictate'
  if (f.startsWith('features/settings/') || f === 'styles/crossing-settings.css' || f.startsWith('features/performance/')) return 'Settings'
  if (f === 'agents/threadSidebar.css' || f === 'agents/owlSky.css' || f === 'agents/hostBadge.css' || f === 'agents/workingThreadsLine.css') return 'Threads sidebar'
  if (f === 'agents/composer.css' || f === 'agents/quietComposer.css' || f === 'agents/modelPicker.css' || f === 'agents/effortPicker.css' || f === 'agents/skillPill.css') return 'Threads composer'
  if (f.startsWith('agents/')) return 'Threads pane'
  if (f.startsWith('tools/')) return 'Threads tools'
  if (f.startsWith('watcher/')) return 'Watcher'
  if (f.startsWith('features/usage/')) return 'Usage'
  if (f.startsWith('features/onboarding/') || f.startsWith('features/omarchy/')) return 'Setup'
  if (f.startsWith('features/updates/') || f.startsWith('features/starting/')) return 'Updates and start'
  if (f.startsWith('features/memory/')) return 'Memory'
  if (f.startsWith('widget/')) return 'Widget'
  if (f.startsWith('components/')) return 'Shared controls'
  if (f === 'styles/global.css') {
    if (/\.onboarding/.test(selector)) return 'Setup'
    if (/\.settings|\.management/.test(selector)) return 'Settings'
    if (/\.help/.test(selector)) return 'Help'
    if (/\.update/.test(selector)) return 'Updates and start'
    if (/\.voice/.test(selector)) return 'Dictate'
    if (/\.app|\.room|\.page/.test(selector)) return 'App frame'
    return 'Shared controls'
  }
  return 'Shared controls'
}

function* declarations(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const stack = []
  let buf = '', depth = 0, line = 1, startLine = 1
  for (const ch of text) {
    if (ch === '\n') line++
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth > 0) { buf += ch; continue }
    if (ch === '{') { stack.push(buf.trim()); buf = ''; startLine = line; continue }
    if (ch === ';' || ch === '}') {
      const d = buf.trim(); buf = ''
      const i = d.indexOf(':')
      if (i > 0 && !d.startsWith('@')) {
        const sel = [...stack].reverse().find((s) => !s.startsWith('@')) ?? ''
        yield { prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim().replace(/\s*!important$/, ''), selector: sel.replace(/\s+/g, ' '), line }
      }
      if (ch === '}') stack.pop()
      continue
    }
    buf += ch
  }
}

const sizes = [], radii = [], shadows = []
for (const file of files.filter((f) => f.endsWith('.css'))) {
  const rel = relative(root, file).replaceAll('\\', '/')
  for (const d of declarations(readFileSync(file, 'utf8'))) {
    const room = roomOf(file, d.selector)
    const at = { file: rel, line: d.line, selector: d.selector, room }
    if (d.prop === 'font-size') sizes.push({ ...at, value: d.value })
    else if (d.prop === 'font' && d.value !== 'inherit') {
      const m = d.value.match(/(?:^|\s)(\d*\.?\d+(?:px|em|rem|%))(?:\/|\s|$)/)
      sizes.push({ ...at, value: m ? m[1] : d.value, shorthand: true })
    } else if (/^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/.test(d.prop)) radii.push({ ...at, prop: d.prop, value: d.value })
    else if (d.prop === 'box-shadow') shadows.push({ ...at, value: d.value })
  }
}
// Inline styles in .tsx/.ts
const inline = []
for (const file of files.filter((f) => /\.(tsx|ts)$/.test(f))) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((l, i) => { for (const m of l.matchAll(/(fontSize|borderRadius|boxShadow)\s*:\s*([^,}]+)/g)) inline.push({ file: relative(root, file).replaceAll('\\', '/'), line: i + 1, prop: m[1], value: m[2].trim() }) })
}

const tally = (rows) => { const t = {}; for (const r of rows) { const v = t[r.value] ??= { value: r.value, count: 0, rooms: {} }; v.count++; v.rooms[r.room] = (v.rooms[r.room] ?? 0) + 1 } return Object.values(t).sort((a, b) => b.count - a.count) }
const byRoom = (rows) => { const t = {}; for (const r of rows) { const v = t[r.room] ??= { room: r.room, count: 0, distinct: new Set() }; v.count++; v.distinct.add(r.value) } return Object.values(t).map((v) => ({ room: v.room, count: v.count, distinct: v.distinct.size, values: [...v.distinct] })).sort((a, b) => b.count - a.count) }

console.log(JSON.stringify({ sizes: { declarations: sizes.length, distinct: new Set(sizes.map((s) => s.value)).size, values: tally(sizes), rooms: byRoom(sizes) },
  radii: { declarations: radii.length, distinct: new Set(radii.map((s) => s.value)).size, tokenised: radii.filter((r) => /var\(--tt-radius/.test(r.value)).length, values: tally(radii), rooms: byRoom(radii) },
  shadows: { declarations: shadows.length, distinct: new Set(shadows.map((s) => s.value)).size, none: shadows.filter((s) => s.value === 'none').length, values: tally(shadows), rooms: byRoom(shadows) },
  inline, raw: { sizes, radii } }, null, 1))

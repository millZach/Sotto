/**
 * PROTOTYPE (prototype/owl-flight): today's flight of Watcher's owl beside the candidates, each on the real night-scene
 * painter at real cell size, in the real theme tokens. Throwaway: what is picked moves into nightScene.ts.
 */
import '../../../src/renderer/src/styles/fonts.css'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/watcher/nightScene.css'
import './page.css'
import { frameDelay, frameDue, glassOpacity, layoutScene, sceneInk, type SceneLayout, type SceneMeasure, type Word } from '../../../src/renderer/src/watcher/nightScene'
import { NightScenePainter } from '../../../src/renderer/src/watcher/nightScenePainter'
import { toRgb } from '../../../src/renderer/src/watcher/canvasColor'
import { BUILT_IN_THEMES, GLASS_THEME, getThemeColorsForMode } from '../../../src/shared/themes/library'
import type { ThemeAppearance, ThemeColors } from '../../../src/shared/themes/palettes'
import { MODELS, TRIPS, type Lock, type Model, type Plan } from './flights'

declare const __VELLUM__: { light: ThemeColors; dark: ThemeColors } | null

const query = new URLSearchParams(location.search)
const THEMES: Array<{ id: string; label: string; colors: (mode: ThemeAppearance) => ThemeColors | null }> = [
  ...[...BUILT_IN_THEMES, GLASS_THEME].map(theme => ({ id: theme.id, label: theme.label, colors: (mode: ThemeAppearance) => getThemeColorsForMode(theme, mode) })),
  ...__VELLUM__ === null ? [] : [{ id: 'vellum', label: 'Vellum (new, thread 405a331c)', colors: (mode: ThemeAppearance) => __VELLUM__![mode] }],
]

const state = {
  theme: query.get('theme') ?? 'citrine',
  mode: (query.get('mode') ?? 'dark') as ThemeAppearance,
  reduced: query.get('reduced') === '1',
  lock: (query.get('lock') ?? 'cell') as Lock,
  fly: query.get('fly') !== '0',
  cadence: query.get('cadence') === null ? null : Number(query.get('cadence')),
  polish: query.get('polish') !== '0',
  slow: Number(query.get('slow') ?? '1'),
  trip: query.get('trip') ?? 'all',
  only: query.get('only'),
  /** A capture drives the clock itself, a frame at a time. */
  manual: query.get('clock') === 'manual',
  width: Number(query.get('w') ?? '1100'),
  height: Number(query.get('h') ?? '640'),
}

const roleVariable = (role: string): string => `--theme-${role.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`
function paint(element: HTMLElement): void {
  const colors = THEMES.find(theme => theme.id === state.theme)?.colors(state.mode) ?? THEMES[0]!.colors(state.mode)!
  element.dataset.themeScope = state.mode
  for (const [role, value] of Object.entries(colors)) element.style.setProperty(roleVariable(role), value)
}

const pixelCanvas = document.createElement('canvas')
pixelCanvas.width = 1; pixelCanvas.height = 1
const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })!
const toWord = (value: string): Word | null => {
  const rgb = toRgb(value, pixel)
  if (rgb === null) return null
  const a = pixel.getImageData(0, 0, 1, 1).data[3]! / 255
  return a >= 1 ? rgb : { ...rgb, a }
}

interface Stats { painted: number; ms: number[]; flips: number[]; cells: number[]; frames: number; since: number }
interface Panel {
  readonly model: Model
  readonly pane: HTMLElement
  readonly painter: NightScenePainter
  readonly stats: HTMLElement
  readonly phase: HTMLElement
  layout: SceneLayout | null
  trip: number
  plan: Plan | null
  t0: number
  last: number
  delay: number | null
  s: Stats
}

const W = state.width, H = state.height, HEADER = 46
const COLUMN = Math.round(Math.min(660, W * 0.56))
const colX = Math.round((W - COLUMN) / 2)
const composer = { x: colX, y: H - 132, w: COLUMN, h: 104 }
const measure: SceneMeasure = {
  width: W, height: H, header: HEADER, composer,
  words: [{ x: 18, y: 14, w: 70, h: 18 }, { x: colX + 18, y: composer.y + 16, w: 180, h: 18 }],
}

const lines = [
  ['you', 'Watch the release threads and tell me when the Windows package is green.'],
  ['Watcher', 'Watching three threads. Package (Windows) is on its second run; the Mac half finished at 14:02.'],
  ['you', 'Ping me if the notices check fails again.'],
  ['Watcher', 'Will do. The last failure was a stale THIRD_PARTY_NOTICES entry, fixed in 8e1c2a.'],
]

function makePanel(model: Model, host: HTMLElement): Panel {
  const section = document.createElement('section')
  section.className = 'panel'
  section.dataset.model = model.id
  section.innerHTML = `<header><div><h2></h2><p class="idea"></p></div><p class="stats"></p></header>`
  section.querySelector('h2')!.textContent = model.name
  section.querySelector('.idea')!.textContent = model.idea
  const pane = document.createElement('div')
  pane.className = 'watcher-pane pane'
  pane.style.width = `${W}px`; pane.style.height = `${H}px`
  pane.innerHTML = `<canvas class="watcher-scene watcher-scene--land" aria-hidden="true"></canvas><canvas class="watcher-scene watcher-scene--owl" aria-hidden="true"></canvas>
    <span class="watcher-scene__ink"></span><div class="head">Watcher</div><div class="column"></div>
    <div class="composer" style="left:${composer.x}px;top:${composer.y}px;width:${composer.w}px;height:${composer.h}px"><span>Ask Watcher</span></div>
    <span class="phase"></span>`
  const column = pane.querySelector<HTMLElement>('.column')!
  column.style.left = `${colX}px`; column.style.width = `${COLUMN}px`
  for (const [who, words] of lines) {
    const row = document.createElement('p'); row.className = who === 'you' ? 'you' : 'them'
    row.innerHTML = '<b></b><span></span>'
    row.querySelector('b')!.textContent = who!; row.querySelector('span')!.textContent = words!
    column.append(row)
  }
  section.append(pane)
  host.append(section)
  const [land, owl] = pane.querySelectorAll('canvas')
  const painter = new NightScenePainter(land!, owl!)
  return { model, pane, painter, stats: section.querySelector('.stats')!, phase: pane.querySelector('.phase')!, layout: null, trip: 0, plan: null, t0: 0, last: -Infinity, delay: 0,
    s: { painted: 0, ms: [], flips: [], cells: [], frames: 0, since: 0 } }
}

function ink(panel: Panel): void {
  paint(panel.pane)
  const style = getComputedStyle(panel.pane.querySelector('.watcher-scene__ink')!)
  const text = toRgb(style.color, pixel)!, accent = toRgb(style.backgroundColor, pixel)!
  const surface = toRgb(getComputedStyle(panel.pane).backgroundColor, pixel)!
  const words = [style.color, style.borderTopColor, style.borderRightColor, style.borderBottomColor].map(toWord).filter((w): w is Word => w !== null)
  panel.painter.setInk(sceneInk(surface, text, accent, words), style.fontFamily)
  const card = toRgb(style.outlineColor, pixel)
  const cardWords = [style.color, style.borderTopColor, style.borderLeftColor].map(toWord).filter((w): w is Word => w !== null)
  if (card !== null) panel.pane.style.setProperty('--watcher-glass', `${Math.round(glassOpacity(card, cardWords) * 100)}%`)
  panel.painter.flightLook = { clean: panel.model.polish && state.polish, trail: panel.model.polish && state.polish }
  panel.layout = panel.painter.resize(measure, window.devicePixelRatio || 1)
}

const trips = state.trip === 'all' ? TRIPS : TRIPS.filter((_, k) => String(k) === state.trip)
const PAUSE = 1.1

function startTrip(panel: Panel, t: number): void {
  panel.plan = panel.model.plan(panel.layout!, trips[panel.trip % trips.length]!, t, { reduced: state.reduced, lock: state.lock })
  panel.t0 = t
}

function step(panel: Panel, t: number, now: number): void {
  if (panel.layout === null) return
  if (panel.plan === null) startTrip(panel, t)
  // A trip ends, the owl sits a moment, and the next trip starts.
  if (t > panel.t0 + panel.plan!.dur + PAUSE) { panel.trip++; startTrip(panel, t) }
  const local = Math.min(t, panel.t0 + panel.plan!.dur + 0.5)
  const started = performance.now()
  const flown = state.fly ? panel.plan!.at(local) : panel.model.plan(panel.layout, TRIPS[1]!, -100, { reduced: false, lock: state.lock }).at(t)
  const painted = panel.painter.draw({ t, still: false, ripples: [], watcher: { pose: flown.pose, stage: flown.stage }, owls: [], whirl: 0, pile: null })
  const ms = performance.now() - started
  const flying = state.fly && (flown.stage === 'flying' || (t >= panel.t0 && t < panel.t0 + panel.plan!.dur))
  panel.s.frames++
  if (painted) {
    panel.s.painted++
    if (flying) { panel.s.ms.push(ms); panel.s.flips.push(panel.painter.owlStats.flips); panel.s.cells.push(panel.painter.owlStats.cells) }
  }
  panel.phase.textContent = flown.phase
  panel.pane.dataset.owl = `${Math.round(flown.pose.x)},${Math.round(flown.pose.y)},${flown.phase},${painted ? panel.painter.owlStats.flips : -1},${panel.painter.owlStats.cells}`
  // The app's own pacing: about 30 frames a second while the owl flies, 8 checks a second at rest. Reduced motion
  // paces its few steps the same way, so each step paints in the frame it is due.
  panel.delay = flying && state.cadence !== null ? state.cadence : frameDelay(flying, 0, false)
  panel.last = now
}

const mean = (xs: number[]): number => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
const p95 = (xs: number[]): number => xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

function report(panel: Panel, now: number): void {
  const secs = (now - panel.s.since) / 1000
  if (secs < 1 || (state.manual && !(window as unknown as { owlFlush?: boolean }).owlFlush)) return
  const s = panel.s
  panel.stats.textContent = `${(s.painted / secs).toFixed(0)} paints/s · draw ${mean(s.ms).toFixed(2)} ms (p95 ${p95(s.ms).toFixed(2)}) · glyph flips ${mean(s.flips).toFixed(1)}/frame of ${mean(s.cells).toFixed(0)} cells`
  panel.pane.dataset.stats = JSON.stringify({ paintsPerSecond: s.painted / secs, drawMs: mean(s.ms), drawP95: p95(s.ms), flips: mean(s.flips), cells: mean(s.cells), samples: s.ms.length })
  panel.s = { painted: 0, ms: [], flips: [], cells: [], frames: 0, since: now }
}

function controls(): void {
  const bar = document.querySelector<HTMLElement>('.controls')!
  const select = (name: string, value: string, options: Array<[string, string]>): string =>
    `<label>${name} <select data-key="${name.toLowerCase()}">${options.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`
  bar.innerHTML = [
    select('Theme', state.theme, THEMES.map(theme => [theme.id, theme.label])),
    select('Mode', state.mode, [['dark', 'Dark'], ['light', 'Light']]),
    select('Trip', state.trip, [['all', 'Every trip in turn'], ...TRIPS.map((trip, k) => [String(k), `${trip.from} → ${trip.to}${trip.to === 'composer' ? ` (${trip.toSide})` : ''}`] as [string, string])]),
    select('Speed', String(state.slow), [['1', 'Real time'], ['0.5', 'Half speed'], ['0.25', 'Quarter speed']]),
    select('Lock', state.lock, [['cell', 'Whole-cell lock'], ['half', 'Half-cell lock'], ['none', 'No lock']]),
    `<label><input type="checkbox" data-key="polish"${state.polish ? ' checked' : ''}> Polish (clean edges, wing trail)</label>`,
    `<label><input type="checkbox" data-key="reduced"${state.reduced ? ' checked' : ''}> Reduce motion</label>`,
  ].join('')
  bar.addEventListener('change', event => {
    const target = event.target as HTMLInputElement | HTMLSelectElement
    const key = target.dataset.key!
    const next = new URLSearchParams(location.search)
    next.set(key === 'speed' ? 'slow' : key, target instanceof HTMLInputElement && target.type === 'checkbox' ? (target.checked ? '1' : '0') : target.value)
    // The sandbox Sotto shows a prototype in may refuse a changed URL; then the page simply reloads with it.
    try { location.search = next.toString() } catch { /* nothing to keep */ }
  })
}

async function main(): Promise<void> {
  if (state.mode === 'light') document.documentElement.dataset.theme = 'light'
  paint(document.documentElement)
  controls()
  await document.fonts.ready
  await document.fonts.load('10.5px "Spline Sans Mono"')
  const host = document.querySelector<HTMLElement>('.panels')!
  const panels = MODELS.filter(model => state.only === null || state.only.split(',').includes(model.id)).map(model => makePanel(model, host))
  for (const panel of panels) ink(panel)
  let clockMs = 0
  const start = performance.now()
  const tick = (now: number): void => {
    const t = (state.manual ? clockMs : now - start) / 1000 * state.slow
    for (const panel of panels) {
      if (panel.delay === null || !frameDue(now, panel.last, panel.delay)) continue
      step(panel, t, now)
    }
    for (const panel of panels) report(panel, now)
  }
  const w = window as unknown as Record<string, unknown>
  w.owlPanels = panels
  w.owlStep = (ms: number): void => { clockMs += ms; tick(clockMs) }
  w.owlTrips = (): number[] => panels.map(panel => panel.trip)
  if (!state.manual) { const loop = (now: number): void => { tick(now); requestAnimationFrame(loop) }; requestAnimationFrame(loop) }
  document.body.dataset.ready = '1'
}

void main()

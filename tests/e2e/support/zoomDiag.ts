// Temporary diagnostics for the terminal zoom stall (#1441). Removed before the fix lands.
import type { ElectronApplication, Page } from '@playwright/test'

type Cdp = { send(method: string, params?: Record<string, unknown>): Promise<unknown>; on(event: string, handler: (payload: unknown) => void): void }
type Metrics = Record<string, number>
interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }
interface TraceEvent { name: string; ph: string; dur?: number; ts: number; args?: Record<string, unknown> }

const METRIC_KEYS = ['RecalcStyleCount', 'RecalcStyleDuration', 'LayoutCount', 'LayoutDuration', 'ScriptDuration', 'TaskDuration', 'Nodes', 'JSEventListeners', 'LayoutObjects']

async function cdpSession(app: ElectronApplication, page: Page): Promise<Cdp | undefined> {
  try {
    const session = await app.context().newCDPSession(page) as unknown as Cdp
    await session.send('Performance.enable')
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 500 })
    return session
  } catch (error) {
    console.log('ZOOMDIAG cdp unavailable: ' + String(error))
    return undefined
  }
}

async function metrics(cdp: Cdp | undefined): Promise<Metrics> {
  if (!cdp) return {}
  const result = await cdp.send('Performance.getMetrics') as { metrics: { name: string; value: number }[] }
  return Object.fromEntries(result.metrics.map(metric => [metric.name, metric.value]))
}

const delta = (before: Metrics, after: Metrics): Metrics =>
  Object.fromEntries(METRIC_KEYS.map(key => [key, Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000) / 1000]))

/** Self time per function, from a CDP sampling profile. */
function profileTop(profile: Profile, count = 25): string[] {
  const self = new Map<number, number>()
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index]!
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index + 1] ?? 0))
  }
  const byFunction = new Map<string, number>()
  for (const node of profile.nodes) {
    const key = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').slice(-1)[0]}:${node.callFrame.lineNumber}`
    byFunction.set(key, (byFunction.get(key) ?? 0) + (self.get(node.id) ?? 0))
  }
  return [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key, micros]) => `${Math.round(micros / 1000)}ms ${key}`)
}

/** What the trace says style recalc and layout cost, and why elements were invalidated. */
function traceSummary(events: TraceEvent[]): Record<string, unknown> {
  const complete = events.filter(event => event.ph === 'X' && typeof event.dur === 'number')
  const summarize = (name: string, detail: (event: TraceEvent) => string) => {
    const list = complete.filter(event => event.name === name).sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
    return { count: list.length, totalMs: Math.round(list.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000), top: list.slice(0, 8).map(event => `${Math.round((event.dur ?? 0) / 1000)}ms ${detail(event)}`) }
  }
  const data = (event: TraceEvent): Record<string, unknown> => (event.args?.data ?? {}) as Record<string, unknown>
  const begin = (event: TraceEvent): Record<string, unknown> => (event.args?.beginData ?? {}) as Record<string, unknown>
  const counts = (name: string, key: (event: TraceEvent) => string): string[] => {
    const tally = new Map<string, number>()
    for (const event of events) if (event.name === name) tally.set(key(event), (tally.get(key(event)) ?? 0) + 1)
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, n]) => `${n}x ${key}`)
  }
  return {
    updateLayoutTree: summarize('UpdateLayoutTree', event => `elements=${String(event.args?.elementCount ?? begin(event).elementCount ?? '?')}`),
    layout: summarize('Layout', event => `dirty=${String(begin(event).dirtyObjects ?? '?')} total=${String(begin(event).totalObjects ?? '?')} partial=${String(begin(event).partialLayout ?? '?')}`),
    functionCall: summarize('FunctionCall', event => `${String(data(event).functionName)} ${String(data(event).url).split('/').slice(-1)[0]}:${String(data(event).lineNumber)}`),
    styleRecalcInvalidation: counts('StyleRecalcInvalidationTracking', event => `${String(data(event).reason)} ${String(data(event).extraData ?? '')} ${String((data(event).selectorPart as string | undefined) ?? '')}`.trim()),
    styleInvalidatorInvalidation: counts('StyleInvalidatorInvalidationTracking', event => `${String(data(event).reason)} ${String(data(event).extraData ?? '')} ${String(((data(event).selectors as { selector: string }[] | undefined) ?? []).map(s => s.selector).join(' | '))}`.trim()),
    scheduleStyleInvalidationTracking: counts('ScheduleStyleInvalidationTracking', event => `${String(data(event).invalidationSet ?? '')} ${String(data(event).changedClass ?? data(event).changedAttribute ?? data(event).changedId ?? data(event).changedPseudo ?? '')}`.trim()),
    names: counts('', () => '').length ? [] : [...new Set(events.map(event => event.name))].slice(0, 60),
  }
}

/**
 * Press, then watch until `settled`, with CPU profile, trace and performance metrics around it. The renderer's own
 * `window.__zoomDiag` probe list is reset first and printed after.
 */
export async function zoomDiagnostics(app: ElectronApplication, page: Page, label: string, press: () => Promise<void>, settled: () => Promise<boolean>, { trace = true }: { trace?: boolean } = {}): Promise<void> {
  const cdp = await cdpSession(app, page)
  const traceEvents: TraceEvent[] = []
  let tracingComplete: Promise<void> | undefined
  await page.evaluate(() => {
    const list: [string, number][] = []; (window as { __zoomDiag?: unknown[] }).__zoomDiag = list
    new PerformanceObserver(entries => { for (const entry of entries.getEntries()) list.push([`longtask ${Math.round(entry.duration)}ms`, Math.round(performance.timeOrigin + entry.startTime)]) }).observe({ type: 'longtask', buffered: false })
  })
  let tracing = false
  if (cdp && trace) {
    try {
      cdp.on('Tracing.dataCollected', payload => { traceEvents.push(...(payload as { value: TraceEvent[] }).value) })
      tracingComplete = new Promise<void>(resolve => cdp.on('Tracing.tracingComplete', () => resolve()))
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReportEvents' })
      tracing = true
    } catch (error) { console.log('ZOOMDIAG tracing unavailable: ' + String(error)) }
  }
  const before = await metrics(cdp)
  if (cdp) await cdp.send('Profiler.start').catch(() => undefined)
  const start = Date.now()
  await press()
  const pressed = Date.now() - start
  let settledAt = -1
  const probes: string[] = []
  for (let index = 0; index < 300; index++) {
    const at = Date.now()
    const done = await Promise.race([settled(), new Promise<string>(resolve => setTimeout(() => resolve('HUNG'), 5_000))])
    probes.push(`${at - start}+${Date.now() - at} ${String(done)}`)
    if (done === true) { settledAt = Date.now() - start; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const after = await metrics(cdp)
  let top: string[] = []
  if (cdp) {
    try { const { profile } = await cdp.send('Profiler.stop') as { profile: Profile }; top = profileTop(profile) } catch (error) { top = ['profile failed ' + String(error)] }
  }
  let summary: Record<string, unknown> = {}
  if (cdp && tracing) {
    try {
      await cdp.send('Tracing.end')
      await Promise.race([tracingComplete, new Promise(resolve => setTimeout(resolve, 20_000))])
      summary = traceSummary(traceEvents)
      summary.events = traceEvents.length
    } catch (error) { summary = { failed: String(error) } }
  }
  const renderer = await page.evaluate(() => (window as { __zoomDiag?: [string, number][] }).__zoomDiag ?? [])
  const rel = renderer.map(([name, at]) => `${at - start} ${name}`)
  console.log(`ZOOMDIAG ${label} ` + JSON.stringify({ pressMs: pressed, settledMs: settledAt, metrics: delta(before, after), renderer: rel, probes: probes.slice(0, 6).concat(probes.length > 6 ? [`... ${probes.length} probes`] : []), profileTop: top, trace: summary }, null, 1))
}

/** Page-level costs: one forced whole-document style recalc, DOM size, `:has()` rules, xterm's own style rewrite, running loops. */
export async function pageFacts(page: Page, label: string): Promise<void> {
  const facts = await page.evaluate(async () => {
    const time = (work: () => void): number => { const t0 = performance.now(); work(); return Math.round((performance.now() - t0) * 10) / 10 }
    const recalc = (): number => time(() => { document.documentElement.classList.toggle('zoom-diag-toggle'); void document.body.offsetHeight })
    const classOnTerminal = (): number => time(() => { document.querySelector('.terminal-view__screen')?.classList.toggle('zoom-diag-toggle'); void document.body.offsetHeight })
    const styleRewrite = (): number => time(() => {
      for (const style of document.querySelectorAll('.xterm-screen > style')) style.textContent = style.textContent
      void document.body.offsetHeight
    })
    const rowChurn = (): number => time(() => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')]
      for (const row of rows) { const span = document.createElement('span'); span.textContent = ' '; row.append(span); void span.offsetWidth; span.remove() }
    })
    const measureSpan = (): number => time(() => {
      const span = document.querySelector('.xterm-width-cache-measure-container span') as HTMLElement | null
      if (!span) return
      for (let index = 0; index < 20; index++) { span.textContent = String.fromCharCode(65 + index).repeat(32); void span.offsetWidth }
    })
    const rules = (list: CSSRuleList): CSSRule[] => [...list].flatMap(rule => [rule, ...('cssRules' in rule ? rules((rule as CSSGroupingRule).cssRules) : [])])
    let unreadable = 0
    const all = [...document.styleSheets].flatMap(sheet => { try { return rules(sheet.cssRules) } catch { unreadable++; return [] } })
    const has = all.filter(rule => rule instanceof CSSStyleRule && rule.selectorText.includes(':has('))
    let rafCalls = 0
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = callback => { rafCalls++; return original.call(window, callback) }
    await new Promise(resolve => setTimeout(resolve, 500))
    window.requestAnimationFrame = original
    const sample = <T,>(work: () => T, times = 4): T[] => Array.from({ length: times }, work)
    return {
      nodes: document.getElementsByTagName('*').length,
      xtermNodes: document.querySelector('.xterm')?.getElementsByTagName('*').length ?? 0,
      sheets: document.styleSheets.length, rulesTotal: all.length, unreadableSheets: unreadable, hasRules: has.length,
      canvases: document.querySelectorAll('canvas').length, animations: document.getAnimations().length, rafCallsPer500ms: rafCalls,
      recalcMs: sample(recalc), classOnTerminalMs: sample(classOnTerminal), xtermStyleRewriteMs: sample(styleRewrite), rowChurnMs: sample(rowChurn, 2), measureSpan20Ms: sample(measureSpan, 2),
      containerQueries: all.filter(rule => rule.constructor.name === 'CSSContainerRule').length,
    }
  })
  console.log(`ZOOMDIAG facts ${label} ` + JSON.stringify(facts))
}

/** Remove every rule whose selector contains `:has(`, keeping what is needed to put them back. */
export async function stripHasRules(page: Page): Promise<void> {
  const removed = await page.evaluate(() => {
    type Group = CSSStyleSheet | CSSGroupingRule
    const restore: { group: Group; index: number; cssText: string }[] = []
    const strip = (group: Group): void => {
      for (let index = group.cssRules.length - 1; index >= 0; index--) {
        const rule = group.cssRules[index]!
        if (rule instanceof CSSStyleRule && rule.selectorText.includes(':has(')) { restore.push({ group, index, cssText: rule.cssText }); group.deleteRule(index) }
        else if ('cssRules' in rule) strip(rule as CSSGroupingRule)
      }
    }
    for (const sheet of document.styleSheets) { try { strip(sheet) } catch { /* cross-origin */ } }
    ;(window as { __zoomRestore?: () => number }).__zoomRestore = () => {
      // Put them back lowest index first per group, so the saved indexes stay valid.
      const list = [...restore].reverse()
      for (const { group, index, cssText } of list) group.insertRule(cssText, index)
      return list.length
    }
    return restore.length
  })
  console.log(`ZOOMDIAG stripped ${removed} :has() rules`)
}

export async function restoreHasRules(page: Page): Promise<void> {
  const restored = await page.evaluate(() => (window as { __zoomRestore?: () => number }).__zoomRestore?.() ?? -1)
  console.log(`ZOOMDIAG restored ${restored} :has() rules`)
}

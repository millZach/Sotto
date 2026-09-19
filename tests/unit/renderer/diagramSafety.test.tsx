import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDiagramPalette, mixHex } from '../../../src/renderer/src/agents/diagrams/diagramPalette'
import {
  MAX_DIAGRAM_SOURCE_LENGTH, inspectDiagramSource, isFenceClosed, stripDiagramConfiguration,
} from '../../../src/renderer/src/agents/diagrams/diagramSource'
import { svgDataUrl, toInertDiagramSvg } from '../../../src/renderer/src/agents/diagrams/diagramSvg'
import { clampPan, clampScale, fitScale } from '../../../src/renderer/src/agents/diagrams/DiagramViewer'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), mermaidAPI: { getDiagramFromText: vi.fn() }, render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

afterEach(() => {
  vi.useRealTimers()
  mermaid.initialize.mockReset()
  mermaid.mermaidAPI.getDiagramFromText.mockReset()
  mermaid.render.mockReset()
})

const SVG_NS = 'http://www.w3.org/2000/svg'

function parse(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml')
}

function decode(dataUrl: string): string {
  const bytes = Uint8Array.from(atob(dataUrl.slice('data:image/svg+xml;base64,'.length)), character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const HOSTILE_SVG = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:evil="urn:evil" id="d" viewBox="0 0 200.4 100" style="max-width: 200px; background:url(https://t.example/root.png)" onload="window.pwned=1">
  <title>Login</title><desc>Two people exchange a token.</desc>
  <style>@import url(https://t.example/a.css); #d .node{fill:url(https://t.example/fill.png)} #d .edge{stroke:u\\72l(https://t.example/escaped.png)} #d .ok{fill:url(#grad)} @font-face{font-family:x;src:url(https://t.example/font.woff2)}</style>
  <script>window.pwned=2</script>
  <defs><linearGradient id="grad"><stop offset="0" stop-color="red"/></linearGradient></defs>
  <g class="node" onclick="window.pwned=3" evil:attr="1" style="fill:url('https://t.example/inline.png');stroke:red">
    <rect width="10" height="10" fill="url(#grad)" filter="url(https://t.example/filter.svg#f)"/>
    <a href="https://t.example/link" xlink:href="javascript:window.pwned=4" target="_blank"><text>Open</text></a>
    <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://t.example/x.png"/></div></foreignObject>
    <image href="https://t.example/image.png" width="5" height="5"/>
    <use href="https://t.example/sprite.svg#icon"/><use href="#grad"/><circle r="1" fill="u\\72l(https://t.example/attr.png)" style="stroke:u\\72l(https://t.example/style.png);fill:red"/>
    <animate attributeName="href" to="javascript:window.pwned=5"/><set attributeName="onclick" to="x"/>
    <iframe src="https://t.example/frame"/>
    <!-- comment --><![CDATA[ raw ]]>
  </g>
</svg>`

describe('diagram source inspection', () => {
  it('names the drawn kinds and explains everything it does not draw', () => {
    expect(inspectDiagramSource('sequenceDiagram\n  A->>B: hi')).toMatchObject({ kind: 'sequence', label: 'Sequence diagram', problem: null })
    expect(inspectDiagramSource('graph TD\n  A-->B')).toMatchObject({ kind: 'flowchart', label: 'Flowchart' })
    expect(inspectDiagramSource('  %% note\n\nflowchart LR\n  A-->B')).toMatchObject({ kind: 'flowchart' })
    expect(inspectDiagramSource('stateDiagram-v2\n  [*] --> A')).toMatchObject({ kind: 'state', label: 'State diagram' })
    expect(inspectDiagramSource('classDiagram\n  A <|-- B')).toMatchObject({ kind: 'class' })
    expect(inspectDiagramSource('erDiagram\n  A ||--o{ B : has')).toMatchObject({ kind: 'er', label: 'Entity relationship diagram' })
    expect(inspectDiagramSource('pie title Pets\n "Dogs" : 3').problem).toBe('Sotto doesn’t draw “pie” diagrams. Sequence, flow, state, class and entity diagrams are drawn.'.replace('’', "'"))
    expect(inspectDiagramSource('   \n%%{init: {}}%%\n').problem).toBe('This diagram is empty.')
    const long = inspectDiagramSource(`flowchart TD\n${'  A-->B\n'.repeat(MAX_DIAGRAM_SOURCE_LENGTH / 8)}`)
    expect(long).toMatchObject({ kind: null, code: '', problem: 'Too long to draw. Diagrams over 12,000 characters are shown as source.' })
  })

  it('removes directives and front-matter configuration anywhere, keeping only a plain title', () => {
    const source = [
      '﻿---', 'title: "Login ‮flow"', 'config:', '  securityLevel: loose', '  themeCSS: "* { background: url(https://t.example) }"', '---',
      '%%{init: {"securityLevel": "loose"}}%%', 'sequenceDiagram', '  %%{', '  wrap', '  }%%', '  A->>B: hi %%{init: {"theme": "dark"}}%%',
    ].join('\n')
    const { code, title } = stripDiagramConfiguration(source)
    expect(title).toBe('Login flow')
    expect(code).toBe('---\ntitle: "Login flow"\n---\n\nsequenceDiagram\n  \n  A->>B: hi ')
    expect(code).not.toMatch(/securityLevel|themeCSS|%%\{|config:/u)
    expect(inspectDiagramSource(source)).toMatchObject({ kind: 'sequence', title: 'Login flow' })
    // A title line cannot smuggle YAML: it is re-emitted as one JSON string.
    expect(stripDiagramConfiguration('---\ntitle: x\n  config: {securityLevel: loose}\n---\ngraph TD').code).toMatch(/^---\ntitle: "x"\n---\n/u)
  })

  it('treats a fence as complete only once its matching closing fence has arrived', () => {
    expect(isFenceClosed('```mermaid\nflowchart TD\n  A-->B')).toBe(false)
    expect(isFenceClosed('```mermaid\nflowchart TD\n```')).toBe(true)
    expect(isFenceClosed('````mermaid\nflowchart TD\n```')).toBe(false)
    expect(isFenceClosed('```mermaid\nflowchart TD\n~~~')).toBe(false)
    expect(isFenceClosed('~~~mermaid\ngraph TD\n~~~~\n')).toBe(true)
    expect(isFenceClosed('> ```mermaid\n> graph TD\n> ```')).toBe(true)
    expect(isFenceClosed('- ```mermaid\n  graph TD\n  ```')).toBe(true)
    expect(isFenceClosed('```mermaid')).toBe(false)
  })
})

describe('inert diagram SVG', () => {
  it('removes script, handlers, foreign content, external links, images, resource URLs and animation', () => {
    const image = toInertDiagramSvg(HOSTILE_SVG, { trustedCss: '@font-face{font-family:"Bricolage Grotesque";src:url(data:font/woff2;base64,AAAA)}' })!
    expect(image).toMatchObject({ width: 201, height: 100, title: 'Login', description: 'Two people exchange a token.' })
    const markup = image.svg
    expect(markup).not.toMatch(/<script|<foreignObject|<iframe|<image|<animate|<set\b|<a\b|onload|onclick|javascript:|t\.example|@import|evil:|target=|<!--|CDATA/iu)
    const document = parse(markup)
    const root = document.documentElement
    expect(root.getAttribute('style')).toBeNull()
    expect(root.getAttribute('viewBox')).toBe('0 0 201 100')
    expect(document.querySelector('text')?.textContent).toBe('Open')
    expect([...document.querySelectorAll('use')].map(use => use.getAttribute('href'))).toEqual([null, '#grad'])
    expect(document.querySelector('rect')?.getAttribute('fill')).toBe('url(#grad)')
    expect(document.querySelector('rect')?.getAttribute('filter')).toBe('none')
    // A CSS escape that could spell url( drops the value instead of being decoded.
    expect(document.querySelector('circle')?.getAttribute('fill')).toBeNull()
    expect(document.querySelector('circle')?.getAttribute('style')).toBe('fill:red')
    const styles = [...document.querySelectorAll('style')].map(style => style.textContent)
    // Sotto's own stylesheet comes first and keeps its data: font; Mermaid's keeps only fragment references.
    expect(styles[0]).toContain('url(data:font/woff2;base64,AAAA)')
    expect(styles[1]).toContain('fill:url(#grad)')
    expect(styles[1]).not.toMatch(/url\((?!#)/u)
  })

  it('refuses anything that is not a sized SVG drawing', () => {
    expect(toInertDiagramSvg('<html><body>hi</body></html>')).toBeNull()
    expect(toInertDiagramSvg(`<svg xmlns="${SVG_NS}"><g/></svg>`)).toBeNull()
    expect(toInertDiagramSvg(`<svg xmlns="${SVG_NS}" viewBox="0 0 0 10"/>`)).toBeNull()
    expect(toInertDiagramSvg(`<svg xmlns="${SVG_NS}" viewBox="0 0 10 10"><g></svg>`)).toBeNull()
  })

  it('sizes the drawing from measured bounds when a measurement is available', () => {
    const svg = `<svg xmlns="${SVG_NS}" viewBox="-64 -25 300 320"><rect x="0" y="0" width="10" height="10"/></svg>`
    expect(toInertDiagramSvg(svg, { measure: () => ({ x: 10, y: 0, width: 230, height: 330 }) })).toMatchObject({ width: 254, height: 354 })
    expect(parse(toInertDiagramSvg(svg, { measure: () => ({ x: 10, y: 0, width: 230, height: 330 }) })!.svg).documentElement.getAttribute('viewBox')).toBe('-2 -12 254 354')
    expect(toInertDiagramSvg(svg, { measure: () => null })).toMatchObject({ width: 300, height: 320 })
    expect(toInertDiagramSvg(svg, { measure: () => ({ x: 0, y: 0, width: 0, height: Number.NaN }) })).toMatchObject({ width: 300, height: 320 })
  })

  it('encodes non-Latin labels intact', () => {
    const svg = `<svg xmlns="${SVG_NS}"><text>Übersicht → 日本</text></svg>`
    expect(decode(svgDataUrl(svg))).toBe(svg)
  })
})

describe('diagram palette and viewer geometry', () => {
  it('mixes theme colours as plain hex', () => {
    expect(mixHex('#ffffff', '#000000', 0.5)).toBe('#808080')
    expect(mixHex('#47b8a9', '#0a0d0b', 0.16)).toBe('#142824')
    expect(mixHex('#fff', '#000', 1)).toBe('#ffffff')
  })

  it('falls back to Tide dark or light colours when tokens cannot be read', () => {
    const root = document.createElement('html')
    expect(readDiagramPalette(root)).toMatchObject({ dark: true, text: '#fffaff', accent: '#70b9ee' })
    root.dataset.theme = 'light'
    root.style.setProperty('--tt-accent', '#AA3355')
    root.style.setProperty('--tt-text', 'color-mix(in srgb, red, blue)')
    document.body.appendChild(root)
    expect(readDiagramPalette(root)).toMatchObject({ dark: false, text: '#241523', accent: '#aa3355' })
    root.remove()
  })

  it('fits, clamps zoom and keeps a panned drawing reachable', () => {
    expect(fitScale(400, 200, 1000, 600)).toBe(2)
    expect(fitScale(2000, 400, 1064, 600)).toBe(0.5)
    expect(fitScale(0, 200, 1000, 600)).toBe(1)
    expect(clampScale(100, 0.5)).toBe(4)
    expect(clampScale(0.01, 0.5)).toBe(0.25)
    expect(clampScale(0.01, 2)).toBe(0.5)
    expect(clampScale(9, 6)).toBe(6)
    const view = { scale: 1, x: 5000, y: -5000, fitted: false }
    expect(clampPan(view, 400, 200, 1000, 600)).toEqual({ scale: 1, x: 636, y: -336, fitted: false })
  })
})

describe('diagram renderer', () => {
  const palette = readDiagramPalette(undefined)
  // These renderer lifecycle tests start with an admitted parsed graph. The neighboring
  // diagramSafety.test.ts exercises the real parser and all resource/complexity boundaries.
  const parsedGraph = { type: 'stateDiagram', db: { getData: () => ({ nodes: [{ id: 'A' }], edges: [] }) } }

  async function renderer() {
    return import('../../../src/renderer/src/agents/diagrams/diagramRenderer')
  }

  it('configures Mermaid strictly and returns an inert image with the Sotto label face', async () => {
    const { renderDiagram } = await renderer()
    mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue(parsedGraph)
    mermaid.render.mockImplementation(async (id: string, _code: string, container: Element) => {
      expect(container.isConnected).toBe(true)
      expect(container).toHaveAttribute('inert')
      return { svg: HOSTILE_SVG.replace('id="d"', `id="${id}"`) }
    })
    const result = await renderDiagram('flowchart TD\n  A-->B', palette)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ title: 'Login', description: 'Two people exchange a token.' })
    const svg = decode(result.dataUrl)
    expect(svg).toContain('font-family:"Figtree"')
    expect(svg).not.toMatch(/<script|onload|t\.example/u)
    expect(document.querySelector('[data-diagram-stage]')).toBeNull()
    const config = mermaid.initialize.mock.calls[0]![0]
    expect(config).toMatchObject({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false, maxTextSize: 12_000, maxEdges: 300, flowchart: { htmlLabels: false } })
    expect(config.secure).toEqual(expect.arrayContaining(['securityLevel', 'themeCSS', 'themeVariables', 'htmlLabels', 'dompurifyConfig', 'maxTextSize', 'fontFamily']))
    // The same source and appearance is served from the cache.
    await renderDiagram('flowchart TD\n  A-->B', palette)
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it('turns grammar errors into a short line reason', async () => {
    const { renderDiagram, readableDiagramError } = await renderer()
    mermaid.mermaidAPI.getDiagramFromText.mockRejectedValue(new Error("Parse error on line 3:\n...B -->> C((\n-----^\nExpecting 'SQE', 'PIPE', got 'PS'"))
    await expect(renderDiagram('flowchart TD\n  bad', palette)).resolves.toEqual({ ok: false, reason: 'The source has a syntax error on line 3.' })
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(readableDiagramError(new Error('Maximum text size in diagram exceeded'))).toBe('Maximum text size in diagram exceeded.')
    expect(readableDiagramError({})).toBe('Mermaid could not read this diagram.')
  })

  it('reports a slow render, keeps renders one at a time, and retries a slow source later', async () => {
    const { renderDiagram } = await renderer()
    // The renderer's budget is a timer and its own `performance.now()` reading, so the test owns both
    // clocks. A 30 ms stopwatch run against real time says whether the machine was busy, not whether
    // the renderer gave up when it should have.
    vi.useFakeTimers()
    let finishSlow!: (value: { svg: string }) => void
    mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue(parsedGraph)
    mermaid.render.mockImplementationOnce(() => new Promise(resolve => { finishSlow = resolve }))
    const slow = renderDiagram('stateDiagram-v2\n  slow', palette, 30)
    const next = renderDiagram('stateDiagram-v2\n  next', palette, 30)
    await vi.advanceTimersByTimeAsync(31)
    await expect(slow).resolves.toEqual({ ok: false, reason: 'Took too long to draw.' })
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    mermaid.render.mockResolvedValue({ svg: `<svg xmlns="${SVG_NS}" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>` })
    finishSlow({ svg: `<svg xmlns="${SVG_NS}" viewBox="0 0 10 10"/>` })
    // The waiting render's own clock starts only when it starts: the 31 ms the slow render held
    // Mermaid are past its own 30 ms budget, and it still draws.
    await expect(next).resolves.toMatchObject({ ok: true, width: 10, height: 10 })
    await expect(renderDiagram('stateDiagram-v2\n  slow', palette, 30)).resolves.toMatchObject({ ok: true })
    expect(mermaid.render).toHaveBeenCalledTimes(3)
  })
})

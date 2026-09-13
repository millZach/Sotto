import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const output = resolve('test-results/diagram-safety-fixture')
let app: ElectronApplication
let page: Page
declare global {
  interface Window {
    diagramSafetyProbe(source: string, direct?: boolean, timeoutMs?: number): Promise<{
      ok: boolean; reason: string | null; ms: number; tickAt: number | null; stages: number; remainingStages: number
    }>
    diagramSafetyMessage(source: string): void
  }
}

test.beforeAll(async () => {
  await mkdir(output, { recursive: true })
  await build({ entryPoints: [resolve('tests/fixtures/diagramSafety/entry.tsx')], bundle: true,
    format: 'iife', platform: 'browser', outfile: join(output, 'bundle.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'warning' })
  const csp = (await readFile(resolve('src/renderer/index.html'), 'utf8')).match(/content="(default-src[^"]+)"/)![1]
  await writeFile(join(output, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="./bundle.css"><body><script src="./bundle.js"></script></body>`)
  await writeFile(join(output, 'synthetic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
  const env = Object.fromEntries(Object.entries({ ...process.env, SOTTO_DIAGRAM_SAFETY_DIR: output })
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  app = await electron.launch({ args: [resolve('tests/fixtures/diagramSafety/electronMain.cjs')], env })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.diagramSafetyProbe)
  await page.evaluate(() => {
    Object.assign(window, { safetyViolations: [] })
    document.addEventListener('securitypolicyviolation', event => {
      (window as unknown as { safetyViolations: string[] }).safetyViolations.push(event.blockedURI)
    })
  })
})
test.afterAll(async () => { await app?.close() })
test.afterEach(async () => {
  // Also assert after failed tests; Playwright restarts workers after failure.
  if (!app) return
  const unexpected = await app.evaluate(() => (globalThis as unknown as { diagramSafety: { unexpected: string[] } }).diagramSafety.unexpected)
  expect(unexpected).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { safetyViolations: string[] }).safetyViolations)).toEqual([])
})

async function probe(source: string) {
  const result = await page.evaluate(source => window.diagramSafetyProbe(source), source)
  console.log(JSON.stringify({ length: source.length, ...result }))
  expect(result.remainingStages).toBe(0)
  return result
}

test('rejects parsed local/network image metadata before measurement, including YAML escapes', async () => {
  const local = pathToFileURL(join(output, 'synthetic.svg')).href
  for (const key of ['img', '"im\\u0067"', '"\\x69mg"']) {
    for (const url of [local, 'https://tracker.invalid/synthetic.svg']) {
      const result = await probe(`flowchart TD\nA@{ ${key}: "${url}", label: "Probe" }`)
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/resource|image/i)
      expect(result.stages).toBe(0)
    }
  }
})

test('rejects exact dense-state and 1000-node repros responsively before any layout', async () => {
  const dense = 'stateDiagram-v2\n' + Array.from({ length: 40 }, (_, i) =>
    Array.from({ length: 39 - i }, (_, j) => `A${i}-->A${i + j + 1}`).join('\n')).join('\n')
  const nodes = 'flowchart TD\n' + Array.from({ length: 1000 }, (_, i) => `A${i}`).join('\n')
  expect(dense.length).toBe(7426)
  expect(nodes.length).toBe(4902)
  for (const source of [dense, nodes]) {
    const result = await probe(source)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/complex|limit|large/i)
    expect(result.stages).toBe(0)
    expect(result.ms).toBeLessThan(500)
    expect(result.tickAt).toBeLessThan(500)
  }
})

test('ordinary admitted kinds still render and malformed input retains a bounded reason', async () => {
  for (const source of ['flowchart TD\nA[Start] --> B[Done]', 'sequenceDiagram\nA->>B: Hello',
    'stateDiagram-v2\n[*] --> Idle\nIdle --> Running', 'stateDiagram\nA --> B',
    'classDiagram\nAnimal <|-- Duck', 'erDiagram\nCUSTOMER ||--o{ ORDER : places']) {
    expect((await probe(source)).ok).toBe(true)
  }
  const invalid = await probe('flowchart TD\nA[Start --> B')
  expect(invalid.ok).toBe(false)
  expect(invalid.reason).toMatch(/syntax error on line 3/i)
  expect(invalid.reason!.length).toBeLessThanOrEqual(220)
})

test('parsed limits cover compact graphs, every kind and nesting before layout', async () => {
  const cases = [
    'flowchart TD\nA & B & C & D & E & F & G & H --> I & J & K & L & M & N & O & P',
    'flowchart TD\nA ----------> B',
    'stateDiagram-v2\n' + Array.from({ length: 41 }, (_, i) => `A${i}: State`).join('\n'),
    'classDiagram\n' + Array.from({ length: 41 }, (_, i) => `class A${i}`).join('\n'),
    'erDiagram\n' + Array.from({ length: 41 }, (_, i) => `A${i}`).join('\n'),
    'sequenceDiagram\n' + Array.from({ length: 17 }, (_, i) => `participant A${i}`).join('\n'),
    'stateDiagram-v2\n' + Array.from({ length: 61 }, () => 'A-->B').join('\n'),
    'classDiagram\n' + Array.from({ length: 61 }, () => 'A-->B').join('\n'),
    'sequenceDiagram\n' + Array.from({ length: 61 }, () => 'A->>B: hi').join('\n'),
    'flowchart TD\nsubgraph A\nsubgraph B\nsubgraph C\nsubgraph D\nE\nend\nend\nend\nend',
    'stateDiagram-v2\nstate A {\nstate B {\nstate C {\nstate D {\nE --> F\n}\n}\n}\n}',
    'classDiagram\nnamespace A.B.C.D {\nclass E\n}',
    'erDiagram\nsubgraph A\nsubgraph B\nsubgraph C\nsubgraph D\nE\nend\nend\nend\nend',
    'sequenceDiagram\nloop a\nloop b\nloop c\nloop d\nA->>B: hi\nend\nend\nend\nend',
  ]
  for (const source of cases) {
    const result = await probe(source)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/complex/i)
    expect(result.stages).toBe(0)
    expect(result.ms).toBeLessThan(500)
    expect(result.tickAt).toBeLessThan(500)
  }
})

test('direct renderer calls enforce source inspection and report an elapsed deadline truthfully', async () => {
  for (const source of ['flowchart TD\n' + Array.from({ length: 1000 }, (_, i) => `N${i}`).join('\n'), 'pie\n"x": 1', 'x'.repeat(12001)]) {
    const result = await page.evaluate(source => window.diagramSafetyProbe(source, true), source)
    expect(result.ok).toBe(false)
    expect(result.stages).toBe(0)
  }
  const late = await page.evaluate(() => window.diagramSafetyProbe('flowchart TD\nDeadlineA --> DeadlineB', true, 0.01))
  expect(late.ok).toBe(false)
  expect(late.reason).toBe('Took too long to draw.')
  expect(late.remainingStages).toBe(0)
})

test('representative graphs near admitted complexity ceilings remain responsive', async () => {
  const chain = Array.from({ length: 34 }, (_, i) => `A${i}-->A${i + 1}`).join('\n')
  const sequence = 'sequenceDiagram\n' + Array.from({ length: 16 }, (_, i) => `participant A${i}`).join('\n') + '\n' +
    Array.from({ length: 37 }, (_, i) => `A${i % 16}->>A${(i + 1) % 16}: Ping`).join('\n')
  for (const source of ['flowchart TD\n' + chain, 'stateDiagram-v2\n' + chain, sequence]) {
    const result = await probe(source)
    expect(result.ok).toBe(true)
    expect(result.ms).toBeLessThan(500)
    expect(result.tickAt).toBeLessThan(500)
  }
})

test('hostile labels/configuration remain inert throughout successful renders', async () => {
  const local = pathToFileURL(join(output, 'synthetic.svg')).href
  for (const source of [
    `flowchart TD\nA["<img src='${local}' onerror='window.pwned=1'>"] --> B["#60;img src='${local}'#62;"]\nclick A "https://tracker.invalid/click"`,
    `sequenceDiagram\nA->>B: <img src='${local}' onerror='window.pwned=1'>`,
    `stateDiagram-v2\nstate "<img src='${local}'>" as A\nA --> B`,
    `classDiagram\nclass A["<img src='${local}'>"]`,
    `flowchart TD\nA["\u0060![image](${local})\u0060"]`,
    `%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body{background:url(${local})}"}}%%\nflowchart TD\nA[Safe] --> B[Done]`,
    `---\nconfig:\n  securityLevel: loose\n  themeCSS: "body{background:url(${local})}"\n---\nsequenceDiagram\nA->>B: Safe`,
  ]) expect((await probe(source)).ok).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { pwned?: unknown }).pwned)).toBeUndefined()
})

test('existing message component shows the exact source and truthful safety reason', async () => {
  const local = pathToFileURL(join(output, 'synthetic.svg')).href
  for (const source of [`flowchart TD\nA@{ "im\\u0067": "${local}", label: "Probe" }`,
    'stateDiagram-v2\n' + Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 39 - i }, (_, j) => `A${i}-->A${i + j + 1}`).join('\n')).join('\n')]) {
    await page.evaluate(source => window.diagramSafetyMessage(source), source)
    const block = page.locator('.rich-diagram')
    await expect(block).toHaveAttribute('data-state', 'failed')
    await expect(block.locator('.rich-diagram__notice')).toBeVisible()
    await expect(block.locator('.rich-diagram__notice')).toContainText(/resources|parser work limit/)
    await expect(block.locator('pre')).toBeVisible()
    expect(await block.locator('pre').textContent()).toBe(source)
    await expect(block.locator('img')).toHaveCount(0)
    await expect(block.getByRole('button', { name: 'Copy diagram source' })).toBeVisible()
  }
})

test('observes the entire lifecycle with zero unexpected file/network requests or CSP attempts', async () => {
  await page.waitForTimeout(250)
  const record = await app.evaluate(() => (globalThis as unknown as { diagramSafety: {
    requests: string[]; unexpected: string[]; navigations: string[]; popups: string[]
  } }).diagramSafety)
  expect(record.requests).toContain(pathToFileURL(join(output, 'index.html')).href)
  expect(record.requests).toContain(pathToFileURL(join(output, 'bundle.js')).href)
  expect(record.unexpected).toEqual([])
  expect(record.navigations).toEqual([])
  expect(record.popups).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { safetyViolations: string[] }).safetyViolations)).toEqual([])
})

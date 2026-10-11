import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import process from 'node:process'

import { expect } from '@playwright/test'
import sharp from 'sharp'

import { DESIGN_CAPTURE_REQUIREMENTS, DESIGN_CAPTURE_WIDGET_THEMES, designCaptureTupleKey } from '../../../scripts/design-capture-matrix.mjs'

export const repositoryRoot = process.cwd()
export const baselineRoot = resolve(repositoryRoot, 'artifacts/design/app-review/baseline')
const manifestPath = resolve(repositoryRoot, 'artifacts/design/app-review/manifest.json')
const widgetThemes = DESIGN_CAPTURE_WIDGET_THEMES
const externalWidgetStates = ['listening', 'processing', 'pasted', 'copied', 'error']
const requirementsById = new Map(DESIGN_CAPTURE_REQUIREMENTS.map((requirement) => [requirement.id, requirement]))

export function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function requiredMetadata(fileName) {
  const id = fileName.replace(/\.png$/u, '')
  const requirement = requirementsById.get(id)
  if (requirement === undefined) throw new Error(`Capture is not in the explicit design matrix: ${id}`)
  return requirement
}

async function externalWidgetEntries() {
  const entries = []
  for (const theme of widgetThemes) {
    for (const state of externalWidgetStates) {
      const path = resolve(repositoryRoot, `artifacts/design/baseline/${state}-${theme}.png`)
      const image = await readFile(path)
      const metadata = await sharp(image).metadata()
      if (metadata.width !== 248 || metadata.height !== 88) throw new Error(`Unexpected widget baseline geometry: ${path}`)
      const requirement = requiredMetadata(`widget-${state}-${theme}.png`)
      if (requirement.source !== 'widget-baseline') throw new Error(`External widget matrix source mismatch: ${state}-${theme}`)
      entries.push({
        ...requirement,
        relativePath: relative(repositoryRoot, path).replaceAll('\\', '/'),
        width: metadata.width,
        height: metadata.height,
        sha256: digest(image),
      })
    }
  }
  return entries
}

/** Each spec/worker appends its own fragment so no mutable state crosses workers. */
export async function recordCaptureEntry(entry, specFile, workerIndex) {
  const fragmentsRoot = process.env.SOTTO_DESIGN_CAPTURE_FRAGMENTS
  if (fragmentsRoot === undefined) throw new Error('Run through npm run design:capture or npm run design:verify')
  const fragmentPath = resolve(fragmentsRoot, `${basename(specFile)}.${workerIndex}.jsonl`)
  await appendFile(fragmentPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function finalizeDesignCaptures(fragmentsRoot, updateBaselines) {
  const capturedEntries = []
  for (const name of await readdir(fragmentsRoot)) {
    if (!name.endsWith('.jsonl')) continue
    const fragment = await readFile(resolve(fragmentsRoot, name), 'utf8')
    for (const line of fragment.trim().split('\n')) {
      if (line !== '') capturedEntries.push(JSON.parse(line))
    }
  }
  const expectedCaptured = DESIGN_CAPTURE_REQUIREMENTS.filter(({ source }) => source === 'app-review').length
  if (capturedEntries.length !== expectedCaptured) return
  const entries = [...capturedEntries, ...await externalWidgetEntries()]
    .sort((first, second) => first.id.localeCompare(second.id))
  const requiredIds = [...requirementsById.keys()].sort()
  expect(entries.map(({ id }) => id)).toEqual(requiredIds)
  expect(new Set(entries.map(designCaptureTupleKey)).size).toBe(entries.length)
  const manifest = {
    version: 2,
    captureBoundary: {
      mode: 'non-packaged-only',
      environmentGate: 'SOTTO_E2E=1',
      packagedRejectionProof: 'tests/unit/main/e2eBoundary.test.ts and scripts/verify-packaged-resources.mjs',
    },
    viewport: 'Sotto main BrowserWindow (1080x720 logical window); widget 248x88.',
    scalingMethod: 'Electron --force-device-scale-factor driven by Playwright at 100/125/150/200 percent; devicePixelRatio is asserted.',
    notes: [
      'The idle widget renders the resting click-to-dictate sliver; idle captures are recorded after a completed session returns to idle.',
      'Established Task 12 widget baselines are referenced in place; they are not duplicated.',
      'Every tuple records explicit normal or reduced motion; normal launches emulate no-preference and reduced launches are separately asserted.',
      "Application tuples carry the main window's resolved mode, dark (the Crossing default existing installs keep) or light; theme and System tuples name the choice in their state. The untouched widget follows the system scheme, emulated on its own window, so widget tuples keep light and dark.",
      'Width tuples narrow the main window to 760 logical pixels, below the shipped 820 minimum, to review the Phase 1 minimum width.',
      'Full Settings and Help surfaces include content outside the management scrollport, including every Settings section and Reset safely help.',
      'Capture launches disable GPU compositing to avoid Electron tile tearing; application layout and CSS rendering remain authoritative.',
      'Verification permits only negligible Windows raster variance: at most max(100, 0.05%) pixels and max(1000, 0.5% pixel-count) total channel delta.',
    ],
    count: entries.length,
    entries,
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  if (updateBaselines) {
    await mkdir(resolve(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, serialized, 'utf8')
  } else {
    expect(await readFile(manifestPath, 'utf8')).toBe(serialized)
  }
}

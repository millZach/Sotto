// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { allOwlPoses, poseKey } from '../../../src/main/tray/owl/poses.mjs'
import { MENU_BAR_OWL_BODIES, MENU_BAR_OWL_BODY_SWATCHES, MENU_BAR_OWL_EYES, MENU_BAR_OWL_EYES_SWATCHES } from '../../../src/shared/menuBarOwl'

const root = resolve(__dirname, '../../..')
const owlDir = join(root, 'resources/tray/owl')
const frameBytes = 27 * 22 * 4

interface Manifest {
  version: number
  width: number
  height: number
  frames: number
  poseKeys: string[]
  palettes: { body: string; eyes: string; file: string; bytes: number }[]
}

const manifest = JSON.parse(readFileSync(join(owlDir, 'manifest.json'), 'utf8')) as Manifest

describe('menu bar owl assets', () => {
  it('lists every pose poses.mjs can show, in frame order', () => {
    expect(manifest).toMatchObject({ version: 1, width: 27, height: 22, frames: allOwlPoses().length })
    expect(manifest.poseKeys).toEqual(allOwlPoses().map(poseKey))
  })

  it('has the nine palettes, bodies then eyes', () => {
    const expected = MENU_BAR_OWL_BODIES.flatMap(body => MENU_BAR_OWL_EYES.map(eyes => ({ body, eyes, file: `${body}-${eyes}.bin`, bytes: manifest.frames * frameBytes })))
    expect(manifest.palettes).toEqual(expected)
  })

  it.each(MENU_BAR_OWL_BODIES.flatMap(body => MENU_BAR_OWL_EYES.map(eyes => `${body}-${eyes}`)))('%s inflates to its frames, the rest frame drawn', key => {
    const entry = manifest.palettes.find(palette => palette.file === `${key}.bin`)
    const raw = inflateSync(readFileSync(join(owlDir, `${key}.bin`)))
    expect(raw.length).toBe(entry?.bytes)
    const rest = raw.subarray(0, frameBytes)
    let opaque = 0
    for (let i = 3; i < rest.length; i += 4) if (rest[i] === 255) opaque++
    expect(opaque).toBeGreaterThan(100)
  })

  it('stays under 1 MB', () => {
    const total = readdirSync(owlDir).reduce((sum, file) => sum + statSync(join(owlDir, file)).size, 0)
    expect(total).toBeLessThan(1024 * 1024)
  })

  it('draws in the colours the settings swatches show', () => {
    const source = readFileSync(join(root, 'scripts/lib/trayOwlDraw.mjs'), 'utf8')
    for (const body of MENU_BAR_OWL_BODIES) expect(source).toContain(`${body}: { b0: '${MENU_BAR_OWL_BODY_SWATCHES[body]}'`)
    for (const eyes of MENU_BAR_OWL_EYES) expect(source).toContain(`${eyes}: { c: '${MENU_BAR_OWL_EYES_SWATCHES[eyes]}'`)
  })
})

// Draws the menu bar owl's frames (ADR-0113) into resources/tray/owl: one deflated file of raw 27x22 RGBA frames per
// body x eyes palette, in allOwlPoses() order, and manifest.json. The drawing runs in a hidden window of the repo's own
// Electron (scripts/lib/trayOwlElectron.mjs), offline. Each run also draws the same poses through the approved prototype's
// own code and fails if any channel differs by more than 2.
//   node scripts/generate-tray-owl.mjs                 draw and write
//   node scripts/generate-tray-owl.mjs --sheets <dir>  also write slate-teal and ink-amber contact sheets there
//   node scripts/generate-tray-owl.mjs --check         draw nothing; check the committed files against the poses
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

import { allOwlPoses, OWL_HEIGHT, OWL_WIDTH, poseKey } from '../src/main/tray/owl/poses.mjs'
import { drawOwlFrame, TRAY_OWL_BODIES, TRAY_OWL_EYES } from './lib/trayOwlDraw.mjs'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'resources/tray/owl')
const prototype = join(root, 'docs/prototypes/menubar-owl-prototype.html')
const MAX_DIFF = 2
const frameBytes = OWL_WIDTH * OWL_HEIGHT * 4

const palettes = TRAY_OWL_BODIES.flatMap(body => TRAY_OWL_EYES.map(eyes => ({ body, eyes })))
const COMPARED = palettes
const SHEETS = [{ body: 'slate', eyes: 'teal' }, { body: 'ink', eyes: 'amber' }]
const name = ({ body, eyes }) => `${body}-${eyes}`

class Failure extends Error {}

// Thrown rather than exiting, so the temporary folder of a failed run is still removed.
function fail(message) {
  throw new Failure(message)
}

async function check() {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'))
  } catch {
    fail('resources/tray/owl/manifest.json is missing or not JSON; run `npm run tray:owl`')
  }
  const keys = allOwlPoses().map(poseKey)
  if (manifest.version !== 1 || manifest.width !== OWL_WIDTH || manifest.height !== OWL_HEIGHT) fail('manifest version or size is wrong')
  if (manifest.frames !== keys.length || JSON.stringify(manifest.poseKeys) !== JSON.stringify(keys)) fail('manifest poses differ from poses.mjs; run `npm run tray:owl`')
  if (JSON.stringify(manifest.palettes?.map(p => [p.body, p.eyes, p.file])) !== JSON.stringify(palettes.map(p => [p.body, p.eyes, `${name(p)}.bin`]))) fail('manifest palettes are wrong')
  for (const p of manifest.palettes) {
    if (p.bytes !== keys.length * frameBytes) fail(`${p.file}: manifest bytes ${p.bytes}, expected ${keys.length * frameBytes}`)
    let length
    try {
      length = inflateSync(await readFile(join(outDir, p.file))).length
    } catch {
      fail(`${p.file} is missing or does not inflate`)
    }
    if (length !== p.bytes) fail(`${p.file} inflates to ${length} bytes, expected ${p.bytes}`)
  }
  process.stdout.write(`tray owl: ${keys.length} frames x ${manifest.palettes.length} palettes match poses.mjs\n`)
}

function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity
  let max = 0
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
  return max
}

async function generate(sheetsDir) {
  const { default: electronPath } = await import('electron')
  const poses = allOwlPoses()
  const work = await mkdtemp(join(tmpdir(), 'sotto-tray-owl-'))
  try {
    const jobPath = join(work, 'job.json'), resultPath = join(work, 'result.json')
    const sheets = sheetsDir ? SHEETS.map(name) : []
    await writeFile(jobPath, JSON.stringify({ drawSource: drawOwlFrame.toString(), poses, palettes, sheets, prototypeUrl: pathToFileURL(prototype).href, comparePalettes: COMPARED }))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = spawnSync(electronPath, [join(import.meta.dirname, 'lib/trayOwlElectron.mjs'), jobPath, resultPath], { env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 120_000 })
    if (run.status !== 0) fail(`Electron did not finish: ${run.error?.message ?? run.status ?? run.signal}`)
    const result = JSON.parse(await readFile(resultPath, 'utf8'))

    const diffs = COMPARED.map(p => [name(p), maxDiff(Buffer.from(result.frames[name(p)], 'base64'), Buffer.from(result.prototype[name(p)], 'base64'))])
    const worst = Math.max(...diffs.map(([, diff]) => diff))
    const vsPrototype = `max channel difference from the prototype over ${poses.length} frames: ${diffs.map(([key, diff]) => `${key} ${diff}`).join(', ')}`
    if (worst > MAX_DIFF) fail(`frames differ from the prototype (${vsPrototype}; limit ${MAX_DIFF}); nothing written`)

    for (const p of palettes) {
      const length = Buffer.from(result.frames[name(p)], 'base64').length
      if (length !== poses.length * frameBytes) fail(`${name(p)}: drew ${length} bytes, expected ${poses.length * frameBytes}; nothing written`)
    }

    if (sheetsDir) await mkdir(sheetsDir, { recursive: true })
    await mkdir(outDir, { recursive: true })
    let total = 0
    const entries = []
    for (const p of palettes) {
      const raw = Buffer.from(result.frames[name(p)], 'base64')
      const file = `${name(p)}.bin`, packed = deflateSync(raw, { level: 9 })
      await writeFile(join(outDir, file), packed)
      total += packed.length
      entries.push({ body: p.body, eyes: p.eyes, file, bytes: raw.length })
    }
    const manifest = { version: 1, width: OWL_WIDTH, height: OWL_HEIGHT, frames: poses.length, poseKeys: poses.map(poseKey), palettes: entries }
    await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const [key, png] of Object.entries(result.png)) await writeFile(join(sheetsDir, `u1-contact-${key}.png`), Buffer.from(png, 'base64'))
    process.stdout.write(`tray owl: wrote ${poses.length} frames x ${palettes.length} palettes (${(total / 1000).toFixed(0)} KB) to resources/tray/owl; ${vsPrototype}\n`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
try {
  if (args.includes('--check')) await check()
  else {
    const at = args.indexOf('--sheets')
    await generate(at >= 0 ? resolve(args[at + 1] ?? fail('--sheets needs a directory')) : null)
  }
} catch (error) {
  if (!(error instanceof Failure)) throw error
  process.stderr.write(`tray owl: ${error.message}\n`)
  process.exitCode = 1
}

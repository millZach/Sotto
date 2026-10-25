// Draws the menu bar owl's frames (ADR-0114, ADR-0137) into resources/tray/owl: one deflated file of raw 18x18 RGBA frames
// per body x eyes palette, in allOwlPoses() order, and manifest.json. The drawing is plain pixels (scripts/lib/trayOwlDraw.mjs),
// so it runs in Node, offline.
//   node scripts/generate-tray-owl.mjs          draw and write
//   node scripts/generate-tray-owl.mjs --check  draw nothing; check the committed files against the poses
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { deflateSync, inflateSync } from 'node:zlib'

import { allOwlPoses, OWL_HEIGHT, OWL_WIDTH, poseKey } from '../src/main/tray/owl/poses.mjs'
import { drawOwlFrame, TRAY_OWL_BODIES, TRAY_OWL_EYES } from './lib/trayOwlDraw.mjs'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'resources/tray/owl')
const frameBytes = OWL_WIDTH * OWL_HEIGHT * 4

const palettes = TRAY_OWL_BODIES.flatMap(body => TRAY_OWL_EYES.map(eyes => ({ body, eyes })))
const name = ({ body, eyes }) => `${body}-${eyes}`

class Failure extends Error {}

// Thrown rather than exiting, so the message reads as the generator's own.
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

function generate() {
  const poses = allOwlPoses()
  const entries = []
  const packedFiles = palettes.map(p => {
    const raw = Buffer.concat(poses.map(pose => drawOwlFrame(pose, p.body, p.eyes)))
    if (raw.length !== poses.length * frameBytes) fail(`${name(p)}: drew ${raw.length} bytes, expected ${poses.length * frameBytes}; nothing written`)
    entries.push({ body: p.body, eyes: p.eyes, file: `${name(p)}.bin`, bytes: raw.length })
    return deflateSync(raw, { level: 9 })
  })
  return { poses, entries, packedFiles }
}

async function write() {
  const { poses, entries, packedFiles } = generate()
  await mkdir(outDir, { recursive: true })
  for (const [i, entry] of entries.entries()) await writeFile(join(outDir, entry.file), packedFiles[i])
  const manifest = { version: 1, width: OWL_WIDTH, height: OWL_HEIGHT, frames: poses.length, poseKeys: poses.map(poseKey), palettes: entries }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const total = packedFiles.reduce((sum, file) => sum + file.length, 0)
  process.stdout.write(`tray owl: wrote ${poses.length} frames x ${palettes.length} palettes (${(total / 1000).toFixed(0)} KB) to resources/tray/owl\n`)
}

const args = process.argv.slice(2)
try {
  if (args.includes('--check')) await check()
  else await write()
} catch (error) {
  if (!(error instanceof Failure)) throw error
  process.stderr.write(`tray owl: ${error.message}\n`)
  process.exitCode = 1
}

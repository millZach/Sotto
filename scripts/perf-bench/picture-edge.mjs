/**
 * How large a picture is sent to a phone's tile that asks at a longest edge (`thread-media-edge`, ADR-0170's November 10
 * amendment), made by the desktop's own maker (`ReducedPictures` over `mediaEdgeMaker` and Electron's image tools),
 * against the whole picture as every phone was sent it before. Run it under Electron, which alone has those tools:
 *
 *   npx electron scripts/perf-bench/picture-edge.mjs ~/.sotto/thread-media [sample] [edge]
 *
 * (under `xvfb-run -a` on a machine with no screen). It reads a seeded random sample of the folder's pictures, every one
 * when `sample` is 0, and the synthetic pictures the listener test makes, and prints sizes, counts and times only: never
 * a picture, a name or a path. Sizes are of the data URL as sent, base64 and all. It writes nothing but a bundle of the
 * two source files it runs, under `node_modules/.cache` so it finds sharp there, removed when it ends.
 */
import { app, nativeImage } from 'electron'
import { build } from 'esbuild'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [folder, sampleArg = '40', edgeArg = '640'] = process.argv.slice(2).filter(arg => !arg.startsWith('-') && !arg.endsWith('picture-edge.mjs'))
const sample = Number(sampleArg), edge = Number(edgeArg)

/** The kinds the thread media store keeps, by their own first bytes. */
function kind(head) {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
function seeded(seed) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32 } }
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0 }
const kb = bytes => Math.round(bytes / 100) / 10

async function main() {
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true })
  const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'sotto-picture-edge-'))
  try {
    const entry = join(scratch, 'entry.ts')
    const bundle = join(scratch, 'bundle.cjs')
    writeFileSync(entry, `export * from ${JSON.stringify(join(root, 'src/main/agents/mediaThumbnail.ts'))}\nexport * from ${JSON.stringify(join(root, 'tests/fixtures/syntheticPictures.ts'))}\n`)
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['electron', 'sharp'], logLevel: 'error', absWorkingDir: root, nodePaths: [join(root, 'node_modules')] })
    const made = createRequire(join(root, 'package.json'))(bundle)
    const pictures = new made.ReducedPictures(made.mediaEdgeMaker(url => nativeImage.createFromDataURL(url)), new made.KeptThumbnails())
    let key = 0
    /** One picture through the desktop's path: its whole data URL against what a tile at `edge` is sent, and the time it took. */
    const measure = async (mimeType, bytes) => {
      const whole = `data:${mimeType};base64,${bytes.toString('base64')}`
      const started = performance.now()
      const sent = await pictures.read(['bench', String(key++)], edge, async () => ({ dataUrl: whole }))
      return { mimeType, whole: whole.length, sent: sent.dataUrl.length, ms: performance.now() - started, kept: sent.dataUrl !== whole }
    }
    const synthetic = []
    for (const [name, mimeType, make] of [['screenshot', 'image/png', made.screenshotPng], ['photo', 'image/jpeg', made.photoJpeg], ['gif', 'image/gif', made.movingGif], ['see-through', 'image/png', made.seeThroughPng]]) {
      const row = await measure(mimeType, await make())
      synthetic.push({ picture: name, wholeKB: kb(row.whole), atEdgeKB: kb(row.sent), ratio: Math.round(row.whole / row.sent * 10) / 10 })
    }
    console.log(JSON.stringify({ benchmark: 'picture-edge', edge, synthetic }))
    if (!folder) return
    const files = []
    for (const name of readdirSync(folder, { recursive: true })) {
      const path = join(folder, String(name))
      if (!statSync(path).isFile()) continue
      const mimeType = kind(readFileSync(path).subarray(0, 12))
      if (mimeType) files.push({ path, mimeType })
    }
    const next = seeded(7)
    for (let index = files.length - 1; index > 0; index--) { const other = Math.floor(next() * (index + 1)); [files[index], files[other]] = [files[other], files[index]] }
    const rows = []
    for (const file of sample > 0 ? files.slice(0, sample) : files) rows.push(await measure(file.mimeType, readFileSync(file.path)))
    const types = {}
    for (const row of rows) types[row.mimeType] = (types[row.mimeType] ?? 0) + 1
    const whole = rows.map(row => row.whole), sent = rows.map(row => row.sent)
    console.log(JSON.stringify({ benchmark: 'picture-edge', edge, pictures: files.length, measured: rows.length, types,
      wholeMedianKB: kb(median(whole)), atEdgeMedianKB: kb(median(sent)), wholeTotalMB: Math.round(whole.reduce((a, b) => a + b, 0) / 1e5) / 10,
      atEdgeTotalMB: Math.round(sent.reduce((a, b) => a + b, 0) / 1e5) / 10, answeredWhole: rows.filter(row => !row.kept).length,
      atEdgeOver60KB: sent.filter(size => size > 60_000).length, makeMedianMs: Math.round(median(rows.map(row => row.ms)) * 10) / 10,
      makeMaxMs: Math.round(Math.max(...rows.map(row => row.ms)) * 10) / 10 }))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

app.whenReady().then(main).catch(error => { console.error(error instanceof Error ? error.message : 'failed'); process.exitCode = 1 }).finally(() => app.quit())

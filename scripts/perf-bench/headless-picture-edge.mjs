/**
 * How large a picture a headless host sends to a phone's tile that asks at a longest edge (`thread-media-edge`,
 * ADR-0202), made the way a headless host makes it: `ReducedPictures` over a `PictureMaker` running the built picture
 * worker in its own process, against the whole picture. It is `picture-edge.mjs`'s run for the desktop, with the host's
 * maker in place of Electron's, and runs under plain Node after the host is built:
 *
 *   npm run build:host
 *   node scripts/perf-bench/headless-picture-edge.mjs ~/.sotto/thread-media [sample] [edge]
 *
 * It reads a seeded random sample of the folder's pictures, every one when `sample` is 0, and prints sizes, counts and
 * times only: never a picture, a name or a path. Sizes are of the data URL as sent, base64 and all. A picture the worker
 * sends whole is counted by why, as far as the host can tell from outside the worker. It writes nothing but a bundle of
 * the source it runs, under `node_modules/.cache`, removed when it ends.
 */
import { build } from 'esbuild'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { clearInterval, setInterval } from 'node:timers'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [folder, sampleArg = '40', edgeArg = '640'] = process.argv.slice(2)
const sample = Number(sampleArg), edge = Number(edgeArg)
const worker = join(root, 'out', 'host', 'pictureWorker.js')

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

/** Why a picture the worker could have made a copy of went whole, from what the host can read of it. */
function wholeBecause(mimeType, bytes, made) {
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') return 'not PNG or JPEG'
  if (made.carriesCameraDetails(`data:${mimeType};base64,${bytes.subarray(0, 65_536).toString('base64')}`)) return 'camera details'
  if (mimeType === 'image/png') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (width * height > made.PICTURE_COPY_MAX_PIXELS) return 'past 4K'
    if (bytes[28] !== 0) return 'interlaced'
    if (bytes.includes(Buffer.from('iCCP', 'latin1'))) return 'colour profile'
    if (Math.max(width, height) <= edge) return 'already fits'
  } else if (bytes.includes(Buffer.from('ICC_PROFILE\0', 'latin1'))) return 'colour profile'
  return 'other (fits, unreadable, or no smaller)'
}

async function main() {
  if (!existsSync(worker)) throw Object.assign(new Error('no worker'), { code: 'RUN_BUILD_HOST_FIRST' })
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true })
  const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'sotto-headless-picture-edge-'))
  try {
    const entry = join(scratch, 'entry.ts'), bundle = join(scratch, 'bundle.cjs')
    writeFileSync(entry, ['src/main/agents/mediaThumbnail.ts', 'src/host/pictureMaker.ts', 'src/host/pictureCopy.ts']
      .map(path => `export * from ${JSON.stringify(join(root, path))}`).join('\n') + '\n')
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', absWorkingDir: root, nodePaths: [join(root, 'node_modules')] })
    const made = createRequire(join(root, 'package.json'))(bundle)
    const maker = new made.PictureMaker(worker)
    // The host never lets its worker keep it running, so this run holds itself open until it is done.
    const awake = setInterval(() => undefined, 1_000)
    const pictures = new made.ReducedPictures((dataUrl, at) => maker.reduce(dataUrl, at), new made.KeptThumbnails())
    try {
      const files = []
      for (const name of readdirSync(folder, { recursive: true })) {
        const path = join(folder, String(name))
        if (!statSync(path).isFile()) continue
        const mimeType = kind(readFileSync(path).subarray(0, 12))
        if (mimeType) files.push({ path, mimeType })
      }
      const next = seeded(7)
      for (let index = files.length - 1; index > 0; index--) { const other = Math.floor(next() * (index + 1)); [files[index], files[other]] = [files[other], files[index]] }
      const rows = [], whyWhole = {}
      let key = 0
      for (const file of sample > 0 ? files.slice(0, sample) : files) {
        const bytes = readFileSync(file.path), whole = `data:${file.mimeType};base64,${bytes.toString('base64')}`
        const started = performance.now()
        const sent = await pictures.read(['bench', String(key++)], edge, async () => ({ dataUrl: whole }))
        const row = { mimeType: file.mimeType, whole: whole.length, sent: sent.dataUrl.length, ms: performance.now() - started, kept: sent.dataUrl !== whole }
        if (!row.kept) { const because = wholeBecause(file.mimeType, bytes, made); whyWhole[because] = (whyWhole[because] ?? 0) + 1 }
        rows.push(row)
      }
      const types = {}
      for (const row of rows) types[row.mimeType] = (types[row.mimeType] ?? 0) + 1
      const whole = rows.map(row => row.whole), sent = rows.map(row => row.sent)
      console.log(JSON.stringify({ benchmark: 'headless-picture-edge', edge, pictures: files.length, measured: rows.length, types,
        wholeMedianKB: kb(median(whole)), atEdgeMedianKB: kb(median(sent)), wholeTotalMB: Math.round(whole.reduce((a, b) => a + b, 0) / 1e5) / 10,
        atEdgeTotalMB: Math.round(sent.reduce((a, b) => a + b, 0) / 1e5) / 10, answeredWhole: rows.filter(row => !row.kept).length, whyWhole,
        atEdgeOver60KB: sent.filter(size => size > 60_000).length, makeMedianMs: Math.round(median(rows.map(row => row.ms)) * 10) / 10,
        makeMaxMs: Math.round(Math.max(...rows.map(row => row.ms)) * 10) / 10, copiesFromWorker: maker.copies }))
    } finally { await maker.close(); clearInterval(awake) }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

// A failure is said by its kind only: a file system error's message carries the folder and a picture's name.
main().catch(error => { console.error(`The pictures could not be measured (${error instanceof Error && 'code' in error ? String(error.code) : 'no error code'}).`); process.exitCode = 1 })

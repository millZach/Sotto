import process from 'node:process'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'

const revision = '11e60a67f5529a1eefad5be5bc5990ef069f5205'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out = resolve(root, 'out')
const baseline = resolve(out, 'cpu-baseline')
const candidateMain = resolve(out, 'main')

async function treeHash(directory) {
  const hash = createHash('sha256')
  async function visit(path) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(path, item.name)
      if (item.isDirectory()) await visit(target)
      else if (item.isFile()) {
        hash.update(relative(directory, target).replaceAll('\\', '/'))
        hash.update(await readFile(target))
      } else throw new Error(`Unexpected build output entry: ${target}`)
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

function baselineSource() {
  const cache = new Map()
  return {
    name: 'sotto-fixed-revision-main-source', enforce: 'pre',
    load(id) {
      const clean = id.split('?')[0]
      const path = relative(root, clean).replaceAll('\\', '/')
      if (!/^(src\/main|src\/shared)\/.+\.(?:[cm]?[jt]sx?|json)$/u.test(path)) return null
      if (!cache.has(path)) {
        try {
          cache.set(path, execFileSync('git', ['show', `${revision}:${path}`], {
            cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
          }))
        } catch (error) { throw new Error(`Baseline source unavailable: ${path}`, { cause: error }) }
      }
      return cache.get(path)
    },
  }
}

async function replaceOwnedCopy(name) {
  const target = resolve(baseline, name)
  if (target !== resolve(out, 'cpu-baseline', name)) throw new Error('Refusing unexpected output path')
  await rm(target, { recursive: true, force: true })
  await cp(resolve(out, name), target, { recursive: true })
}

process.chdir(root)
execFileSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: root })
for (const name of ['main', 'preload', 'renderer']) {
  if (!(await stat(resolve(out, name))).isDirectory()) throw new Error(`Missing candidate output: ${name}`)
}
const before = await treeHash(candidateMain)
const resolved = await resolveConfig({ configFile: resolve(root, 'electron.vite.config.ts') }, 'build', 'production')
const main = resolved.config?.main
if (!main?.plugins) throw new Error('Electron main build config did not resolve')
if (!main.plugins.some(plugin => plugin.name === 'sotto-headless-host')) throw new Error('Headless host plugin was not found')
main.plugins = [baselineSource(), ...main.plugins.filter(plugin => plugin.name !== 'sotto-headless-host')]
main.build = { ...main.build, outDir: resolve(baseline, 'main'), emptyOutDir: true }
await mkdir(baseline, { recursive: true })
await build(main)
await replaceOwnedCopy('preload')
await replaceOwnedCopy('renderer')
for (const name of ['preload', 'renderer']) {
  if (await treeHash(resolve(out, name)) !== await treeHash(resolve(baseline, name))) throw new Error(`Baseline ${name} copy differs from candidate`)
}
const after = await treeHash(candidateMain)
if (before !== after) throw new Error(`Candidate main build changed: ${before} -> ${after}`)
if (!(await stat(resolve(baseline, 'main/index.js')).catch(() => null))?.isFile()) throw new Error('Baseline main bundle missing')
const bundle = await readFile(resolve(baseline, 'main/index.js'), 'utf8')
if (bundle.includes('activitySnapshots') || bundle.includes('subscribeActivitySnapshots') || bundle.includes('cloneActivitySnapshot')) throw new Error('Candidate activity subscription code entered baseline bundle')
if (!bundle.includes('this.dependencies.host.subscribe(')) throw new Error('Baseline coordinator subscription marker missing')
console.log(JSON.stringify({ revision, output: relative(root, baseline), candidateMainSha256: after,
  baselineMainBytes: Buffer.byteLength(bundle), baselineControlMarker: true }, null, 2))

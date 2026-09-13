// Bounded, owned Electron probe; accepts an existing runtime, never downloads an installer.
import { build } from 'esbuild'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import { createRequire } from 'node:module'
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createPackageWithOptions } from '@electron/asar'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, 'artifacts/phase3-tools')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const executable = process.argv[2] || require('electron')
await build({ entryPoints: [join(root, 'scripts/phase3-tools/probe.ts')], outfile: join(output, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node-pty'] })
await build({ entryPoints: [join(root, 'src/preload/index.ts')], outfile: join(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })

async function run(entry, name, extraEnv = {}) {
  const env = { ...process.env, SOTTO_TOOLS_EVIDENCE: join(output, `${name}.json`), SOTTO_TOOLS_PRELOAD: join(output, 'preload.cjs'), ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', data => { logs = (logs + data).slice(-100000); process.stdout.write(data) })
  child.stderr.on('data', data => { logs = (logs + data).slice(-100000); process.stderr.write(data) })
  const timeout = setTimeout(() => child.kill(), 90000)
  const code = await new Promise((resolveCode, reject) => { child.on('error', reject); child.on('exit', resolveCode) })
  clearTimeout(timeout)
  await writeFile(join(output, `${name}.log`), logs)
  const evidence = JSON.parse(await readFile(env.SOTTO_TOOLS_EVIDENCE, 'utf8'))
  const owned = resolve(evidence.ownedDirectory)
  if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('sotto-tools-electron-')) throw new Error('Invalid probe cleanup path')
  await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  if (code !== 0) throw new Error(`${name} failed: ${code}`)
  if (!evidence.ok) throw new Error(`${name} evidence reports failure`)
}
await run(join(output, 'probe.cjs'), 'native')
// Verify node-pty helpers/native files from the same ASAR + unpacked layout used by electron-builder.
const stage = join(output, 'stage')
await mkdir(join(stage, 'node_modules'), { recursive: true })
await cp(join(root, 'node_modules/node-pty'), join(stage, 'node_modules/node-pty'), { recursive: true })
await cp(join(output, 'probe.cjs'), join(stage, 'probe.cjs'))
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'sotto-owned-pty-packaging-probe', main: 'probe.cjs' }))
const asar = join(output, 'probe.asar')
await createPackageWithOptions(stage, asar, { unpackDir: 'node_modules/node-pty' })
await run(asar, 'asar', { SOTTO_TOOLS_PTY_ONLY: '1' })

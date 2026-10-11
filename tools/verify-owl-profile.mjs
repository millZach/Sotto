// node tools/verify-owl-profile.mjs: Owl to stable (gate off) to Owl through this checkout's real stores.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-profile-'))
if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-profile-')) throw new Error('Unexpected probe directory.')
const entry = join(root, 'tools', `.owl-profile-${randomUUID()}.ts`)
try {
  await writeFile(entry, `import { owlProfileRoundTrip } from '../tests/fixtures/owlProfileRoundTrip'\nprocess.stdout.write(JSON.stringify(await owlProfileRoundTrip(process.argv[2])))\n`)
  await build({ root, configFile: false, logLevel: 'error', ssr: { noExternal: true }, build: { ssr: entry, target: 'node24', outDir: join(temporary, 'out'), minify: false,
    rollupOptions: { external: ['node-pty'], output: { entryFileNames: 'probe.mjs', format: 'es' } } } })
  const result = JSON.parse(execFileSync(process.execPath, [join(temporary, 'out/probe.mjs'), join(temporary, 'profile')], { encoding: 'utf8', timeout: 120_000, windowsHide: true }))
  await mkdir(join(root, 'release'), { recursive: true })
  await writeFile(join(root, 'release/owl-profile-compatibility.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ preserved: result.preserved, threads: result.owl.threads.length, stableVisibleThreads: result.stable.loaded.threads.length,
    messages: result.owl.messages.length, watcherCapacity: result.stable.settings.watcherInFlightLimit, corruptBackups: result.stable.corruptBackups }, null, 2) + '\n')
} finally {
  await rm(entry, { force: true })
  await rm(temporary, { recursive: true, force: true })
}

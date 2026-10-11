import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { finalizeDesignCaptures } from '../tests/e2e/support/designCaptureManifest.mjs'

const update = process.argv.includes('--update')
const cli = resolve(process.cwd(), 'node_modules/@playwright/test/cli.js')
const specs = [
  'tests/e2e/design-capture-pages.spec.ts',
  'tests/e2e/design-capture-threads.spec.ts',
  'tests/e2e/design-capture-appearance.spec.ts',
  'tests/e2e/design-capture-voice-widget.spec.ts',
  'tests/e2e/design-capture-scaling.spec.ts',
]
const fragmentsRoot = await mkdtemp(join(tmpdir(), 'sotto-design-captures-'))
// Help and Settings show the running version. The captures start the app from an entry whose manifest pins the
// version the committed baselines show, the way the Owl specs set an Owl version, so a release bump changes no
// capture. Its name keeps any default path Electron derives from it away from Sotto's own data folder.
const DESIGN_CAPTURE_VERSION = '0.1.36'
const entryRoot = await mkdtemp(join(tmpdir(), 'sotto-design-entry-'))
await writeFile(join(entryRoot, 'package.json'), `${JSON.stringify({
  name: 'sotto-design-capture', version: DESIGN_CAPTURE_VERSION, main: resolve(process.cwd(), 'out/main/index.js'),
}, null, 2)}\n`, 'utf8')

try {
  const child = spawn(process.execPath, [cli, 'test', ...specs, '--workers=1'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // The design baselines were captured in America/Los_Angeles with the en-US
      // locale; designCaptureProfile pins the same zone and locale on the Electron
      // windows so time labels never depend on the machine.
      TZ: 'America/Los_Angeles',
      SOTTO_DESIGN_CAPTURE: '1',
      SOTTO_UPDATE_DESIGN_BASELINES: update ? '1' : '0',
      SOTTO_DESIGN_CAPTURE_FRAGMENTS: fragmentsRoot,
      SOTTO_E2E_MAIN_ENTRY: entryRoot,
    },
    stdio: 'inherit',
    windowsHide: true,
  })
  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Design capture could not start'}\n`)
      resolveResult({ code: 1, signal: null, started: false })
    })
    child.once('exit', (code, signal) => resolveResult({ code, signal, started: true }))
  })
  if (result.signal !== null) {
    process.stderr.write(`Design capture stopped by ${result.signal}\n`)
    process.exitCode = 1
  } else {
    // Finalize once after every spec/worker has flushed its fragment, including
    // partial failed runs; the existing missing-capture return remains intact.
    if (result.started) await finalizeDesignCaptures(fragmentsRoot, update)
    process.exitCode = result.code ?? 1
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Design capture could not finish'}\n`)
  process.exitCode = 1
} finally {
  await rm(fragmentsRoot, { recursive: true, force: true })
  await rm(entryRoot, { recursive: true, force: true })
}

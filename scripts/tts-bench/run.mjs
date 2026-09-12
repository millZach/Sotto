/* global console, process, URL */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '../..')
mkdirSync(join(root, 'artifacts/tts-bench'), { recursive: true })
require('esbuild').buildSync({ entryPoints: [join(root, 'src/main/agents/grokSpeech.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'artifacts/tts-bench/grok-service.cjs') })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [join(here, 'main.cjs'), ...process.argv.slice(2)],
  { cwd: root, env, windowsHide: true, stdio: 'inherit' })
child.on('error', () => { console.error('Could not launch benchmark Electron process.'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })

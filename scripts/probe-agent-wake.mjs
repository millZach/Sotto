import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import console from 'node:console'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1]
if (!process.argv.includes('--model-directory') || !process.argv.includes('--fixtures-directory')) {
  throw new Error('Usage: node scripts/probe-agent-wake.mjs --model-directory <supplied local model> --fixtures-directory <local WAV folder>')
}
const modelDirectory = resolve(value('--model-directory'))
const fixturesDirectory = resolve(value('--fixtures-directory'))
const scratch = await mkdtemp(join(tmpdir(), 'sotto-wake-probe-'))
let service
try {
  const source = await readFile(join(root, 'src/main/agents/wake.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const modulePath = join(scratch, 'wake.cjs')
  await writeFile(modulePath, compiled)
  const { AgentWakeService } = require(modulePath)
  const sherpa = require('sherpa-onnx')
  service = new AgentWakeService(join(root, 'node_modules/sherpa-onnx'), join(root, 'out/main/wakeWorker.js'))
  const started = performance.now()
  await service.prepare(modelDirectory)
  console.log(JSON.stringify({ preparedMs: Math.round(performance.now() - started), modelDirectory }))
  const files = (await readdir(fixturesDirectory)).filter(name => name.endsWith('.wav')).sort()
  for (const name of files) {
    const wave = sherpa.readWave(join(fixturesDirectory, name))
    if (wave.sampleRate !== 16_000 || wave.samples.length > 132_000) continue
    const start = performance.now()
    const result = await service.detect(wave.samples)
    console.log(JSON.stringify({ fixture: name, ...result, milliseconds: Math.round(performance.now() - start) }))
  }
  for (const [fixture, mode] of [['silence', 0], ['synthetic-low-noise', 1], ['synthetic-440hz-tone', 2]]) {
    let seed = 173
    const audio = new Float32Array(16_000 * 8)
    for (let i = 0; i < audio.length; ++i) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      audio[i] = mode === 0 ? 0 : mode === 1 ? (seed / 4294967296 * 2 - 1) * 0.01 : Math.sin(i / 16000 * Math.PI * 880) * 0.05
    }
    console.log(JSON.stringify({ fixture, ...await service.detect(audio) }))
  }
} finally {
  service?.dispose()
  if (dirname(scratch) === resolve(tmpdir()) && basename(scratch).startsWith('sotto-wake-probe-')) await rm(scratch, { recursive: true, force: true })
}

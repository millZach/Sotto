// Inference timing harness for Sotto dictation latency.
// Replicates the app's transcription worker stack (transformers.js web build,
// ORT WASM runtime, bundled q8 whisper models, 4 threads) inside Playwright
// Chromium with COOP/COEP headers so SharedArrayBuffer threading matches the app.
//
// Usage:
//   node scripts/perf-bench/bench-inference.mjs [options]
//
// Options:
//   --device wasm|webgpu   inference device (default wasm)
//   --runtime app|full     app = resources/runtime (what the package ships),
//                          full = onnxruntime-web/dist incl. jsep/webgpu builds
//   --clip tiny|short|long|both   which fixture(s) to transcribe (default both);
//                          comma-separated names also work, e.g. --clip tiny,technical
//   --fixtures-dir <path>  directory holding speech-<clip>.wav (default ./fixtures)
//   --runs N               transcribe repetitions per clip (default 3)
//   --threads N            override the app's min(4, cores-1) thread count
//   --model <repo>         model repository (default Xenova/whisper-base)
//   --remote               allow fetching the model from huggingface.co
//   --headed               run a visible browser (required for WebGPU)
//
// Fixtures: run scripts/perf-bench/gen-fixtures.ps1 once to create fixtures/*.wav.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(BENCH_DIR, '..', '..')

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const device = argValue('device', 'wasm')
const runtimeMode = argValue('runtime', device === 'webgpu' ? 'full' : 'app')
const clipArg = argValue('clip', 'both')
const runs = Number(argValue('runs', '3'))
const threadsOverride = argValue('threads', null)
const headed = args.includes('--headed')
const model = argValue('model', null)
const remote = args.includes('--remote')

const RUNTIME_DIR =
  runtimeMode === 'app'
    ? path.join(ROOT, 'resources', 'runtime')
    : path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.onnx': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.html': 'text/html',
}

const routes = [
  { prefix: '/dist/', dir: path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist') },
  { prefix: '/runtime/', dir: RUNTIME_DIR },
  { prefix: '/ort/', dir: path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist') },
  { prefix: '/ortcommon/', dir: path.join(ROOT, 'node_modules', 'onnxruntime-common', 'dist', 'esm') },
  { prefix: '/models/', dir: path.resolve(argValue('models-dir', path.join(ROOT, 'resources', 'models'))) },
  { prefix: '/bench/', dir: path.resolve(argValue('fixtures-dir', path.join(BENCH_DIR, 'fixtures'))) },
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = routes.find((r) => url.pathname.startsWith(r.prefix))
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(path.join(BENCH_DIR, 'bench-page.html'))
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html' })
    res.end(html)
    return
  }
  if (!route) {
    res.writeHead(404, headers)
    res.end('not found')
    return
  }
  const rel = decodeURIComponent(url.pathname.slice(route.prefix.length))
  const filePath = path.join(route.dir, rel)
  if (!filePath.startsWith(route.dir) || !existsSync(filePath)) {
    res.writeHead(404, headers)
    res.end('not found: ' + url.pathname)
    return
  }
  const body = await readFile(filePath)
  res.writeHead(200, {
    ...headers,
    'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
  })
  res.end(body)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch({
  headless: !headed,
  args: ['--enable-unsafe-webgpu', '--enable-features=SharedArrayBuffer'],
})
const page = await browser.newPage()
page.on('console', (msg) => {
  const text = msg.text()
  if (text.startsWith('[bench]') || msg.type() === 'error') console.log(msg.type(), text)
})
page.on('pageerror', (err) => console.log('pageerror:', err.message))
if (args.includes('--log-requests')) {
  page.on('request', (request) => console.log('[request]', request.url()))
}
await page.goto(base + '/')
await page.waitForFunction(() => typeof window.runBench === 'function', null, { timeout: 30000 })

const clips = clipArg === 'both' ? ['short', 'long'] : clipArg.split(',')
const result = await page.evaluate(
  async ({ device, clips, runs, threadsOverride, model, remote }) => {
    return await window.runBench({ device, clips, runs, threadsOverride, model, remote })
  },
  {
    device,
    clips,
    runs,
    threadsOverride: threadsOverride === null ? null : Number(threadsOverride),
    model,
    remote,
  },
)

console.log(JSON.stringify(result, null, 2))
await browser.close()
server.close()

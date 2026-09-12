import { copyFileSync } from 'node:fs'
import { build as viteBuild } from 'vite'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, 'artifacts/voice-perf/build')
buildSync({ entryPoints: [resolve(root, 'scripts/voice-perf/main.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: resolve(output, 'main.cjs') })
buildSync({ entryPoints: [resolve(root, 'scripts/voice-perf/speechMain.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: resolve(output, 'speech-main.cjs') })
await viteBuild({ configFile: false, root, base: './', build: { outDir: resolve(output, 'renderer'), emptyOutDir: true, rollupOptions: { input: [resolve(root, 'scripts/voice-perf/capture.html'), resolve(root, 'scripts/voice-perf/speech.html')] } } })

copyFileSync(resolve(root, 'src/renderer/public/audio-capture-worklet.js'), resolve(output, 'renderer/scripts/voice-perf/audio-capture-worklet.js'))

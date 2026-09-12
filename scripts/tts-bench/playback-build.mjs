/* global console */
import { build as viteBuild } from 'vite'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, 'artifacts/tts-bench/playback-build')
for (const name of ['grokSpeech', 'kokoroSpeech', 'speechModels']) buildSync({ entryPoints: [resolve(root, `src/main/agents/${name}.ts`)], bundle: true, platform: 'node', format: 'cjs', outfile: resolve(output, `${name}.cjs`) })
buildSync({ entryPoints: [resolve(root, 'src/main/models/modelProtocol.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: resolve(output, 'modelProtocol.cjs') })
await viteBuild({ configFile: false, root, base: './', build: { outDir: resolve(output, 'renderer'), emptyOutDir: true, rollupOptions: { input: resolve(root, 'scripts/tts-bench/playback.html') } } })
console.log('Playback harness built from production synthesis and player modules.')

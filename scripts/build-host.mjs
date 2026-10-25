import { isBuiltin } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')

export async function buildHost(outDir = resolve(root, process.env.SOTTO_HOST_OUT_DIR || 'out/host'), { version } = {}) {
  if (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-owl\.[1-9]\d{7}\.[1-9]\d*)?$/u.test(version)) throw new Error('Host packaging needs a stable or Owl version.')
  await build({
    root,
    configFile: false,
    plugins: [...(version === undefined ? [] : [{
      name: 'sotto-host-package-version',
      enforce: 'pre',
      async load(id) {
        if (resolve(id.split('?')[0]) !== resolve(root, 'package.json')) return null
        const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
        return JSON.stringify({ ...pkg, version })
      },
    }]), {
      name: 'sotto-host-inventory',
      generateBundle(_options, bundle) {
        const imports = new Set(), dynamicImports = new Set(), packages = new Set()
        const files = new Set(Object.keys(bundle))
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue
          for (const id of output.imports) if (!files.has(id)) imports.add(id)
          for (const id of output.dynamicImports) if (!files.has(id)) dynamicImports.add(id)
          for (const id of Object.keys(output.modules)) {
            const parts = id.replaceAll('\\', '/').split('/node_modules/').at(-1)
            if (parts === id.replaceAll('\\', '/')) continue
            packages.add(parts.startsWith('@') ? parts.split('/').slice(0, 2).join('/') : parts.split('/')[0])
          }
        }
        this.emitFile({ type: 'asset', fileName: 'external-dependencies.json', source: JSON.stringify({ version: 1, scope: 'host', imports: [...imports].sort(), dynamicImports: [...dynamicImports].sort() }, null, 2) + '\n' })
        this.emitFile({ type: 'asset', fileName: 'bundled-dependencies.json', source: JSON.stringify({ version: 1, packages: [...packages].sort() }, null, 2) + '\n' })
      },
    }],
    build: {
      // The host launches Git off its own thread too, from the worker file beside its index.js (`gitLauncher.ts`), and
      // checkpoints its thread store on another (`walCheckpointer.ts`).
      ssr: true, target: 'node24', outDir, emptyOutDir: true, minify: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/host/index.ts'), gitLauncherWorker: resolve(root, 'src/main/agents/gitLauncherWorker.ts'),
          walCheckpointWorker: resolve(root, 'src/main/storage/walCheckpointWorker.ts') },
        external: id => isBuiltin(id) || id === 'zod' || id === 'node-pty',
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildHost()

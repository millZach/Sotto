import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { build } from 'vite'

export async function buildHost(outDir = resolve('out/host')) {
  await build({
    configFile: false,
    plugins: [{
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
      ssr: resolve('src/host/index.ts'), target: 'node24', outDir, emptyOutDir: true, minify: false,
      rollupOptions: {
        external: id => isBuiltin(id) || id === 'zod' || id === 'node-pty',
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildHost()

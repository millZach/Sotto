import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'vite'

/** Borrowed installation path: each journey owns its host process, environment and profile. */
export async function buildSshHost(install: string): Promise<void> {
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
}

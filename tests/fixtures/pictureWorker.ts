/**
 * The headless host's picture worker (`src/host/pictureWorker.ts`, ADR-0202) compiled as `scripts/build-host.mjs` compiles
 * it: one `.cjs` file with jpeg-js and pngjs inside it and Node's builtins outside. The test runner has no built file
 * beside the host's source, so a host under test makes no copies unless a test hands it a maker over this one.
 */
import { isBuiltin } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { HOST_BUNDLED_PACKAGES } from '../../scripts/release-external-dependencies.mjs'

export async function builtPictureWorker(): Promise<{ readonly path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-picture-worker-'))
  await build({
    root: resolve('.'), configFile: false, logLevel: 'silent',
    ssr: { noExternal: [...HOST_BUNDLED_PACKAGES] },
    build: {
      ssr: true, target: 'node24', outDir: root, emptyOutDir: false, minify: false, copyPublicDir: false,
      rollupOptions: {
        input: { pictureWorker: resolve('src/host/pictureWorker.ts') },
        external: id => isBuiltin(id),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  })
  return {
    path: join(root, 'pictureWorker.cjs'),
    dispose: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-picture-worker-')) throw new Error('Unexpected fixture directory')
      await rm(root, { recursive: true, force: true })
    },
  }
}

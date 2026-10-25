import { isBuiltin } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { lingui } from '@lingui/vite-plugin'
import { build, type Plugin } from 'vite'

export interface DesktopMainBundleOptions {
  /** `cjs` for a child started with `node file.cjs`, `es` for an ES module. */
  readonly format?: 'cjs' | 'es'
  /** Modules left out of the bundle beside Node's builtins, such as `electron` for a bundle Electron runs. */
  readonly external?: readonly string[]
  /** The entry's source, when it has no file of its own: read as if it were the file `entry` names. */
  readonly contents?: string
  /** Plugins that run first, such as one that loads `src/` as of another commit. */
  readonly plugins?: readonly Plugin[]
  /** Code put first in the bundle. */
  readonly banner?: string
}

/**
 * Bundles a child process that runs main's own code the way electron.vite.config.ts builds main: with Lingui's macros
 * turned into message lookups and main's interface catalogs compiled in (ADR-0123). Main's modules write the words they
 * show as macros, which fail outside that build, so a test that runs them in a child of its own builds the child here.
 * The entry imports src/main/interfaceLanguage.ts, as main does, so English is active before anything says a word.
 *
 * Only for code that runs in main. The headless host and the processes main starts (the dictation client, the Git
 * launcher, the WAL worker) have no interface language and are bundled without this.
 */
export async function bundleDesktopMain(entry: string, outfile: string, options: DesktopMainBundleOptions = {}): Promise<void> {
  const absolute = resolve(entry)
  const virtual: Plugin[] = options.contents === undefined ? [] : [{
    name: 'sotto-bundle-entry', enforce: 'pre',
    resolveId: id => resolve(id) === absolute ? absolute : null,
    load: id => resolve(id) === absolute ? options.contents! : null,
  }]
  // The native modules main keeps out of its own bundle stay out of this one, loaded where they are installed.
  const external = new Set(['node-pty', 'sherpa-onnx-node', ...options.external ?? []])
  await build({
    configFile: false, logLevel: 'silent',
    plugins: [...virtual, ...(options.plugins ?? []), lingui({ macroTransform: true, failOnCompileError: true })],
    ssr: { noExternal: true },
    build: {
      ssr: absolute, target: 'node24', outDir: dirname(outfile), emptyOutDir: false, minify: false,
      rollupOptions: {
        external: id => isBuiltin(id) || external.has(id),
        // One file: another language's catalogs, which main reads when they are first shown, come along inside it.
        output: { format: options.format ?? 'cjs', entryFileNames: basename(outfile), inlineDynamicImports: true, ...(options.banner ? { banner: options.banner } : {}) },
      },
    },
  })
}

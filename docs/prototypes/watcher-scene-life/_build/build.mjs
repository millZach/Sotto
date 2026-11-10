// PROTOTYPE, throwaway. Bundles the prototype's scene (proto/index.ts) with Sotto's own night scene source, unchanged,
// into ../scene.js. Run: node docs/prototypes/watcher-scene-life/_build/build.mjs
// esbuild comes from this checkout's node_modules, or from the main checkout's when this is a worktree without one.
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const watcher = path.join(root, 'src/renderer/src/watcher')

let esbuild
try { esbuild = createRequire(import.meta.url)('esbuild') } catch {
  const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: here }).toString().trim()
  esbuild = createRequire(path.join(path.dirname(common), 'package.json'))('esbuild')
}

await esbuild.build({
  entryPoints: [path.join(here, 'proto/index.ts')],
  outfile: path.join(here, '../scene.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  charset: 'utf8',
  logLevel: 'info',
  plugins: [{
    name: 'sotto-scene',
    setup(build) {
      // `@w/x` is the real scene's module x.
      build.onResolve({ filter: /^@w\// }, args => ({ path: path.join(watcher, args.path.slice(3) + '.ts') }))
      // The real painter draws thread owls with owlFamily's glyphs; here it gets the prototype's, which add poses.
      build.onResolve({ filter: /^\.\/owlFamily$/ }, args => args.importer.endsWith('nightScenePainter.ts') ? { path: path.join(here, 'proto/owlFamilyLife.ts') } : undefined)
    },
  }],
})

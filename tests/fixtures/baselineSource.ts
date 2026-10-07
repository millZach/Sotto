import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import type { Plugin } from 'esbuild'

/**
 * An esbuild plugin that bundles `src/` as it was at `commit`, read from Git, and everything else (the benchmark's
 * own fixtures) from the working tree: a benchmark's "before" built beside its "after" in one run.
 */
export function sourceAt(commit: string): Plugin {
  return {
    name: 'fixed-baseline',
    setup(builder) {
      builder.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
        const path = relative(resolve('.'), args.path).replaceAll('\\', '/')
        if (!path.startsWith('src/')) return undefined
        return { contents: execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' }), loader: path.endsWith('x') ? 'tsx' : 'ts' }
      })
    },
  }
}

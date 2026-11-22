import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Resolves a worker script emitted beside the main or headless host bundle (`out/main/` or `out/host/`).
 *
 * When electron-vite builds multiple main entries (`index.ts` and `engineProcess.ts`), Rollup extracts shared
 * modules into `out/main/chunks/<name>-<hash>.js`. Inside a chunk, `__dirname` is `out/main/chunks` rather than
 * `out/main`, so `join(__dirname, '<worker>.js')` misses the built worker and silently falls back to running on
 * the calling thread. Checking the direct sibling first and stepping out of `chunks/` keeps both entry-resident
 * bundles (`out/main/`, `out/host/`) and Rollup-chunked modules (`out/main/chunks/`, `out/host/chunks/`) pointing
 * at the built worker, while leaving source runs under Vitest (`src/...`) unresolved so tests keep their
 * in-process defaults.
 */
export function resolveBuiltWorkerPath(
  fileName: string,
  baseDir: string = __dirname,
  exists: (path: string) => boolean = existsSync,
): string {
  const direct = join(baseDir, fileName)
  if (exists(direct)) return direct
  if (basename(baseDir) === 'chunks') return join(baseDir, '..', fileName)
  return direct
}

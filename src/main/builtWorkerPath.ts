import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Maps a path inside an `.asar` archive (e.g. `.../resources/app.asar/out/main/pictureWorker.js`) to its
 * unpacked sibling (`.../resources/app.asar.unpacked/out/main/pictureWorker.js`), or `undefined` when the
 * path is not inside an `.asar` archive (including paths already under `.asar.unpacked`).
 */
export function asarUnpackedWorkerPath(filePath: string): string | undefined {
  const unpacked = filePath.replace(/\.asar([/\\])(?!.*\.asar[/\\])/u, '.asar.unpacked$1')
  return unpacked === filePath ? undefined : unpacked
}

/**
 * Resolves a worker script emitted beside the main or headless host bundle (`out/main/` or `out/host/`).
 *
 * When electron-vite builds multiple main entries (`index.ts` and `engineProcess.ts`), Rollup extracts shared
 * modules into `out/main/chunks/<name>-<hash>.js`. Inside a chunk, `__dirname` is `out/main/chunks` rather than
 * `out/main`, so `join(__dirname, '<worker>.js')` misses the built worker and silently falls back to running on
 * the calling thread. Checking the direct sibling first and stepping out of `chunks/` keeps both entry-resident
 * bundles (`out/main/`, `out/host/`) and Rollup-chunked modules (`out/main/chunks/`, `out/host/chunks/`) pointing
 * at the built worker, while preferring `.asar.unpacked` when a worker (such as `pictureWorker.js`, launched via
 * `child_process.fork`) is unpacked from `app.asar`. Source runs under Vitest (`src/...`) stay unresolved so
 * tests keep their in-process defaults.
 */
export function resolveBuiltWorkerPath(
  fileName: string,
  baseDir: string = __dirname,
  exists: (path: string) => boolean = existsSync,
): string {
  const direct = join(baseDir, fileName)
  const directUnpacked = asarUnpackedWorkerPath(direct)
  if (directUnpacked && exists(directUnpacked)) return directUnpacked
  if (exists(direct)) return direct
  if (basename(baseDir) === 'chunks') {
    const sibling = join(baseDir, '..', fileName)
    const siblingUnpacked = asarUnpackedWorkerPath(sibling)
    if (siblingUnpacked && exists(siblingUnpacked)) return siblingUnpacked
    return sibling
  }
  return direct
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ReleaseTrack } from '../../../src/shared/releaseTrack'

export const OWL_E2E_VERSION = '0.1.37-owl.20261012.1'

async function removeEntry(entry: string): Promise<void> {
  const target = resolve(entry)
  if (dirname(target) !== resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()), 'sotto-owl-entry-'))) throw new Error('Unexpected Owl fixture folder')
  await rm(target, { recursive: true, force: true })
}

/** Exercise Electron's real version-derived track without changing the repository manifests. */
export async function onReleaseTrack(track: ReleaseTrack, run: () => Promise<void>): Promise<void> {
  // Every variable that can move a launch between tracks, kept exactly (absent stays absent) and put back afterwards.
  const owned = ['SOTTO_E2E_MAIN_ENTRY', 'SOTTO_WATCHER_ENABLED', 'SOTTO_OWL_FEATURES'] as const
  const before = new Map(owned.map(name => [name, process.env[name]]))
  let entry: string | undefined
  try {
    for (const name of owned) delete process.env[name]
    if (track === 'owl') {
      entry = await mkdtemp(join(tmpdir(), 'sotto-owl-entry-'))
      await writeFile(join(entry, 'package.json'), `${JSON.stringify({ name: 'sotto-owl-e2e', version: OWL_E2E_VERSION,
        main: resolve('out/main/index.js') })}\n`, 'utf8')
      process.env.SOTTO_E2E_MAIN_ENTRY = entry
    }
    await run()
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (entry) await removeEntry(entry)
  }
}

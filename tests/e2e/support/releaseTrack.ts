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
  const before = { entry: process.env.SOTTO_E2E_MAIN_ENTRY, gate: process.env.SOTTO_WATCHER_ENABLED, features: process.env.SOTTO_OWL_FEATURES }
  let entry: string | undefined
  try {
    delete process.env.SOTTO_E2E_MAIN_ENTRY
    delete process.env.SOTTO_WATCHER_ENABLED
    delete process.env.SOTTO_OWL_FEATURES
    if (track === 'owl') {
      entry = await mkdtemp(join(tmpdir(), 'sotto-owl-entry-'))
      await writeFile(join(entry, 'package.json'), `${JSON.stringify({ name: 'sotto-owl-e2e', version: OWL_E2E_VERSION,
        main: resolve('out/main/index.js') })}\n`, 'utf8')
      process.env.SOTTO_E2E_MAIN_ENTRY = entry
    }
    await run()
  } finally {
    if (before.entry === undefined) delete process.env.SOTTO_E2E_MAIN_ENTRY
    else process.env.SOTTO_E2E_MAIN_ENTRY = before.entry
    if (before.gate === undefined) delete process.env.SOTTO_WATCHER_ENABLED
    else process.env.SOTTO_WATCHER_ENABLED = before.gate
    if (before.features === undefined) delete process.env.SOTTO_OWL_FEATURES
    else process.env.SOTTO_OWL_FEATURES = before.features
    if (entry) await removeEntry(entry)
  }
}

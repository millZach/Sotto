import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { OwlFeatureId } from '../../../src/shared/owlFeatures'
import type { ReleaseTrack } from '../../../src/shared/releaseTrack'

export const OWL_E2E_VERSION = '0.1.37-owl.20261012.1'

async function removeEntry(entry: string): Promise<void> {
  const target = resolve(entry)
  if (dirname(target) !== resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()), 'sotto-owl-entry-'))) throw new Error('Unexpected Owl fixture folder')
  await rm(target, { recursive: true, force: true })
}

export interface ReleaseTrackOptions {
  /**
   * Features this run holds, as a build whose version still holds them would. Every feature is sent to stable since
   * November 17, 2026 (ADR-0072), so a journey that proves a gate holds names the feature here.
   */
  readonly held?: readonly OwlFeatureId[]
}

/** Exercise Electron's real version-derived track without changing the repository manifests. */
export async function onReleaseTrack(track: ReleaseTrack, run: () => Promise<void>, options: ReleaseTrackOptions = {}): Promise<void> {
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
    if (options.held?.length) process.env.SOTTO_OWL_FEATURES = options.held.map(id => `${id}=0`).join(',')
    await run()
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (entry) await removeEntry(entry)
  }
}

/** A stable build whose version still holds these features: how a journey proves a gate holds now that none is held. */
export function onBuildHolding(held: readonly OwlFeatureId[], run: () => Promise<void>): Promise<void> {
  return onReleaseTrack('stable', run, { held })
}

// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { owlProfileRoundTrip } from '../../fixtures/owlProfileRoundTrip'

it('keeps a complete Owl profile through stable real load/save and reopening Owl', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-owl-round-trip-'))
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('sotto-owl-round-trip-')) throw new Error('Unexpected round-trip profile')
  try {
    const result = await owlProfileRoundTrip(profile)
    expect(result.preserved).toEqual({ watcher: true, agents: true, threadKindsAndTitles: true, settings: true, messages: true, credential: true })
    expect(result.stable.settings).toMatchObject({ hotkey: 'Control+Alt+O', autoPaste: false })
    expect(result.stable.loaded.threads).not.toEqual(result.owl.loaded.threads)
    expect(result.reopenedOwl.loaded.threads).toEqual(result.owl.loaded.threads)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

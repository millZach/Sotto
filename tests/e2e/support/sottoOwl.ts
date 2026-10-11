import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Page } from '@playwright/test'

import type { ReleaseTrack } from '../../../src/shared/releaseTrack'

/** The Owl version an e2e run gives the built app: next stable patch, an October 10 daily build. */
export const OWL_VERSION = '0.1.35-owl.20261010.1'

/**
 * Electron takes an app's version from the package.json in the folder it starts, which is all packaging changes
 * for Owl; this folder points that manifest at the same built main entry with an Owl version. Its name keeps any
 * default path Electron derives from it away from Sotto's own data folder; the run's profile is the owned one.
 */
async function owlEntry(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-owl-entry-'))
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: 'sotto-owl-branding-e2e', version: OWL_VERSION, main: resolve('out/main/index.js'),
  }, null, 2)}\n`, 'utf8')
  return directory
}

/**
 * Stills the Owl night sky's twinkle, so a capture of an Owl window repeats exactly: every star at its own strength,
 * the picture reduced motion shows. The twinkle runs on the compositor, which does not repaint a paused animation
 * moved to another time, so it is switched off, a style change the screen follows. Stable has no sky to still.
 */
export async function holdOwlSky(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const star of document.querySelectorAll<HTMLElement>('.thread-nav__star')) star.style.animation = 'none'
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Lets the twinkle start again from the stylesheet, as it does when the sky first appears. */
export async function releaseOwlSky(page: Page): Promise<void> {
  await page.evaluate(() => { for (const star of document.querySelectorAll<HTMLElement>('.thread-nav__star')) star.style.removeProperty('animation') })
}

/** Runs `run` with every launch inside it starting the built app on `track`: as built for stable, from an Owl entry for Owl. */
export async function onTrack(track: ReleaseTrack, run: () => Promise<void>): Promise<void> {
  if (track === 'stable') { await run(); return }
  const previous = process.env.SOTTO_E2E_MAIN_ENTRY
  const entry = await owlEntry()
  process.env.SOTTO_E2E_MAIN_ENTRY = entry
  try { await run() } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_MAIN_ENTRY
    else process.env.SOTTO_E2E_MAIN_ENTRY = previous
    await rm(entry, { recursive: true, force: true })
  }
}

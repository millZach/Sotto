// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Windows tells Chromium when the Sotto window is covered, so a covered window stops drawing (#993, ADR-0020's November 1,
 * 2026 amendment). Nothing in the app turns that detection off again. Only the benchmark that measures it does, in
 * scripts/, for its "off" side. CI cannot measure occlusion itself: its desktop journeys launch through Playwright, which
 * keeps a covered window drawing whatever the switches say.
 */
describe('Windows occlusion detection', () => {
  it('is never turned off by the app', async () => {
    const found: string[] = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && (await readFile(path, 'utf8')).includes('CalculateNativeWinOcclusion')) found.push(path)
      }
    }
    await walk('src')
    expect(found).toEqual([])
  })
})

// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { restoreSpawnHelperMode } from '../../../scripts/node-pty-spawn-helper.mjs'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function nodePty(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-node-pty-'))
  roots.push(root)
  for (const folder of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    await mkdir(join(root, 'prebuilds', folder), { recursive: true })
    await writeFile(join(root, 'prebuilds', folder, 'spawn-helper'), '')
    await chmod(join(root, 'prebuilds', folder, 'spawn-helper'), 0o644)
  }
  return root
}

describe("node-pty's spawn-helper", () => {
  it('does nothing off macOS', async () => {
    expect(await restoreSpawnHelperMode(await nodePty(), 'win32')).toEqual([])
    expect(await restoreSpawnHelperMode(await nodePty(), 'linux')).toEqual([])
  })

  it('does nothing when node-pty has no prebuilds', async () => {
    expect(await restoreSpawnHelperMode(join(tmpdir(), 'sotto-no-such-node-pty'), 'darwin')).toEqual([])
  })

  // Windows has no execute bit to set or read back.
  describe("POSIX execute bits; Windows cannot validate executable permissions", () => {
    it.skipIf(process.platform === 'win32')('makes the macOS helpers executable once and leaves other platforms alone', async () => {
      const root = await nodePty()
      const helper = (folder: string): string => join(root, 'prebuilds', folder, 'spawn-helper')
      expect(await restoreSpawnHelperMode(root, 'darwin')).toEqual([helper('darwin-arm64'), helper('darwin-x64')])
      expect((await stat(helper('darwin-arm64'))).mode & 0o777).toBe(0o755)
      expect((await stat(helper('win32-x64'))).mode & 0o777).toBe(0o644)
      expect(await restoreSpawnHelperMode(root, 'darwin')).toEqual([])
    })
  })
})

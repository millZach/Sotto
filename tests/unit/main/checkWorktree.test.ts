// #1312, third part: what the check worktree knows of its packages, and the words a model reads while they install.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkInstallFailedWords, checkInstallWords, installNeeded, recordInstalled } from '../../../src/main/agents/checkWorktree'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function project(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-check-worktree-'))
  folders.push(folder)
  return folder
}

it('installs first only when package-lock.json differs from the one node_modules was installed from (#1312)', async () => {
  const folder = await project()
  // No lockfile: nothing to install.
  expect(await installNeeded(folder)).toBeUndefined()
  await writeFile(join(folder, 'package-lock.json'), '{ "lockfileVersion": 3 }\n')
  const needed = await installNeeded(folder)
  expect(needed?.hash).toMatch(/^[0-9a-f]{64}$/u)
  await mkdir(join(folder, 'node_modules'))
  await recordInstalled(folder, needed!.hash)
  expect(await installNeeded(folder)).toBeUndefined()
  await writeFile(join(folder, 'package-lock.json'), '{ "lockfileVersion": 3, "changed": true }\n')
  expect(await installNeeded(folder)).toBeDefined()
  // The record lives in node_modules, so a node_modules that is removed installs again.
  await writeFile(join(folder, 'package-lock.json'), '{ "lockfileVersion": 3 }\n')
  expect(await installNeeded(folder)).toBeUndefined()
  await rm(join(folder, 'node_modules'), { recursive: true })
  expect(await installNeeded(folder)).toBeDefined()
})

it('says what installing first means in Zach’s words, naming the machine as the queue does (#1312)', () => {
  expect(checkInstallWords('forge')).toBe('Installing packages first, because package-lock.json changed since the last check on forge. The checks start when that finishes.')
  expect(checkInstallFailedWords('forge')).toMatch(/^Installing packages failed on forge, so the check started without them\./u)
})

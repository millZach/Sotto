// #1312, third part: what the check worktree knows of its packages, and the words a model reads while they install.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CHECK_INSTALLED_FROM, checkInstallFailedWords, checkInstallWords, installNeeded, preparePackages, recordInstalled } from '../../../src/main/agents/checkWorktree'

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

it('removes the installed-from record before an install changes node_modules, so one that stops partway installs again next time (#1312)', async () => {
  const folder = await project()
  const lockA = '{ "lockfileVersion": 3, "a": true }\n', lockB = '{ "lockfileVersion": 3, "b": true }\n'
  const installs: string[] = []
  // An install that writes node_modules and succeeds, or one that writes part of it and fails, keeping what it found.
  const install = (succeeds: boolean) => async (projectFolder: string) => {
    installs.push(projectFolder)
    await mkdir(join(projectFolder, 'node_modules'), { recursive: true })
    await writeFile(join(projectFolder, 'node_modules', 'partial.txt'), 'part\n')
    return succeeds ? 'installed' as const : 'failed' as const
  }
  await writeFile(join(folder, 'package-lock.json'), lockA)
  expect(await preparePackages(folder, install(true), () => undefined)).toBe('installed')
  await writeFile(join(folder, 'package-lock.json'), lockB)
  expect(await preparePackages(folder, install(false), () => undefined)).toBe('failed')
  // Back to A: node_modules holds the half-finished install, so A installs again rather than trust its old record.
  await writeFile(join(folder, 'package-lock.json'), lockA)
  expect(await installNeeded(folder)).toBeDefined()
  expect(await preparePackages(folder, install(true), () => undefined)).toBe('installed')
  expect(installs).toHaveLength(3)
  expect(await installNeeded(folder)).toBeUndefined()
})

it('installs nothing and counts it failed when the installed-from record cannot be removed (#1312)', async () => {
  const folder = await project()
  await writeFile(join(folder, 'package-lock.json'), '{ "lockfileVersion": 3 }\n')
  // A folder where the record goes cannot be removed as a file is.
  await mkdir(join(folder, 'node_modules', CHECK_INSTALLED_FROM), { recursive: true })
  let installed = false
  expect(await preparePackages(folder, async () => { installed = true; return 'installed' }, () => undefined)).toBe('failed')
  expect(installed).toBe(false)
})

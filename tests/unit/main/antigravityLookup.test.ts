// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { findAntigravityExecutable, withAntigravityBinaryPath } from '../../../src/main/agents/antigravityLookup'
import { locateClient } from '../../../src/main/agents/providerClients'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** A program file by this name in a folder of its own, as a binary path in Settings would name it. */
async function program(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-antigravity-lookup-')); roots.push(root)
  const path = join(root, name)
  await writeFile(path, 'not a script\n'); await chmod(path, 0o755)
  return path
}
const nowhere = { PATH: '', Path: '' }

it('refuses a batch file for agy, since agy is started without a shell and Windows runs one only through a shell', async () => {
  expect(await findAntigravityExecutable(nowhere, { binaryPath: await program('agy.cmd') })).toBeUndefined()
  expect(await findAntigravityExecutable(nowhere, { binaryPath: await program('antigravity.bat') })).toBeUndefined()
  const agy = await program('agy')
  expect(await findAntigravityExecutable(nowhere, { binaryPath: agy })).toBe(agy)
})

it('names the agy Settings points at in the update card, as threads start it (ADR-0211)', async () => {
  const agy = await program('agy')
  expect(await locateClient('antigravity', { antigravityBinaryPath: agy })).toBe(agy)
})

it('counts Antigravity installed when only Settings’ binary path names its agy', async () => {
  const agy = await program('agy')
  expect(await withAntigravityBinaryPath(['codex'], agy, nowhere)).toEqual(['codex', 'antigravity'])
  expect(await withAntigravityBinaryPath(['codex'], await program('node'), nowhere)).toEqual(['codex'])
  expect(await withAntigravityBinaryPath(['codex'], '', nowhere)).toEqual(['codex'])
})

// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import prepare from '../../../scripts/prepare-native-dependencies.mjs'

const roots = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto native package '))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'node-pty': '1.1.0', zod: '4.4.3' } }))
  const native = join(root, 'node_modules/node-pty')
  await mkdir(native, { recursive: true })
  await writeFile(join(native, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  return { root, native, context: { appDir: root, platform: { nodeName: 'win32' }, arch: 'x64' } }
}
it('uses the pinned complete Windows prebuild set even when the project path contains spaces', async () => {
  const f = await fixture()
  for (const file of ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
    const path = join(f.native, 'prebuilds/win32-x64', file)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, '')
  }
  expect(await prepare(f.context)).toBe(false)
})
it('fails before packaging if a pinned Windows native helper is missing', async () => {
  const f = await fixture()
  await expect(prepare(f.context)).rejects.toThrow(/prebuild|helper/i)
})
it('keeps ordinary rebuilds for other platforms and a changed dependency graph', async () => {
  expect(await prepare({ platform: { nodeName: 'darwin' }, arch: 'arm64' })).toBe(true)
  const f = await fixture()
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ dependencies: { 'node-pty': '1.1.0', zod: '4.4.3', 'another-native-module': '1' } }))
  expect(await prepare(f.context)).toBe(true)
})

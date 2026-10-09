// Dry fixtures only: mise exec node@24.21.0 -- node scripts/verify-omarchy-shell-sandbox.mjs
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertPlainTree, copyRegularTree, prepareSandboxHome, removePlainTree, snapshotTree } from './omarchy-shell-sandbox.mjs'

const root = mkdtempSync(join(tmpdir(), 'sotto-shell-sandbox-fixture-'))
const originalHome = process.env.HOME
try {
  const fakeHome = join(root, 'fake-live-home'), target = join(root, 'dotfiles/omarchy'), stock = join(root, 'stock')
  mkdirSync(join(fakeHome, '.config'), { recursive: true })
  mkdirSync(join(target, 'plugins/private-plugin'), { recursive: true })
  writeFileSync(join(target, 'plugins/private-plugin/keep'), 'Do not change this plugin.\n')
  writeFileSync(join(target, 'shell.json'), '{"version":1,"private":"untouched"}\n')
  symlinkSync(target, join(fakeHome, '.config/omarchy'), 'dir')
  process.env.HOME = fakeHome
  mkdirSync(join(stock, 'config/omarchy'), { recursive: true })
  mkdirSync(join(stock, 'config/foot'), { recursive: true })
  writeFileSync(join(stock, 'config/omarchy/shell.json'), '{"version":1,"bar":{"layout":{}},"plugins":[]}\n')
  writeFileSync(join(stock, 'config/foot/foot.ini'), '[main]\n')
  const before = snapshotTree(target)
  const sandbox = join(root, 'sandbox-home')
  prepareSandboxHome(sandbox, stock)
  assertPlainTree(sandbox)
  assert.equal(readFileSync(join(sandbox, '.config/omarchy/shell.json'), 'utf8'), readFileSync(join(stock, 'config/omarchy/shell.json'), 'utf8'))
  assert.throws(() => copyRegularTree(join(fakeHome, '.config/omarchy'), join(root, 'rejected-copy')), /Refusing linked/u)
  assert.throws(() => removePlainTree(join(fakeHome, '.config/omarchy/plugins')), /Refusing linked/u)
  const linkedDestination = join(root, 'linked-sandbox')
  symlinkSync(target, linkedDestination, 'dir')
  assert.throws(() => prepareSandboxHome(linkedDestination, stock), /Refusing linked/u)
  const linkedSource = join(stock, 'config/foot/linked-file')
  symlinkSync(join(target, 'shell.json'), linkedSource)
  assert.throws(() => copyRegularTree(join(stock, 'config/foot'), join(root, 'rejected-nested-copy')), /Refusing linked/u)
  assert.deepEqual(snapshotTree(target), before)
  console.log('PASS: linked fake live config stays byte-for-byte unchanged; linked sources, destinations and mutations refused')
} finally {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
}

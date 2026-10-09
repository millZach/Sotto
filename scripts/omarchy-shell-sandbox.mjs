// Shared filesystem setup for the two nested Omarchy proofs. Never reads live config.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function statOrMissing(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// Check ancestors too: lstat of a child alone can already have traversed a link.
export function assertPlainPath(path) {
  const absolute = resolve(path)
  const ancestors = []
  for (let part = absolute; ; part = dirname(part)) {
    ancestors.unshift(part)
    if (part === dirname(part)) break
  }
  for (const part of ancestors) {
    const stat = statOrMissing(part)
    if (!stat) break
    assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), `Refusing linked or special sandbox path: ${part}`)
    assert.ok(!stat.isFile() || stat.nlink === 1, `Refusing hard-linked sandbox file: ${part}`)
    if (part !== absolute) assert.ok(stat.isDirectory(), `Expected sandbox folder: ${part}`)
  }
}

export function assertPlainTree(path) {
  assertPlainPath(path)
  const stat = statOrMissing(path)
  if (stat?.isDirectory()) for (const name of readdirSync(path)) assertPlainTree(join(path, name))
}

// Preflight the entire source before creating anything, then check each path again
// immediately before a copy. No link is copied, followed, or written through.
export function copyRegularTree(source, destination) {
  assertPlainTree(source)
  assertPlainTree(destination)
  const copy = (from, to) => {
    assertPlainPath(from)
    assertPlainPath(to)
    if (lstatSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name))
    } else {
      const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = fstatSync(fd)
        assert.ok(stat.isFile() && stat.nlink === 1, `Expected a regular source file: ${from}`)
        writeFileSync(to, readFileSync(fd), { flag: 'wx', mode: stat.mode & 0o777 })
      } finally { closeSync(fd) }
    }
  }
  copy(source, destination)
}

export function removePlainTree(path) {
  assertPlainTree(path)
  rmSync(path, { recursive: true, force: true })
}

export function prepareSandboxHome(home, omarchyPath) {
  assertPlainTree(home)
  for (const folder of ['.config/omarchy/plugins', '.local/state/omarchy/current', '.local/share', '.cache']) {
    const path = join(home, folder)
    assertPlainPath(path)
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  // Installed defaults only. A linked ~/.config/omarchy (or foot) is never read.
  copyRegularTree(join(omarchyPath, 'config/omarchy/shell.json'), join(home, '.config/omarchy/shell.json'))
  copyRegularTree(join(omarchyPath, 'config/foot'), join(home, '.config/foot'))
}

const excludedPlugins = ['omarchy.polkit', 'omarchy.lock', 'omarchy.idle', 'omarchy.nightlight', 'omarchy.weather', 'omarchy.system-update', 'omarchy.clipboard', 'omarchy.battery']

function readShellConfig(path) {
  assertPlainTree(path)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(config && !Array.isArray(config) && config.version === 1, 'Sandbox shell.json must carry version: 1')
  return config
}

function validateConfigFile(path) {
  const config = readShellConfig(path)
  assert.ok(Array.isArray(config.disabledPlugins), 'Sandbox shell.json needs disabledPlugins')
  for (const id of excludedPlugins) assert.ok(config.disabledPlugins.includes(id), `Sandbox shell.json must disable ${id}`)
  return config
}

export function validateSandboxConfig(home) {
  assertPlainTree(join(home, '.config/omarchy'))
  return validateConfigFile(join(home, '.config/omarchy/shell.json'))
}

export function rewriteSandboxConfig(home) {
  const path = join(home, '.config/omarchy/shell.json'), temporary = `${path}.sandbox-tmp`
  assertPlainTree(join(home, '.config/omarchy'))
  const config = readShellConfig(path)
  assert.ok(config.disabledPlugins === undefined || Array.isArray(config.disabledPlugins), 'Invalid disabledPlugins in sandbox shell.json')
  config.disabledPlugins = [...new Set([...(config.disabledPlugins || []), ...excludedPlugins])].sort()
  let created = false
  try {
    assertPlainPath(temporary)
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    created = true
    validateConfigFile(temporary)
    assertPlainTree(join(home, '.config/omarchy'))
    renameSync(temporary, path)
    created = false
    return validateSandboxConfig(home)
  } finally { if (created) removePlainTree(temporary) }
}

// A preservation check, not a copy: record links without walking their targets.
export function snapshotTree(root) {
  const entries = []
  const visit = path => {
    const stat = statOrMissing(path)
    if (!stat) return
    const content = stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : stat.isSymbolicLink() ? readlinkSync(path) : null
    entries.push([path, stat.dev, stat.ino, stat.size, stat.mtimeMs, content])
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  visit(root)
  return entries
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'setup' && args.length === 2) prepareSandboxHome(...args)
  else if (action === 'check' && args.length) args.forEach(assertPlainTree)
  else if (action === 'copy' && args.length === 2) copyRegularTree(...args)
  else if (action === 'remove' && args.length === 1) removePlainTree(args[0])
  else if (action === 'stamp' && args.length) console.log(JSON.stringify(args.map(snapshotTree)))
  else if (action === 'configure' && args.length === 1) rewriteSandboxConfig(args[0])
  else if (action === 'validate' && args.length === 1) validateSandboxConfig(args[0])
  else throw new Error('Expected setup, check, copy, remove, stamp, configure or validate with sandbox paths')
}

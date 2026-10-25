import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, mkdir, rename, open, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { t } from '@lingui/core/macro'

/** Refuse links and special files before writing a user's configuration. */
export async function plainPath(path: string): Promise<void> {
  const ancestors: string[] = []
  for (let part = resolve(path); ; part = dirname(part)) {
    ancestors.unshift(part)
    if (part === dirname(part)) break
  }
  for (const part of ancestors) {
    const stat = await lstat(part).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) break
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error(t`Sotto found a linked or special configuration file. It was left alone. Use a regular file, then try again.`)
    }
  }
}

export async function contents(path: string): Promise<string | null> {
  await plainPath(path)
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Compare the complete plugin, including extra files; the test-only declaration never ships. */
export async function treeDigest(path: string): Promise<string | null> {
  await plainPath(path)
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stat) return null
  if (!stat.isDirectory()) throw new Error(t`The plugin folder is not a folder. Sotto left it alone.`)
  const entries: string[] = []
  const visit = async (folder: string, relative: string): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      if (name.endsWith('.d.mts')) continue
      const child = join(folder, name), key = `${relative}${name}`
      await plainPath(child)
      const stat = await lstat(child)
      if (stat.isDirectory()) await visit(child, `${key}/`)
      else entries.push(`${key}\0${digest(await readFile(child, 'utf8'))}`)
    }
  }
  await visit(path, '')
  return digest(entries.join('\n'))
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return // Directory handles cannot be synced on Windows; setup runs only on Linux.
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function syncedWrite(path: string, value: string, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode)
  try { await handle.writeFile(value); await handle.chmod(mode); await handle.sync() }
  finally { await handle.close() }
}
/** A backup keeps its original name and permissions, and exists durably before it is recorded. */
export async function exclusiveWrite(path: string, value: string, mode: number): Promise<void> {
  await plainPath(path)
  await mkdir(dirname(path), { recursive: true })
  await syncedWrite(path, value, mode)
  await syncDirectory(dirname(path))
}
export async function atomicWrite(path: string, value: string, mode?: number): Promise<void> {
  await plainPath(path)
  await mkdir(dirname(path), { recursive: true })
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  const permissions = mode ?? (previous ? previous.mode & 0o777 : 0o644)
  const temporary = `${path}.sotto-${process.pid}-${Date.now()}`
  try {
    await syncedWrite(temporary, value, permissions)
    await plainPath(path)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await rm(temporary, { force: true }) }
}

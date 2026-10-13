import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

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
      throw new Error('Sotto found a linked or special configuration file. It was left alone. Use a regular file, then try again.')
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
  if (!stat.isDirectory()) throw new Error('The plugin folder is not a folder. Sotto left it alone.')
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

export async function atomicWrite(path: string, value: string, mode = 0o644): Promise<void> {
  await plainPath(path)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.sotto-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, value, { flag: 'wx', mode })
    await plainPath(path)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

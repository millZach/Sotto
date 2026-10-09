import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

async function inventory(root, prefix = '') {
  const result = {}
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name
    const fullPath = join(root, path)
    const info = await lstat(fullPath)
    if (info.isDirectory()) {
      result[path] = { directory: true }
      Object.assign(result, await inventory(root, path))
    } else if (info.isSymbolicLink()) {
      result[path] = { link: await readlink(fullPath) }
    } else if (info.isFile()) {
      result[path] = {
        bytes: info.size,
        executable: (info.mode & 0o111) !== 0,
        sha256: createHash('sha256').update(await readFile(fullPath)).digest('hex'),
      }
    } else throw new Error(`tarball contains an unsupported file: ${path}`)
  }
  return result
}

/** Compare the complete shipped closure, including resources and unpacked native helpers. */
export async function verifyLinuxArchiveContents(unpackedRoot, extractedRoot) {
  const expected = await inventory(unpackedRoot)
  const actual = await inventory(extractedRoot)
  for (const [path, entry] of Object.entries(expected)) {
    if (!(path in actual)) throw new Error(`tarball is missing ${path}`)
    if (JSON.stringify(entry) !== JSON.stringify(actual[path])) throw new Error(`tarball differs at ${path}`)
  }
  for (const path of Object.keys(actual)) {
    if (!(path in expected)) throw new Error(`tarball contains an unexpected file: ${path}`)
  }
  return { filesChecked: Object.values(expected).filter(entry => !entry.directory).length }
}

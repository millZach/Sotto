import { sep } from 'node:path'

import { extractFile, listPackage, statFile } from '@electron/asar'

// @electron/asar records entries with the separator of the host that packaged
// the archive, so a Windows build read on macOS (or the reverse) yields the
// foreign convention; every path crosses this boundary as POSIX.
export function toPosix(entryPath) {
  return entryPath.replaceAll('\\', '/').replace(/^\/+/u, '')
}

export function toNative(entryPath) {
  return toPosix(entryPath).replaceAll('/', sep)
}

export function listAsarEntries(asarPath) {
  return listPackage(asarPath).map(toPosix)
}

export function readAsarFile(asarPath, entryPath) {
  return extractFile(asarPath, toNative(entryPath))
}

export function readAsarText(asarPath, entryPath) {
  return readAsarFile(asarPath, entryPath).toString('utf8')
}

export function isAsarDirectory(asarPath, entryPath) {
  return 'files' in statFile(asarPath, toNative(entryPath), false)
}

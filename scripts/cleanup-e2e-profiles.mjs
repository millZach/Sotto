import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const temporaryRoot = await realpath(tmpdir())
const minimumAgeMinutes = Number(process.argv[2] ?? 15)
if (!Number.isFinite(minimumAgeMinutes) || minimumAgeMinutes < 1) {
  throw new Error('Cleanup age must be at least one minute.')
}
const cutoff = Date.now() - minimumAgeMinutes * 60_000
let removed = 0

for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^talktype-e2e-[A-Za-z0-9_-]+$/.test(entry.name)) continue
  const target = resolve(temporaryRoot, entry.name)
  const child = relative(temporaryRoot, target)
  if (
    !child || child.includes(sep) || child === '..' || child.startsWith(`..${sep}`) ||
    isAbsolute(child) || dirname(target).toLocaleLowerCase() !== temporaryRoot.toLocaleLowerCase() ||
    basename(target) !== entry.name
  ) throw new Error('Refusing to remove an unsafe E2E profile path.')

  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue
  await rm(target, { recursive: true, force: true })
  removed += 1
}

process.stdout.write(`Removed ${removed} stale TalkType E2E profile director${removed === 1 ? 'y' : 'ies'}.\n`)

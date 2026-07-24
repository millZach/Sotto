import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'

import {
  isOwnedE2EProfileName,
  requireOwnedE2EProfile,
} from './e2e-profile-policy.mjs'

const temporaryRoot = await realpath(tmpdir())
const minimumAgeMinutes = Number(process.argv[2] ?? 15)
if (!Number.isFinite(minimumAgeMinutes) || minimumAgeMinutes < 1) {
  throw new Error('Cleanup age must be at least one minute.')
}
const cutoff = Date.now() - minimumAgeMinutes * 60_000
let removed = 0

for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !isOwnedE2EProfileName(entry.name)) continue
  const target = requireOwnedE2EProfile(resolve(temporaryRoot, entry.name), temporaryRoot)

  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue
  await rm(target, { recursive: true, force: true })
  removed += 1
}

process.stdout.write(`Removed ${removed} stale Sotto E2E profile director${removed === 1 ? 'y' : 'ies'}.\n`)

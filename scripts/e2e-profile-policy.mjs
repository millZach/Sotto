import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const ownedProfileName = /^talktype-e2e-[A-Za-z0-9_-]+$/

export function isOwnedE2EProfileName(name) {
  return ownedProfileName.test(name)
}

export function requireOwnedE2EProfile(path, temporaryRoot = tmpdir()) {
  const absolute = resolve(path)
  const root = resolve(temporaryRoot)
  const child = relative(root, absolute)
  if (
    !child || child.includes(sep) || child === '..' || child.startsWith(`..${sep}`) ||
    isAbsolute(child) || dirname(absolute).toLocaleLowerCase() !== root.toLocaleLowerCase() ||
    !isOwnedE2EProfileName(basename(absolute))
  ) throw new Error('Refusing to remove an unsafe E2E profile path.')
  return absolute
}

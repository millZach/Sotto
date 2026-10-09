import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { requireOwnedE2EProfile } from '../../../scripts/e2e-profile-policy.mjs'
import type { AppSettings } from '../../../src/shared/settings'

export async function removeOwnedE2EProfile(directory: string): Promise<void> {
  await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true })
}

/** Keep the owner across relaunches; dispose only after every application using the profile closes. */
export async function ownedE2EProfile(options: { prefix?: string; settings?: Partial<AppSettings>;
  files?: Readonly<Record<string, string | Uint8Array>> } = {}) {
  const prefix = options.prefix ?? 'sotto-e2e-'
  // Validate before creating anything, using the same policy as stale-profile cleanup.
  requireOwnedE2EProfile(join(tmpdir(), `${prefix}check`))
  const directory = await mkdtemp(join(tmpdir(), prefix))
  const dispose = () => removeOwnedE2EProfile(directory)
  try {
    for (const [path, contents] of Object.entries(options.files ?? {})) {
      const target = resolve(directory, path)
      if (isAbsolute(path) || relative(directory, target).startsWith('..')) throw new Error('Unexpected profile file path')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    if (options.settings) await writeFile(join(directory, 'settings.json'), `${JSON.stringify(options.settings, null, 2)}\n`, 'utf8')
    return { directory, dispose }
  } catch (error) { await dispose(); throw error }
}

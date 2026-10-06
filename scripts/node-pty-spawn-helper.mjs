// node-pty's macOS prebuilds ship spawn-helper without its execute bit, so an unpackaged run fails every
// terminal with "posix_spawnp failed". This restores the bit after install. Node builtins only; nothing off macOS.
import { chmod, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import console from 'node:console'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Makes each `prebuilds/darwin-*\/spawn-helper` under the node-pty folder executable. Returns the files it changed. */
export async function restoreSpawnHelperMode(nodePtyRoot, platform = process.platform) {
  if (platform !== 'darwin') return []
  let folders
  try { folders = await readdir(join(nodePtyRoot, 'prebuilds')) } catch { return [] }
  const changed = []
  for (const folder of folders.filter(name => name.startsWith('darwin-'))) {
    const helper = join(nodePtyRoot, 'prebuilds', folder, 'spawn-helper')
    let mode
    try { mode = (await stat(helper)).mode } catch { continue }
    if ((mode & 0o111) === 0o111) continue
    await chmod(helper, mode | 0o755)
    changed.push(helper)
  }
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const changed = await restoreSpawnHelperMode(resolve(import.meta.dirname, '..', 'node_modules', 'node-pty'))
  if (changed.length > 0) console.log(`Made node-pty's spawn-helper executable (${changed.length}).`)
}

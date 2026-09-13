import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** node-pty 1.1.0 ships Node-API Windows binaries. electron/rebuild bypasses its
 * prebuild installer and attempts node-gyp, which fails in this repo's spaced path.
 * Skip only this pinned production graph; the packaged-app PTY probe verifies
 * actual Electron loading, helper resolution, output and exit before delivery.
 * Other platforms retain their normal native rebuild (including macOS helpers).
 */
export default async function prepareNativeDependencies(context) {
  if (context.platform.nodeName !== 'win32') return true
  const manifest = JSON.parse(await readFile(join(context.appDir, 'package.json'), 'utf8'))
  if (JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) !== JSON.stringify(['node-pty', 'zod']) || manifest.dependencies['node-pty'] !== '1.1.0') return true
  const native = join(context.appDir, 'node_modules/node-pty')
  const installed = JSON.parse(await readFile(join(native, 'package.json'), 'utf8'))
  if (installed.version !== '1.1.0') throw new Error('Install the pinned node-pty version before packaging.')
  for (const file of ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
    const path = join(native, `prebuilds/win32-${context.arch}`, file)
    if (!await stat(path).then(info => info.isFile(), () => false)) throw new Error(`Missing node-pty prebuild/helper ${file}. Reinstall dependencies before packaging.`)
  }
  return false
}

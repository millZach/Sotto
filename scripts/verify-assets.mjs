import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { verifyClaudeSdkAssets } from './claude-sdk-package.mjs'

const nodePtyRoot = resolve(import.meta.dirname, '../node_modules/node-pty')

export async function verifyTerminalAssets(options = {}) {
  const root = options.nodePtyRoot ?? nodePtyRoot
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.version !== '1.1.0') throw new Error('Terminal asset version drift')
  const required = platform === 'win32'
    ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe', 'pty.node', 'winpty.dll', 'winpty-agent.exe']
    : ['pty.node', 'spawn-helper']
  const directory = join(root, 'prebuilds', `${platform}-${arch}`)
  for (const file of required) {
    const info = await lstat(join(directory, file))
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Invalid terminal asset: ${file}`)
    if (platform === 'darwin' && file === 'spawn-helper' && (info.mode & 0o111) === 0) {
      throw new Error('Terminal spawn-helper is not executable')
    }
  }
  return { version: metadata.version, files: required.length }
}

export async function verifyReleaseAssets() {
  const claude = await verifyClaudeSdkAssets()
  const terminal = await verifyTerminalAssets()
  return { claude, terminal }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { claude, terminal } = await verifyReleaseAssets()
  process.stdout.write(`Verified Claude SDK ${claude.version} history helper assets and ${terminal.files} terminal assets.\n`)
}

// Builds the macOS key listener helper (ADR-0097); a no-op off macOS. Not part of `npm run build`.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

if (process.platform === 'darwin') {
  const root = resolve(import.meta.dirname, '..')
  const output = resolve(root, 'native/key-listener/build/sotto-key-listener')
  mkdirSync(resolve(output, '..'), { recursive: true })
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
    if (result.error?.code === 'ENOENT') {
      throw new Error(`${command} was not found. Install the Xcode Command Line Tools (xcode-select --install) to build the key listener.`)
    }
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`)
  }
  try {
    run('swiftc', ['-O', '-target', 'arm64-apple-macos12.0', resolve(root, 'native/key-listener/darwin.swift'), '-o', output])
    run('codesign', ['-s', '-', '-f', output])
  } catch (error) {
    process.stderr.write(`Could not build the key listener: ${error.message}\n`)
    process.exit(1)
  }
}

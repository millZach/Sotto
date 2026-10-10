// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const roots: string[] = []
export const root = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix)); roots.push(directory); return directory
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

/** Codex's package as `npm install -g` lays it out on Windows, in `scope/name`; answers the folder holding codex.exe. */
export const codexPackage = async (scope: string, name: string): Promise<string> => {
  const bin = join(scope, name, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'codex.exe'), '')
  return bin
}

/** An npm global root holding Codex. */
export const codexInstall = async (): Promise<{ scope: string; executable: string }> => {
  const scope = join(await root('sotto-npm-leftover-'), 'node_modules', '@openai')
  const bin = await codexPackage(scope, 'codex')
  await writeFile(join(scope, 'codex', 'package.json'), '{}')
  return { scope, executable: join(bin, 'codex.exe') }
}

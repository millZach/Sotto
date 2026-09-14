import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const CLAUDE_SDK_VERSION = '0.3.270'
export const CLAUDE_SDK_FILES = Object.freeze(['LICENSE.md', 'README.md', 'package.json', 'sdk.mjs'])
const sourceRoot = resolve(import.meta.dirname, '../node_modules/@anthropic-ai/claude-agent-sdk')

/** The history helper imports this exact self-contained upstream file outside ASAR. */
export async function verifyClaudeSdkAssets(packagedRoot) {
  const metadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  if (metadata.version !== CLAUDE_SDK_VERSION) throw new Error('Claude SDK history helper version drift')
  if (packagedRoot) {
    const entries = (await readdir(packagedRoot)).sort()
    if (JSON.stringify(entries) !== JSON.stringify(CLAUDE_SDK_FILES)) throw new Error('Unexpected packaged Claude SDK files')
  }
  for (const file of CLAUDE_SDK_FILES) {
    const source = await readFile(join(sourceRoot, file))
    if (packagedRoot) {
      const path = join(packagedRoot, file)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe packaged Claude SDK file')
      const packaged = await readFile(path)
      const digest = bytes => createHash('sha256').update(bytes).digest('hex')
      if (digest(source) !== digest(packaged)) throw new Error(`Packaged Claude SDK differs from pinned source: ${file}`)
    }
  }
  return { version: CLAUDE_SDK_VERSION, files: CLAUDE_SDK_FILES.length }
}

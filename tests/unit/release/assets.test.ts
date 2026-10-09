// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyReleaseAssets, verifyTerminalAssets } from '../../../scripts/verify-assets.mjs'

const roots: string[] = []
const files = ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe', 'pty.node', 'winpty.dll', 'winpty-agent.exe']

async function fixture() {
  const nodePtyRoot = await mkdtemp(join(tmpdir(), 'sotto-terminal-assets-'))
  roots.push(nodePtyRoot)
  await writeFile(join(nodePtyRoot, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  for (const file of files) {
    const path = join(nodePtyRoot, 'prebuilds', 'win32-x64', file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'asset')
  }
  return { nodePtyRoot, platform: 'win32', arch: 'x64' }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('release assets', () => {
  it('keeps Claude history and terminal assets verifiable without voice assets', async () => {
    await expect(verifyReleaseAssets()).resolves.toMatchObject({
      claude: { version: '0.3.270', files: 4 },
      terminal: { version: '1.1.0' },
    })
  })

  it('requires both terminal backends and their native helpers', async () => {
    const options = await fixture()
    await expect(verifyTerminalAssets(options)).resolves.toEqual({ version: '1.1.0', files: 7 })
    await rm(join(options.nodePtyRoot, 'prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe'))
    await expect(verifyTerminalAssets(options)).rejects.toThrow()
  })

  it('rejects an empty native binary', async () => {
    const options = await fixture()
    await writeFile(join(options.nodePtyRoot, 'prebuilds', 'win32-x64', 'pty.node'), '')
    await expect(verifyTerminalAssets(options)).rejects.toThrow('Invalid terminal asset: pty.node')
  })

  it('rejects terminal version drift', async () => {
    const options = await fixture()
    await writeFile(join(options.nodePtyRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    await expect(verifyTerminalAssets(options)).rejects.toThrow('Terminal asset version drift')
  })
})

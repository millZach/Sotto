// @vitest-environment node
import { spawn } from 'node:child_process'
import { copyFile, readdir } from 'node:fs/promises'

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { clearLeftoverPackage } from '../../src/main/agents/providerClients'

import { codexPackage, codexInstall } from '../fixtures/providerClientInstallFixture'

describe("what an earlier update left behind", () => {

  it.runIf(process.platform === 'win32')('moves a leftover whose program still runs out of npm\u2019s way, and deletes it once it stops', async () => {
    const { scope } = await codexInstall()
    // An older Codex still running from the folder npm moved it to: the update after that one stopped on EBUSY.
    const bin = await codexPackage(scope, '.codex-6TeUjdn8')
    const program = join(bin, 'held.exe')
    await copyFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), program)
    const running = spawn(program, ['-n', '600', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
    try {
      await new Promise<void>((resolve, reject) => { running.once('spawn', resolve); running.once('error', reject) })
      await clearLeftoverPackage(join(scope, 'codex'), () => 1759500000000)
      expect((await readdir(scope)).sort(), 'npm\u2019s name is free and the running program untouched').toEqual(['.codex-6TeUjdn8.old-1759500000000', 'codex'])
      expect(running.exitCode).toBeNull()
      await clearLeftoverPackage(join(scope, 'codex'), () => 1759500009999)
      expect((await readdir(scope)).sort(), 'a moved folder stays put while its program runs').toEqual(['.codex-6TeUjdn8.old-1759500000000', 'codex'])
    } finally {
      running.kill()
      await new Promise(resolve => running.exitCode === null ? running.once('exit', resolve) : resolve(undefined))
    }
    await clearLeftoverPackage(join(scope, 'codex'))
    expect(await readdir(scope)).toEqual(['codex'])
  })
})

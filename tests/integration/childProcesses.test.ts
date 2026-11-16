// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it } from 'vitest'
import { hermesBackgroundCommand } from '../../src/main/agents/backgroundCommandWatch'
import { childProcesses } from '../../src/main/agents/detachedRunScan'

// #2637: the real process table, on whatever system runs it, finds a child carrying a Hermes session mark, with its
// command, as a child of the process that started it, and no longer once it has ended.
it('lists the children a process started, with their commands and marks, and not once they end', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-child-commands-'))
  const script = join(folder, 'stand-in.mjs')
  await writeFile(script, 'setTimeout(() => {}, 60_000)\n')
  const child = spawn(process.execPath, [script, 'render'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, HERMES_SESSION_KEY: 'acp-session-1' } })
  try {
    await new Promise<void>(resolve => child.once('spawn', () => resolve()))
    const found = (await childProcesses(process.pid)).find(row => row.pid === child.pid)
    expect(found?.marks).toContainEqual({ name: 'HERMES_SESSION_KEY', value: 'acp-session-1' })
    // Not in Hermes's own form, so it is named by its program alone, never its arguments.
    expect(found && hermesBackgroundCommand('acp-session-1')(found)).toBe(basename(process.execPath).replace(/\.exe$/iu, ''))
    child.kill()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    expect((await childProcesses(process.pid)).some(row => row.pid === child.pid)).toBe(false)
  } finally { child.kill(); await rm(folder, { recursive: true, force: true }) }
}, 120_000)

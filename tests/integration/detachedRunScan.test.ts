// @vitest-environment node
/**
 * The detached-run scan against this computer's real process table (#2476): Linux's /proc, macOS's ps and lsof, and on
 * Windows the process list and the environment reader PowerShell compiles. A stand-in client, a script named `claude`
 * that Node runs, starts with a session's mark in its environment, and the scan must find it, its mark and its folder,
 * and know it runs under this test's own process.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { descendsFrom, scanProcesses } from '../../src/main/agents/detachedRunScan'
import { endRun } from '../../src/main/agents/detachedRuns'

const SESSION = '0d15c982-fe12-44e4-8834-23b3be4bd2eb'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('finds a marked agent client with its folder, and knows it runs under this process', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'sotto-detached-scan-')))
  const script = join(folder, 'claude.mjs')
  await writeFile(script, 'setInterval(() => {}, 1000)\n')
  const child: ChildProcess = spawn(process.execPath, [script, '--name', 'scan-stand-in', '--model', 'claude-test'], {
    cwd: folder, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, ANTHROPIC_API_KEY: 'sk-not-read' },
  })
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await rm(folder, { recursive: true, force: true }) })
  const pid = child.pid!
  await new Promise(done => setTimeout(done, 500))

  const table = await scanProcesses(found => found.pid === pid)
  const found = table.agents.find(item => item.pid === pid)
  expect(found, 'the stand-in is listed').toBeDefined()
  expect(found!.client).toBe('Claude Code')
  expect(found!.marks).toEqual([{ name: 'CLAUDE_CODE_SESSION_ID', value: SESSION }])
  expect(JSON.stringify(table.agents)).not.toContain('sk-not-read')
  expect(found!.argv).toContain('scan-stand-in')
  if (found!.folder !== undefined) expect(found!.folder.toLowerCase()).toBe(folder.toLowerCase())
  else expect(process.platform, 'only macOS without lsof may not say').toBe('darwin')
  expect(descendsFrom(table.processes, pid, process.pid)).toBe(true)

  expect(await endRun(pid)).toBe(true)
  const after = await scanProcesses(item => item.pid === pid)
  expect(after.agents.find(item => item.pid === pid)).toBeUndefined()
}, 120_000)

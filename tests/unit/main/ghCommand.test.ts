// @vitest-environment node
// November 10, 2026 (#2430): forge's headless host runs with PATH /usr/local/bin:/usr/bin:/bin and gh in ~/.local/bin,
// so every pull request read it made failed, its threads linked no pull requests, and Watcher heard nothing of them.
// Sotto now finds gh the way the CLI lookup finds a provider's client (ADR-0036).
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resetCliLookup } from '../../../src/main/agents/cliLookup'
import { resetGhLookup } from '../../../src/main/agents/git/ghCommand'
import { runGitStatusCommand } from '../../../src/main/agents/git/gitStatus'

const kept = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL }
let root: string | undefined
afterEach(async () => {
  for (const [key, value] of Object.entries(kept)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  resetGhLookup(); resetCliLookup()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

it.skipIf(process.platform === 'win32')('starts gh from ~/.local/bin for a host whose PATH lacks it', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-gh-lookup-')))
  const bin = join(root, 'home', '.local', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "scripted gh $*"\n')
  await chmod(join(bin, 'gh'), 0o755)
  resetGhLookup(); resetCliLookup()
  // A host started by systemd or a non-interactive SSH shell, with a login shell that adds nothing.
  Object.assign(process.env, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'), SHELL: '/bin/false' })
  expect(await runGitStatusCommand(root, 'gh', ['auth', 'status'])).toBe('scripted gh auth status\n')
})
